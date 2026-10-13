-- Only entries represented in the opening XP estimate may suppress a same-day new award.
-- Incomplete/skipped same-day entries can still become qualifying after cutover.
begin;
create or replace function public.initialize_progression_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_initialized_at timestamptz := statement_timestamp();
  v_timezone text;
  v_today date;
  v_opening_xp bigint := 0;
  v_legacy_xp_kind text := 'reconstructed';
  v_idempotency_key uuid;
  v_has_history boolean := false;
begin
  if p_user_id is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('progression-init:' || p_user_id::text, 0));
  if exists(select 1 from public.progression_account_state where user_id = p_user_id) then return; end if;

  select coalesce(s.timezone, 'UTC') into v_timezone
  from public.app_settings s where s.user_id = p_user_id;
  v_timezone := coalesce(v_timezone, 'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then v_timezone := 'UTC'; end if;
  v_today := (v_initialized_at at time zone v_timezone)::date;
  select exists (select 1 from public.trackers t join public.tracker_entries e
    on e.user_id=t.user_id and e.tracker_id=t.id
    where t.user_id=p_user_id and t.deleted_at is null and t.status in ('active','archived')
      and e.deleted_at is null and e.server_changed_at < v_initialized_at) into v_has_history;

  -- Reconstruct the prior visible formula from retained active and archived
  -- tracker history. This is one snapshot event, not a fabricated award per
  -- historical check-in. Existing post-cutover check-in awards are subtracted
  -- before inserting the balance, so they remain represented exactly once.
  with retained_trackers as (
    select t.* from public.trackers t
    where t.user_id = p_user_id and t.deleted_at is null and t.status in ('active', 'archived')
  ), eligible_dates as materialized (
    select t.id as tracker_id, days.activity_at::date as activity_date,
      coalesce(e.deleted_at is null and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome), false) as qualifies
    from retained_trackers t
    cross join lateral generate_series(
      greatest(coalesce((t.definition->>'startDate')::date, (t.created_at at time zone v_timezone)::date), (t.created_at at time zone v_timezone)::date)::timestamp,
      v_today::timestamp, interval '1 day'
    ) as days(activity_at)
    left join public.account_holidays h on h.user_id=p_user_id and h.holiday_date=days.activity_at::date and h.deleted_at is null
    left join public.tracker_entries e on e.user_id=t.user_id and e.tracker_id=t.id and e.entry_date=days.activity_at::date
      and e.deleted_at is null and e.server_changed_at<v_initialized_at
    where (t.definition->>'deadline' is null or days.activity_at::date<=(t.definition->>'deadline')::date)
      and (coalesce((t.definition->>'strictMode')::boolean,false) or (
        h.id is null and case t.definition->'schedule'->>'kind'
          when 'every-day' then true
          when 'weekdays' then extract(dow from days.activity_at)::integer between 1 and 5
          when 'selected-weekdays' then coalesce(t.definition->'schedule'->'weekdays','[]'::jsonb) @> to_jsonb(extract(dow from days.activity_at)::integer)
          when 'every-n-days' then greatest(coalesce((t.definition->'schedule'->>'interval')::integer,0),0)>0
            and mod(days.activity_at::date-greatest(coalesce((t.definition->>'startDate')::date,(t.created_at at time zone v_timezone)::date),(t.created_at at time zone v_timezone)::date),
              greatest(coalesce((t.definition->'schedule'->>'interval')::integer,0),0))=0
          when 'times-per-week' then case
            when t.definition->'schedule' ? 'preferredWeekdays' then coalesce(t.definition->'schedule'->'preferredWeekdays','[]'::jsonb) @> to_jsonb(extract(dow from days.activity_at)::integer)
            else coalesce((t.definition->'schedule'->>'count')::integer,0)>0 and
              floor((extract(dow from days.activity_at)::integer+1)*coalesce((t.definition->'schedule'->>'count')::integer,0)/7.0)>
              floor(extract(dow from days.activity_at)::integer*coalesce((t.definition->'schedule'->>'count')::integer,0)/7.0)
            end
          when 'times-per-month' then coalesce((t.definition->'schedule'->>'count')::integer,0)>0 and
            floor(extract(day from days.activity_at)*coalesce((t.definition->'schedule'->>'count')::integer,0)::numeric/
              extract(day from (date_trunc('month',days.activity_at)+interval '1 month'-interval '1 day')))>
            floor((extract(day from days.activity_at)-1)*coalesce((t.definition->'schedule'->>'count')::integer,0)::numeric/
              extract(day from (date_trunc('month',days.activity_at)+interval '1 month'-interval '1 day')))
          when 'specific-dates' then coalesce(t.definition->'schedule'->'dates','[]'::jsonb) @> to_jsonb(days.activity_at::date::text)
          when 'once' then (t.definition->'schedule'->>'date')::date=days.activity_at::date
          else false end
      ))
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
    join eligible_dates days on days.tracker_id=t.id and days.qualifies
    join public.tracker_entries e on e.user_id=t.user_id and e.tracker_id=t.id and e.entry_date=days.activity_date
      and e.deleted_at is null and e.entry_date<=v_today and e.server_changed_at<v_initialized_at
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

  if not v_has_history then
    v_opening_xp := null;
    v_legacy_xp_kind := 'unavailable';
  elsif v_opening_xp is null or v_opening_xp > 2147483647 then
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
      'label', 'XP reconstructed from past activity',
      'source', 'active and archived retained server tracker history',
      'calculation_version', 'legacy-tracker-rewards-v1',
      'reconstructed_at', v_initialized_at,
      'balance_kind', v_legacy_xp_kind,
      'cutover_at', v_initialized_at,
      'notes', 'Estimate reconstructed from retained server records. It is not an exact reproduction of prior device-calculated XP and does not represent individual historical rewards. Historical achievements are not awarded from this opening balance.'
    )
    ) on conflict (user_id, idempotency_key) do nothing;
  end if;

  -- Mark qualifying activity already present on the cutover calendar day.
  -- This prevents a later same-day edit from awarding the same activity again.
  insert into public.progression_award_state(
    user_id,award_key,reason_code,effective_date,tracker_id,source_id,updated_at
  )
  select e.user_id,md5(e.user_id::text||':'||e.id::text||':daily-check-in-v1')::uuid,
    'DAILY_CHECK_IN_COMPLETED',e.entry_date,e.tracker_id,e.id,v_initialized_at
  from public.tracker_entries e join public.trackers t on t.user_id=e.user_id and t.id=e.tracker_id
  where e.user_id=p_user_id and e.entry_date=v_today and e.deleted_at is null
    and e.server_changed_at<v_initialized_at and t.deleted_at is null and t.status in ('active','archived')
    and public.progression_entry_qualifies(t.definition,e.entry_values,e.outcome)
  on conflict(user_id,award_key) do nothing;

  insert into public.progression_account_state(user_id, initialized_at, scoring_version, legacy_xp_kind)
  values (p_user_id, v_initialized_at, 1, v_legacy_xp_kind)
  on conflict (user_id) do nothing;
end;
$$;
revoke all on function public.initialize_progression_account(uuid) from public,anon,authenticated,service_role;
commit;
