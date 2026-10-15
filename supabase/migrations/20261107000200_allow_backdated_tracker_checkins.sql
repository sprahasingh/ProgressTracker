-- A configured tracker start date is the earliest recordable activity date,
-- even when the tracker itself was created later. Entries still have to be
-- today or earlier in the account timezone, within the deadline, and attached
-- to an active, owned tracker through the existing sync boundary and RLS.
begin;

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

  v_anchor := coalesce((v_definition->>'startDate')::date, public.progression_local_date(p_tracker.created_at, v_zone));
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
comment on function public.progression_date_is_eligible(uuid, public.trackers, date) is
  'Checks configured start/deadline, schedule, strict mode, holiday, and configured account timezone. Explicit backdated starts are not clamped to tracker creation.';

create or replace function public.guard_tracker_entry_date_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers%rowtype;
  v_zone text;
  v_today date;
  v_start date;
  v_deadline date;
begin
  if new.deleted_at is not null then return new; end if;
  select * into v_tracker from public.trackers t
  where t.user_id = new.user_id and t.id = new.tracker_id;
  if not found then return new; end if;

  select coalesce(s.timezone, 'UTC') into v_zone from public.app_settings s where s.user_id = new.user_id;
  v_zone := coalesce(v_zone, 'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = v_zone) then v_zone := 'UTC'; end if;
  v_today := public.progression_local_date(clock_timestamp(), v_zone);
  v_start := coalesce((v_tracker.definition->>'startDate')::date, public.progression_local_date(v_tracker.created_at, v_zone));
  v_deadline := nullif(v_tracker.definition->>'deadline', '')::date;

  if new.entry_date > v_today then
    raise exception 'Check-ins can only be saved for today or an earlier date in the account timezone.' using errcode = '23514';
  end if;
  if new.entry_date < v_start then
    raise exception 'Check-in date is before the tracker start date.' using errcode = '23514';
  end if;
  if v_deadline is not null and new.entry_date > v_deadline then
    raise exception 'Check-in date is after the tracker deadline.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_tracker_entry_date_window() from public, anon, authenticated, service_role;
drop trigger if exists tracker_entries_date_window_guard on public.tracker_entries;
create trigger tracker_entries_date_window_guard
before insert or update on public.tracker_entries
for each row execute function public.guard_tracker_entry_date_window();
comment on function public.guard_tracker_entry_date_window() is
  'Rejects live check-ins outside the configured local date window while allowing explicit backdated starts before tracker creation.';

commit;
