-- Avoid rescanning timezone catalog metadata for every scheduled date, and
-- calculate all tracker streak milestone crossings from one history scan.
begin;

create or replace function public.progression_date_is_eligible(
  p_user_id uuid, p_tracker public.trackers, p_date date
)
returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  v_definition jsonb := p_tracker.definition;
  v_schedule jsonb := p_tracker.definition->'schedule';
  v_zone text;
  v_created_local_date date;
  v_anchor date;
  v_weekday integer;
  v_day integer;
  v_month_days integer;
  v_count integer;
  v_interval integer;
begin
  select s.timezone into v_zone
  from public.app_settings s
  where s.user_id = p_user_id and s.timezone_configured;
  if not found or v_zone is null then return false; end if;

  -- AT TIME ZONE validates the stored IANA name directly. The previous
  -- pg_timezone_names existence scan ran once for every generated history day.
  begin
    v_created_local_date := (p_tracker.created_at at time zone v_zone)::date;
  exception when invalid_parameter_value then
    return false;
  end;
  v_anchor := coalesce((v_definition->>'startDate')::date, v_created_local_date);
  if v_anchor is null or p_date < v_anchor
    or (v_definition->>'deadline' is not null and p_date > (v_definition->>'deadline')::date) then return false; end if;
  if coalesce((v_definition->>'strictMode')::boolean, false) then return true; end if;
  if exists(select 1 from public.account_holidays h where h.user_id = p_user_id and h.holiday_date = p_date and h.deleted_at is null) then return false; end if;

  v_weekday := extract(dow from p_date)::integer;
  v_day := extract(day from p_date)::integer;
  v_month_days := extract(day from (date_trunc('month', p_date::timestamp) + interval '1 month' - interval '1 day'))::integer;
  case v_schedule->>'kind'
    when 'every-day' then return true;
    when 'weekdays' then return v_weekday between 1 and 5;
    when 'selected-weekdays' then return coalesce(v_schedule->'weekdays', '[]'::jsonb) @> to_jsonb(v_weekday);
    when 'every-n-days' then
      v_interval := greatest(coalesce((v_schedule->>'interval')::integer, 0), 0);
      return v_interval > 0 and mod(p_date - v_anchor, v_interval) = 0;
    when 'times-per-week' then
      if v_schedule ? 'preferredWeekdays' then return coalesce(v_schedule->'preferredWeekdays', '[]'::jsonb) @> to_jsonb(v_weekday); end if;
      v_count := coalesce((v_schedule->>'count')::integer, 0);
      return v_count > 0 and floor((v_weekday + 1) * v_count / 7.0) > floor(v_weekday * v_count / 7.0);
    when 'times-per-month' then
      v_count := coalesce((v_schedule->>'count')::integer, 0);
      return v_count > 0 and floor(v_day * v_count::numeric / v_month_days) > floor((v_day - 1) * v_count::numeric / v_month_days);
    when 'specific-dates' then return coalesce(v_schedule->'dates', '[]'::jsonb) @> to_jsonb(p_date::text);
    when 'once' then return (v_schedule->>'date')::date = p_date;
    else return false;
  end case;
end;
$$;
revoke all on function public.progression_date_is_eligible(uuid, public.trackers, date) from public, anon, authenticated;

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
  v_index integer := 0;
  v_crossed_date date;
  v_crossed_at timestamptz;
  v_crossed_dates date[];
  v_crossed_sources timestamptz[];
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

  -- Materialize the eligible day series once. Every milestone below uses the
  -- same historical Streak Rule results and the same baseline/cutover policy.
  with eligible as materialized (
    select days.activity_at::date as activity_date,
      entry.server_changed_at as source_at,
      entry.id is not null and public.progression_entry_streak_qualifies(v_tracker.definition, entry.entry_values, entry.outcome) as qualifies
    from lateral generate_series(
      coalesce((v_tracker.definition->>'startDate')::date, (v_tracker.created_at at time zone v_timezone)::date)::timestamp,
      v_today::timestamp, interval '1 day'
    ) as days(activity_at)
    left join public.tracker_entries entry on entry.user_id = p_user_id and entry.tracker_id = p_tracker_id
      and entry.entry_date = days.activity_at::date and entry.deleted_at is null
    where public.progression_date_is_eligible(p_user_id, v_tracker, days.activity_at::date)
      and (days.activity_at::date >= (v_cutover_at at time zone v_timezone)::date or not exists (
        select 1 from public.progression_historical_entry_baseline b
        where b.user_id = p_user_id and b.entry_id = entry.id
      ))
  ), groups as (
    select activity_date, source_at, qualifies,
      sum(case when qualifies then 0 else 1 end) over (order by activity_date) as run_group
    from eligible
  ), runs as (
    select activity_date, source_at, qualifies, run_group,
      sum(case when qualifies then 1 else 0 end) over (partition by run_group order by activity_date) as run_length
    from groups
  ), thresholds as (
    select unnest(array[7,14,30,100])::integer as threshold
  ), first_crossings as (
    select distinct on (thresholds.threshold) thresholds.threshold, runs.activity_date, runs.source_at
    from runs cross join thresholds
    where runs.qualifies and runs.run_length = thresholds.threshold
    order by thresholds.threshold, runs.activity_date
  )
  select array_agg(first_crossings.activity_date order by thresholds.threshold),
    array_agg(first_crossings.source_at order by thresholds.threshold)
  into v_crossed_dates, v_crossed_sources
  from thresholds left join first_crossings using (threshold);

  foreach v_threshold in array array[7,14,30,100] loop
    v_index := v_index + 1;
    v_crossed_date := v_crossed_dates[v_index];
    v_crossed_at := v_crossed_sources[v_index];
    v_xp := case v_threshold when 7 then 35 when 14 then 50 when 30 then 100 else 200 end;
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
revoke all on function public.reconcile_progression_tracker_milestones(uuid, uuid) from public, anon, authenticated, service_role;

commit;
