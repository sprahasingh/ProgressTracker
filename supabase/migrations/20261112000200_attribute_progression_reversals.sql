-- Keep tracker and goal XP attribution intact when an award is reversed.
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
    v_event_key := md5('reverse:' || v_state.current_event_id::text)::uuid;
    insert into public.progression_events(
      user_id, event_category, reason_code, effective_date, xp_delta,
      scoring_version, idempotency_key, reverses_event_id, metadata
    ) values (
      p_user_id, 'reversal', 'AWARD_REVERSAL', p_effective_date, -v_state.current_xp,
      2, v_event_key, v_state.current_event_id,
      jsonb_build_object('reason', 'Historical progression source no longer qualifies', 'award_generation', v_state.generation)
    ) on conflict (user_id, idempotency_key) do nothing;
    select * into v_event from public.progression_events where user_id = p_user_id and idempotency_key = v_event_key;
    select name into v_name from public.trackers where user_id = p_user_id and id = p_tracker_id;
    insert into public.progression_event_sources(user_id, event_id, tracker_id, goal_id, source_id, display_name)
    values(p_user_id, v_event.id, p_tracker_id, p_goal_id, p_source_id, coalesce(v_name, 'Deleted tracker'))
    on conflict (user_id, event_id) do nothing;
    update public.progression_award_state set
      effective_date = p_effective_date, current_xp = 0, current_event_id = null,
      generation = generation + 1, updated_at = clock_timestamp()
    where user_id = p_user_id and award_key = p_award_key;
  end if;
end;
$$;
revoke all on function public.reconcile_progression_award(uuid,uuid,text,date,integer,uuid,uuid,uuid,boolean,text) from public, anon, authenticated, service_role;

-- Repair historical reversals created before attribution was preserved.
insert into public.progression_event_sources(user_id, event_id, tracker_id, goal_id, source_id, display_name)
select reversal.user_id, reversal.id, source.tracker_id, source.goal_id, source.source_id, source.display_name
from public.progression_events reversal
join public.progression_events award on award.id = reversal.reverses_event_id and award.user_id = reversal.user_id
join public.progression_event_sources source on source.event_id = award.id and source.user_id = award.user_id
where reversal.reason_code = 'AWARD_REVERSAL'
on conflict (user_id, event_id) do nothing;

commit;
