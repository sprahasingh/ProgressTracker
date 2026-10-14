-- Distinguish an intentional UTC choice from the schema default, use only a
-- configured IANA timezone for Perfect Day, and backfill retained entry dates
-- after a timezone is established or changed.
begin;

alter table public.app_settings
  add column if not exists timezone_configured boolean not null default false;

-- Non-UTC values predate the marker but were explicit settings. Existing UTC
-- values are ambiguous and will be seeded from the device's stored preference.
update public.app_settings set timezone_configured = true
where timezone <> 'UTC' and not timezone_configured;

create or replace function public.progression_local_date(p_instant timestamptz, p_timezone text)
returns date
language plpgsql stable
set search_path = ''
as $$
begin
  if p_instant is null or p_timezone is null
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    return null;
  end if;
  return (p_instant at time zone p_timezone)::date;
end;
$$;
revoke all on function public.progression_local_date(timestamptz, text) from public, anon, authenticated, service_role;

create or replace function public.progression_date_is_eligible(p_user_id uuid, p_tracker public.trackers, p_date date)
returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  v_definition jsonb := p_tracker.definition;
  v_schedule jsonb := p_tracker.definition->'schedule';
  v_zone text;
  v_anchor date;
  v_weekday integer;
  v_day integer;
  v_month_days integer;
  v_count integer;
  v_interval integer;
begin
  select s.timezone into v_zone from public.app_settings s
  where s.user_id = p_user_id and s.timezone_configured;
  if not found or not exists(select 1 from pg_catalog.pg_timezone_names where name = v_zone) then return false; end if;
  v_anchor := greatest(coalesce((v_definition->>'startDate')::date, public.progression_local_date(p_tracker.created_at, v_zone)),
    public.progression_local_date(p_tracker.created_at, v_zone));
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

create or replace function public.progression_evaluate_perfect_day(p_user_id uuid, p_date date)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_cutover date;
  v_definition_boundary date;
  v_required integer;
  v_qualified integer;
  v_failed integer;
  v_pending integer;
begin
  if p_user_id is null or p_date is null then return 'unsupported'; end if;
  select s.timezone,
      public.progression_local_date(clock_timestamp(), s.timezone),
      public.progression_local_date(a.initialized_at, s.timezone)
    into v_timezone, v_today, v_cutover
  from public.progression_achievement_accounts a
  join public.app_settings s on s.user_id = a.user_id and s.timezone_configured
  where a.user_id = p_user_id;
  if not found or v_today is null or v_cutover is null then return 'unsupported'; end if;
  if p_date > v_today then return 'future'; end if;

  select greatest(v_cutover, coalesce(max((t.updated_at at time zone v_timezone)::date), v_cutover))
    into v_definition_boundary
  from public.trackers t
  where t.user_id = p_user_id and t.status in ('active', 'archived') and t.deleted_at is null;
  if p_date < v_definition_boundary then return 'unsupported'; end if;

  select count(*)::integer,
      count(*) filter (where e.id is not null and e.deleted_at is null
        and e.outcome = 'recorded'
        and public.progression_entry_success_qualifies(t.definition, e.entry_values, e.outcome))::integer,
      count(*) filter (where e.outcome = 'skipped' or (e.id is not null and e.deleted_at is null
        and not public.progression_entry_success_qualifies(t.definition, e.entry_values, e.outcome) and p_date < v_today)
        or (e.id is null and p_date < v_today))::integer,
      count(*) filter (where p_date = v_today and (e.id is null or (e.outcome = 'recorded'
        and not public.progression_entry_success_qualifies(t.definition, e.entry_values, e.outcome))))::integer
    into v_required, v_qualified, v_failed, v_pending
  from public.trackers t
  left join public.tracker_entries e
    on e.user_id = t.user_id and e.tracker_id = t.id and e.entry_date = p_date and e.deleted_at is null
  where t.user_id = p_user_id
    and t.status in ('active', 'archived') and t.deleted_at is null
    and (t.status <> 'archived' or t.definition->>'archivedAt' is null
      or pg_catalog.left(t.definition->>'archivedAt', 10)::date >= p_date)
    and public.progression_date_is_eligible(p_user_id, t, p_date);

  if coalesce(v_required, 0) = 0 then return 'neutral'; end if;
  if coalesce(v_failed, 0) > 0 then return 'failed'; end if;
  if coalesce(v_pending, 0) > 0 then return 'pending'; end if;
  if v_qualified = v_required then return 'perfect'; end if;
  return 'failed';
end;
$$;
revoke all on function public.progression_evaluate_perfect_day(uuid, date) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_perfect_day(p_user_id uuid, p_date date)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_cutover date;
  v_state text;
  v_key uuid;
begin
  if p_user_id is null or p_date is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':progression-perfect-day:' || p_date::text, 5)
  );
  select s.timezone,
      public.progression_local_date(clock_timestamp(), s.timezone),
      public.progression_local_date(a.initialized_at, s.timezone)
    into v_timezone, v_today, v_cutover
  from public.progression_account_state a
  join public.app_settings s on s.user_id = a.user_id and s.timezone_configured
  where a.user_id = p_user_id;
  if not found or v_today is null or v_cutover is null then return; end if;
  -- At 00:30 in India, the same instant is still the previous UTC date.
  -- Compare the entry date only to the configured local date.
  if p_date < v_cutover then return; end if;
  if p_date > v_today then
    -- A timezone change can move a previously awarded date ahead of the new
    -- local today. Reverse an active occurrence; ignore unawarded future dates.
    if not exists (
      select 1 from public.progression_award_state s
      where s.user_id = p_user_id
        and s.award_key = md5(p_user_id::text || ':perfect-day:' || p_date::text)::uuid
        and s.reason_code = 'PERFECT_DAY_BONUS' and s.current_xp > 0
    ) then return; end if;
    v_state := 'future';
  else
    v_state := public.progression_evaluate_perfect_day(p_user_id, p_date);
  end if;
  v_key := md5(p_user_id::text || ':perfect-day:' || p_date::text)::uuid;
  perform public.reconcile_progression_award(
    p_user_id, v_key, 'PERFECT_DAY_BONUS', p_date, 20, null, null, null,
    v_state = 'perfect', 'Every eligible tracker met its configured success rule on this local date'
  );
end;
$$;
revoke all on function public.reconcile_progression_perfect_day(uuid, date) from public, anon, authenticated, service_role;

create or replace function public.reconcile_perfect_day_after_timezone_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date;
  v_cutover date;
  v_date date;
begin
  if not new.timezone_configured
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    return new;
  end if;
  if tg_op = 'UPDATE'
    and old.timezone is not distinct from new.timezone
    and old.timezone_configured is not distinct from new.timezone_configured then
    return new;
  end if;

  v_today := public.progression_local_date(clock_timestamp(), new.timezone);
  select public.progression_local_date(a.initialized_at, new.timezone) into v_cutover
  from public.progression_account_state a where a.user_id = new.user_id;
  if v_today is null or v_cutover is null then return new; end if;

  -- Reconcile the current date and retained historical entry dates skipped
  -- while no configured timezone was available.
  perform public.reconcile_progression_perfect_day(new.user_id, v_today);
  for v_date in
    select distinct e.entry_date
    from public.tracker_entries e
    where e.user_id = new.user_id and e.entry_date >= v_cutover
    order by e.entry_date
  loop
    perform public.reconcile_progression_perfect_day(new.user_id, v_date);
  end loop;
  return new;
end;
$$;
revoke all on function public.reconcile_perfect_day_after_timezone_change() from public, anon, authenticated, service_role;

drop trigger if exists app_settings_reconcile_perfect_day_timezone on public.app_settings;
create trigger app_settings_reconcile_perfect_day_timezone
after insert or update of timezone, timezone_configured on public.app_settings
for each row execute function public.reconcile_perfect_day_after_timezone_change();

comment on column public.app_settings.timezone_configured is
  'True after an IANA timezone is explicitly established; distinguishes intentional UTC from the schema default.';

commit;

