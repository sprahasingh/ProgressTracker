-- Fix the generate_series column reference in the legacy XP account initializer.
-- The function is copied from the original migration so fresh and upgraded databases agree.
begin;

alter table public.progression_account_state
  drop constraint if exists progression_account_state_legacy_xp_kind_check;
alter table public.progression_account_state
  add constraint progression_account_state_legacy_xp_kind_check
  check (legacy_xp_kind in ('reconstructed', 'legacy_fallback', 'unavailable'));

create or replace function public.initialize_progression_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_initialized_at timestamptz := clock_timestamp();
  v_timezone text;
  v_today date;
  v_opening_xp bigint := 0;
  v_legacy_xp_kind text := 'reconstructed';
  v_idempotency_key uuid;
begin
  if p_user_id is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('progression-init:' || p_user_id::text, 0));
  if exists(select 1 from public.progression_account_state where user_id = p_user_id) then return; end if;

  select coalesce(s.timezone, 'UTC') into v_timezone
  from public.app_settings s where s.user_id = p_user_id;
  v_timezone := coalesce(v_timezone, 'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then v_timezone := 'UTC'; end if;
  v_today := (v_initialized_at at time zone v_timezone)::date;

  -- Reconstruct the prior visible formula from retained active and archived
  -- tracker history. This is one snapshot event, not a fabricated award per
  -- historical check-in. Existing post-cutover check-in awards are subtracted
  -- before inserting the balance, so they remain represented exactly once.
  with retained_trackers as (
    select t.* from public.trackers t
    where t.user_id = p_user_id and t.deleted_at is null and t.status in ('active', 'archived')
  ), eligible_dates as (
    select t.id as tracker_id, days.activity_at::date as activity_date,
      coalesce(e.deleted_at is null and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome), false) as qualifies
    from retained_trackers t
    cross join lateral generate_series(
      greatest(coalesce((t.definition->>'startDate')::date, (t.created_at at time zone v_timezone)::date), (t.created_at at time zone v_timezone)::date)::timestamp,
      v_today::timestamp,
      interval '1 day'
    ) as days(activity_at)
    left join public.tracker_entries e on e.user_id = t.user_id and e.tracker_id = t.id and e.entry_date = days.activity_at::date
      and e.deleted_at is null
    where public.progression_date_is_eligible(p_user_id, t, days.activity_at::date)
  ), runs as (
    select tracker_id, qualifies,
      sum(case when qualifies then 0 else 1 end) over (partition by tracker_id order by activity_date) as run_group
    from eligible_dates
  ), longest_runs as (
    select tracker_id, max(qualified_days) as longest
    from (
      select tracker_id, run_group, count(*) filter (where qualifies) as qualified_days
      from runs group by tracker_id, run_group
    ) grouped
    group by tracker_id
  ), qualifying_entries as (
    select t.id as tracker_id, e.id as entry_id
    from retained_trackers t
    join public.tracker_entries e on e.user_id = t.user_id and e.tracker_id = t.id
      and e.deleted_at is null and e.entry_date <= v_today
    where public.progression_date_is_eligible(p_user_id, t, e.entry_date)
      and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome)
  ), legacy_total as (
    select
      (select count(*) * 10 from qualifying_entries)
      + (select coalesce(sum((select count(*) * 25 from unnest(array[3,7,14,30,60,100]) as thresholds(days) where longest_runs.longest >= thresholds.days)),0)
         from longest_runs) as xp
  ), retained_awards as (
    select coalesce(sum(event.xp_delta), 0) as xp
    from public.progression_events event
    join public.progression_event_sources source on source.user_id = event.user_id and source.event_id = event.id
    join qualifying_entries entry on entry.tracker_id = source.tracker_id and entry.entry_id = source.source_id
    where event.user_id = p_user_id and event.reason_code in ('DAILY_CHECK_IN_COMPLETED', 'AWARD_REVERSAL')
  )
  select greatest(0, legacy_total.xp - retained_awards.xp) into v_opening_xp
  from legacy_total cross join retained_awards;

  if v_opening_xp is null or v_opening_xp > 2147483647 then
    v_opening_xp := null;
    v_legacy_xp_kind := 'unavailable';
  end if;

  if v_opening_xp is not null then
    insert into public.progression_events(
    user_id, event_category, reason_code, effective_date, xp_delta,
    scoring_version, idempotency_key, metadata
  ) values (
    p_user_id, 'legacy_opening_balance', 'LEGACY_XP_OPENING_BALANCE', v_today,
    v_opening_xp::integer, 1, md5(p_user_id::text || ':legacy-opening-balance:v1')::uuid,
    jsonb_build_object(
      'label', 'Legacy progress · Reconstructed opening balance',
      'source', 'active and archived saved tracker history',
      'calculation_version', 'legacy-tracker-rewards-v1',
      'reconstructed_at', v_initialized_at,
      'balance_kind', v_legacy_xp_kind,
      'cutover_at', v_initialized_at,
      'notes', 'The opening amount is reconstructed from retained server history as one balance snapshot. Existing ledger check-in awards were excluded. A pre-progression server balance was not stored, so unsynchronized or previously deleted history cannot be recovered.'
    )
    ) on conflict (user_id, idempotency_key) do nothing;
  end if;

  insert into public.progression_account_state(user_id, initialized_at, scoring_version, legacy_xp_kind)
  values (p_user_id, v_initialized_at, 1, v_legacy_xp_kind)
  on conflict (user_id) do nothing;
end;
$$;
revoke all on function public.initialize_progression_account(uuid) from public, anon, authenticated, service_role;

commit;
