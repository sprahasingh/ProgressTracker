-- Reconcile post-cutover lifetime streak milestones from the same schedule,
-- holiday, strict-mode, and qualification helpers used by check-in XP.
begin;

create or replace function public.reconcile_progression_award(
  p_user_id uuid,
  p_award_key uuid,
  p_reason_code text,
  p_effective_date date,
  p_xp integer,
  p_tracker_id uuid,
  p_goal_id uuid,
  p_source_id uuid,
  p_eligible boolean,
  p_description text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.progression_award_state%rowtype;
  v_event public.progression_events%rowtype;
  v_generation integer;
  v_event_key uuid;
  v_category text;
  v_name text;
begin
  if p_user_id is null or p_award_key is null or p_effective_date is null or p_xp <= 0 then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-award:' || p_award_key::text, 3));
  insert into public.progression_award_state(user_id, award_key, reason_code, effective_date, tracker_id, goal_id, source_id)
  values(p_user_id, p_award_key, p_reason_code, p_effective_date, p_tracker_id, p_goal_id, p_source_id)
  on conflict (user_id, award_key) do nothing;
  select * into v_state from public.progression_award_state
  where user_id = p_user_id and award_key = p_award_key for update;
  if v_state.reason_code <> p_reason_code then raise exception 'progression award identity was reused'; end if;
  v_category := case p_reason_code
    when 'PERFECT_DAY_BONUS' then 'daily_bonus'
    when 'STREAK_MILESTONE' then 'streak_milestone'
    when 'GOAL_MILESTONE' then 'goal_milestone'
    when 'GOAL_COMPLETED' then 'goal_completed'
    else 'check_in' end;

  if p_eligible and v_state.current_xp = 0 then
    v_generation := v_state.generation + 1;
    v_event_key := md5('progression:' || p_award_key::text || ':' || v_generation::text)::uuid;
    insert into public.progression_events(
      user_id, event_category, reason_code, effective_date, xp_delta,
      scoring_version, idempotency_key, metadata
    ) values (
      p_user_id, v_category, p_reason_code, p_effective_date, p_xp,
      2, v_event_key, jsonb_build_object('award_generation', v_generation, 'rule', p_description)
    ) returning * into v_event;
    select name into v_name from public.trackers where user_id = p_user_id and id = p_tracker_id;
    insert into public.progression_event_sources(user_id, event_id, tracker_id, goal_id, source_id, display_name)
    values(p_user_id, v_event.id, p_tracker_id, p_goal_id, p_source_id, coalesce(v_name, 'Deleted tracker'));
    update public.progression_award_state set
      effective_date = p_effective_date, tracker_id = p_tracker_id, goal_id = p_goal_id,
      source_id = p_source_id, current_xp = p_xp, current_event_id = v_event.id,
      generation = v_generation, updated_at = clock_timestamp()
    where user_id = p_user_id and award_key = p_award_key;
  elsif not p_eligible and v_state.current_xp > 0 then
    insert into public.progression_events(
      user_id, event_category, reason_code, effective_date, xp_delta,
      scoring_version, idempotency_key, reverses_event_id, metadata
    ) values (
      p_user_id, 'reversal', 'AWARD_REVERSAL', p_effective_date, -v_state.current_xp,
      2, md5('reverse:' || v_state.current_event_id::text)::uuid, v_state.current_event_id,
      jsonb_build_object('reason', 'Historical progression source no longer qualifies', 'award_generation', v_state.generation)
    ) on conflict (user_id, idempotency_key) do nothing;
    update public.progression_award_state set
      effective_date = p_effective_date, current_xp = 0, current_event_id = null,
      generation = generation + 1, updated_at = clock_timestamp()
    where user_id = p_user_id and award_key = p_award_key;
  end if;
end;
$$;
revoke all on function public.reconcile_progression_award(uuid,uuid,text,date,integer,uuid,uuid,uuid,boolean,text) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_tracker_milestones(p_user_id uuid, p_tracker_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers%rowtype;
  v_timezone text;
  v_today date;
  v_cutover_at timestamptz;
  v_threshold integer;
  v_xp integer;
  v_crossed_date date;
  v_crossed_at timestamptz;
  v_award_key uuid;
begin
  if p_user_id is null or p_tracker_id is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-tracker:' || p_tracker_id::text, 4));
  select * into v_tracker from public.trackers where user_id = p_user_id and id = p_tracker_id;
  if not found then return; end if;
  select coalesce(s.timezone, 'UTC'), a.initialized_at
    into v_timezone, v_cutover_at
    from public.progression_account_state a
    left join public.app_settings s on s.user_id = a.user_id
    where a.user_id = p_user_id;
  v_timezone := coalesce(v_timezone, 'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then v_timezone := 'UTC'; end if;
  v_today := (clock_timestamp() at time zone v_timezone)::date;

  foreach v_threshold in array array[7,14,30,100] loop
    v_xp := case v_threshold when 7 then 35 when 14 then 50 when 30 then 100 else 200 end;
    with eligible as (
      select days.activity_at::date as activity_date,
        entry.server_changed_at as source_at,
        entry.id is not null and public.progression_entry_qualifies(v_tracker.definition, entry.entry_values, entry.outcome) as qualifies
      from lateral generate_series(
        greatest(coalesce((v_tracker.definition->>'startDate')::date, (v_tracker.created_at at time zone v_timezone)::date), (v_tracker.created_at at time zone v_timezone)::date)::timestamp,
        v_today::timestamp, interval '1 day'
      ) as days(activity_at)
      left join public.tracker_entries entry on entry.user_id = p_user_id and entry.tracker_id = p_tracker_id
        and entry.entry_date = days.activity_at::date and entry.deleted_at is null
      where public.progression_date_is_eligible(p_user_id, v_tracker, days.activity_at::date)
    ), groups as (
      select activity_date, source_at, qualifies,
        sum(case when qualifies then 0 else 1 end) over (order by activity_date) as run_group
      from eligible
    ), runs as (
      select activity_date, source_at, qualifies, run_group,
        sum(case when qualifies then 1 else 0 end) over (partition by run_group order by activity_date) as run_length
      from groups
    )
    select activity_date, source_at into v_crossed_date, v_crossed_at from runs
    where qualifies and run_length = v_threshold
    order by activity_date limit 1;

    v_award_key := md5(p_user_id::text || ':streak:' || p_tracker_id::text || ':' || v_threshold::text)::uuid;
    perform public.reconcile_progression_award(
      p_user_id, v_award_key, 'STREAK_MILESTONE', coalesce(v_crossed_date, v_today), v_xp,
      p_tracker_id, null, v_award_key,
      v_crossed_date is not null and v_crossed_at > v_cutover_at,
      v_threshold::text || '-day qualifying tracker streak'
    );
  end loop;
end;
$$;
revoke all on function public.reconcile_progression_tracker_milestones(uuid,uuid) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_entry_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.record_progression_entry_award(new.user_id,new.tracker_id,new.id,new.entry_date,new.entry_values,new.outcome,new.deleted_at);
  perform public.reconcile_progression_tracker_milestones(new.user_id,new.tracker_id);
  return new;
end;
$$;
revoke all on function public.reconcile_progression_entry_trigger() from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_tracker_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.tracker_entries%rowtype;
begin
  for v_entry in select * from public.tracker_entries where user_id = new.user_id and tracker_id = new.id loop
    perform public.record_progression_entry_award(v_entry.user_id,v_entry.tracker_id,v_entry.id,v_entry.entry_date,v_entry.entry_values,v_entry.outcome,v_entry.deleted_at);
  end loop;
  perform public.reconcile_progression_tracker_milestones(new.user_id,new.id);
  return new;
end;
$$;
revoke all on function public.reconcile_progression_tracker_trigger() from public, anon, authenticated, service_role;

comment on table public.progression_award_state is
  'Private current-credit state for append-only, correction-safe award reconciliation.';

commit;
