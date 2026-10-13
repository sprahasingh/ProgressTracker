-- Track the active credit for a source award. Restoring a corrected source
-- creates a new event, so append-only history stays explainable and retries
-- cannot farm XP by toggling a check-in repeatedly.
begin;

create table public.progression_award_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  award_key uuid not null,
  reason_code text not null check (reason_code in ('DAILY_CHECK_IN_COMPLETED','PERFECT_DAY_BONUS','STREAK_MILESTONE','GOAL_MILESTONE','GOAL_COMPLETED')),
  effective_date date not null,
  tracker_id uuid,
  goal_id uuid,
  source_id uuid,
  current_xp integer not null default 0 check (current_xp >= 0),
  current_event_id uuid,
  generation integer not null default 0 check (generation >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, award_key),
  foreign key (user_id, current_event_id) references public.progression_events(user_id, id) on delete cascade,
  check (tracker_id is null or goal_id is null),
  check ((current_xp = 0) = (current_event_id is null))
);
alter table public.progression_award_state enable row level security;
revoke all on public.progression_award_state from public, anon, authenticated, service_role;

-- Seed state for awards created by the first ledger slice. This prevents a
-- later correction from forgetting an existing credit or duplicating it.
insert into public.progression_award_state(
  user_id, award_key, reason_code, effective_date, tracker_id, source_id,
  current_xp, current_event_id, generation
)
select original.user_id, original.idempotency_key, original.reason_code, original.effective_date,
  source.tracker_id, source.source_id,
  greatest(coalesce(net.net_xp, 0), 0)::integer,
  case when coalesce(net.net_xp, 0) > 0 then original.id else null end,
  coalesce(net.reversal_count, 0)::integer
from public.progression_events original
join public.progression_event_sources source on source.user_id = original.user_id and source.event_id = original.id
cross join lateral (
  select sum(event.xp_delta) as net_xp,
    count(*) filter (where event.reason_code = 'AWARD_REVERSAL') as reversal_count
  from public.progression_events event
  join public.progression_event_sources event_source on event_source.user_id = event.user_id and event_source.event_id = event.id
  where event.user_id = original.user_id and event_source.source_id = source.source_id
    and event_source.tracker_id = source.tracker_id
) net
where original.reason_code = 'DAILY_CHECK_IN_COMPLETED'
on conflict (user_id, award_key) do nothing;

create or replace function public.anonymize_tracker_progression_sources()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.progression_event_sources
  where user_id = old.user_id and tracker_id = old.id;
  update public.progression_award_state
  set tracker_id = null, source_id = null, updated_at = clock_timestamp()
  where user_id = old.user_id and tracker_id = old.id;
  return old;
end;
$$;
revoke all on function public.anonymize_tracker_progression_sources() from public, anon, authenticated, service_role;

create or replace function public.record_progression_entry_award(
  p_user_id uuid, p_tracker_id uuid, p_entry_id uuid, p_entry_date date,
  p_values jsonb, p_outcome text, p_deleted_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers%rowtype;
  v_key uuid := md5(p_user_id::text || ':' || p_entry_id::text || ':daily-check-in-v1')::uuid;
  v_event public.progression_events%rowtype;
  v_state public.progression_award_state%rowtype;
  v_qualifies boolean := false;
  v_generation integer;
  v_event_key uuid;
  v_delta integer;
begin
  if p_user_id is null or p_tracker_id is null or p_entry_id is null or p_entry_date is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-entry:' || p_entry_id::text, 2));
  select * into v_tracker from public.trackers where user_id = p_user_id and id = p_tracker_id;
  if not found then return; end if;
  v_qualifies := p_deleted_at is null
    and public.progression_date_is_eligible(p_user_id, v_tracker, p_entry_date)
    and public.progression_entry_qualifies(v_tracker.definition, p_values, p_outcome);

  select * into v_state from public.progression_award_state
  where user_id = p_user_id and award_key = v_key for update;
  if not found then
    select * into v_event from public.progression_events
    where user_id = p_user_id and idempotency_key = v_key;
    if found then
      insert into public.progression_award_state(
        user_id, award_key, reason_code, effective_date, tracker_id, source_id,
        current_xp, current_event_id, generation
      )
      select p_user_id, v_key, 'DAILY_CHECK_IN_COMPLETED', p_entry_date, p_tracker_id, p_entry_id,
        greatest(coalesce(sum(event.xp_delta), 0), 0)::integer,
        case when coalesce(sum(event.xp_delta), 0) > 0 then v_event.id else null end,
        count(*) filter (where event.reason_code = 'AWARD_REVERSAL')::integer
      from public.progression_events event
      left join public.progression_event_sources source on source.user_id = event.user_id and source.event_id = event.id
      where event.user_id = p_user_id and (event.id = v_event.id or source.source_id = p_entry_id);
    else
      insert into public.progression_award_state(user_id, award_key, reason_code, effective_date, tracker_id, source_id)
      values (p_user_id, v_key, 'DAILY_CHECK_IN_COMPLETED', p_entry_date, p_tracker_id, p_entry_id);
    end if;
    select * into v_state from public.progression_award_state
    where user_id = p_user_id and award_key = v_key for update;
  end if;

  if v_qualifies and v_state.current_xp = 0 then
    v_generation := v_state.generation + 1;
    v_event_key := case when v_generation = 1 then v_key
      else md5('reaward:' || v_key::text || ':' || v_generation::text)::uuid end;
    insert into public.progression_events(
      user_id, event_category, reason_code, effective_date, xp_delta,
      scoring_version, idempotency_key, metadata
    ) values (
      p_user_id, 'check_in', 'DAILY_CHECK_IN_COMPLETED', p_entry_date, 10,
      2, v_event_key, jsonb_build_object('rule', '10 XP per eligible completed check-in', 'award_generation', v_generation)
    ) returning * into v_event;
    insert into public.progression_event_sources(user_id, event_id, tracker_id, source_id, display_name)
    values (p_user_id, v_event.id, p_tracker_id, p_entry_id, v_tracker.name);
    update public.progression_award_state set
      effective_date = p_entry_date, tracker_id = p_tracker_id, source_id = p_entry_id,
      current_xp = 10, current_event_id = v_event.id, generation = v_generation, updated_at = clock_timestamp()
    where user_id = p_user_id and award_key = v_key;
  elsif not v_qualifies and v_state.current_xp > 0 then
    v_delta := -v_state.current_xp;
    insert into public.progression_events(
      user_id, event_category, reason_code, effective_date, xp_delta,
      scoring_version, idempotency_key, reverses_event_id, metadata
    ) values (
      p_user_id, 'reversal', 'AWARD_REVERSAL', p_entry_date, v_delta,
      2, md5('reverse:' || v_state.current_event_id::text)::uuid, v_state.current_event_id,
      jsonb_build_object('reason', 'Source check-in no longer qualifies', 'award_generation', v_state.generation)
    ) on conflict (user_id, idempotency_key) do nothing;
    update public.progression_award_state set
      effective_date = p_entry_date, tracker_id = p_tracker_id, source_id = p_entry_id,
      current_xp = 0, current_event_id = null, generation = generation + 1, updated_at = clock_timestamp()
    where user_id = p_user_id and award_key = v_key;
  end if;
end;
$$;
revoke all on function public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz) from public, anon, authenticated, service_role;

commit;
