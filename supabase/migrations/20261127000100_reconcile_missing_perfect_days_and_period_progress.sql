-- Recover missed Perfect Day awards for supported dates when a user reads
-- achievements. Normal check-in triggers remain the immediate path for new
-- dates; this bounded, owner-scoped pass repairs earlier missed reconciliations.
begin;

-- The periodic worker reads only a three-day UTC envelope, which covers every
-- real account-local today (UTC-12 through UTC+14) and remains index-backed.
create index if not exists tracker_entries_live_date_user_idx
  on public.tracker_entries(entry_date, user_id) where deleted_at is null;

create or replace function public.reconcile_missing_perfect_days(p_user_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_history_start date;
  v_cutover date;
  v_initialized_at timestamptz;
  v_date date;
begin
  if p_user_id is null then return; end if;

  select s.timezone, a.initialized_at
    into v_timezone, v_initialized_at
  from public.app_settings s
  join public.progression_account_state a on a.user_id = s.user_id
  where s.user_id = p_user_id and s.timezone_configured;
  if not found or v_initialized_at is null then return; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_timezone) then v_timezone := 'UTC'; end if;
  v_today := (clock_timestamp() at time zone v_timezone)::date;
  v_cutover := (v_initialized_at at time zone v_timezone)::date;

  -- V10 carries date-effective snapshots. Only legacy definitions need the
  -- conservative latest-update boundary used by the canonical evaluator.
  select greatest(v_cutover, coalesce(
      max((t.updated_at at time zone v_timezone)::date) filter (where t.schema_version < 10), v_cutover))
    into v_history_start
  from public.trackers t
  where t.user_id = p_user_id and t.status in ('active', 'archived') and t.deleted_at is null;

  -- Walk only dates with retained entries for this owner, between the reliable
  -- history boundary and the owner's local today. Existing active awards are
  -- skipped. Unsupported, future, neutral, and failed dates cannot gain XP.
  -- The user/tracker/date unique index bounds the entry lookup to this owner.
  for v_date in
    select candidate.entry_date
    from (
      select distinct e.entry_date
      from public.trackers t
      join public.tracker_entries e on e.user_id = t.user_id and e.tracker_id = t.id
      where t.user_id = p_user_id
        and t.status in ('active', 'archived') and t.deleted_at is null
        and (t.status <> 'archived' or t.definition->>'archivedAt' is null
          or pg_catalog.left(t.definition->>'archivedAt', 10)::date >= e.entry_date)
        and e.deleted_at is null
        and e.entry_date between v_history_start and v_today
    ) candidate
    where not exists (
      select 1 from public.progression_award_state s
      where s.user_id = p_user_id
        and s.award_key = pg_catalog.md5(p_user_id::text || ':perfect-day:' || candidate.entry_date::text)::uuid
        and s.reason_code = 'PERFECT_DAY_BONUS'
        and s.current_xp > 0
    )
    order by candidate.entry_date
  loop
    if public.progression_evaluate_perfect_day(p_user_id, v_date) = 'perfect' then
      perform public.reconcile_progression_perfect_day(p_user_id, v_date);
    end if;
  end loop;
end;
$$;
revoke all on function public.reconcile_missing_perfect_days(uuid) from public, anon, authenticated, service_role;

-- Future-dated entries are intentionally not awarded early by the write
-- trigger. Sweep only dates that have become each owner's local today. The
-- batch cap bounds cron work; successful sources leave the candidate set, so
-- later runs advance through larger backlogs without a persistent cursor.
create or replace function public.reconcile_current_perfect_days(p_limit integer default 50)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_record record;
  v_processed integer := 0;
  v_now timestamptz := clock_timestamp();
  v_utc_today date;
begin
  v_utc_today := (v_now at time zone 'UTC')::date;
  for v_record in
    select candidate.user_id, candidate.entry_date
    from (
      select distinct e.user_id, e.entry_date
      from public.tracker_entries e
      join public.app_settings s on s.user_id = e.user_id
      join public.trackers t on t.user_id = e.user_id and t.id = e.tracker_id
      where e.deleted_at is null
        and e.entry_date between v_utc_today - 1 and v_utc_today + 1
        and e.entry_date = case
          when exists (select 1 from pg_catalog.pg_timezone_names z where z.name = s.timezone)
            then (v_now at time zone s.timezone)::date
          else (v_now at time zone 'UTC')::date
        end
        and t.status in ('active', 'archived') and t.deleted_at is null
        and (t.status <> 'archived' or t.definition->>'archivedAt' is null
          or pg_catalog.left(t.definition->>'archivedAt', 10)::date >= e.entry_date)
    ) candidate
    where public.progression_evaluate_perfect_day(candidate.user_id, candidate.entry_date) = 'perfect'
      and not exists (
        select 1 from public.progression_award_state state
        where state.user_id = candidate.user_id
          and state.award_key = pg_catalog.md5(candidate.user_id::text || ':perfect-day:' || candidate.entry_date::text)::uuid
          and state.reason_code = 'PERFECT_DAY_BONUS' and state.current_xp > 0
      )
    order by candidate.entry_date, candidate.user_id
    limit greatest(1, least(coalesce(p_limit, 50), 50))
  loop
    perform public.reconcile_progression_perfect_day(v_record.user_id, v_record.entry_date);
    perform public.reconcile_progression_achievements(v_record.user_id);
    v_processed := v_processed + 1;
  end loop;
  return v_processed;
end;
$$;
revoke all on function public.reconcile_current_perfect_days(integer) from public, anon, authenticated, service_role;

-- Publish current calendar-period progress from the same timezone, date
-- evaluator, and policy cutovers used by the award reconcilers.
create or replace function public.refresh_progression_perfect_period_details(p_user_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_period record;
  v_day date;
  v_state text;
  v_count integer;
  v_status text;
  v_message text;
begin
  if p_user_id is null then return; end if;
  select coalesce(s.timezone, 'UTC')
    into v_timezone
  from public.progression_achievement_accounts a
  left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if not found then return; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_today := (clock_timestamp() at time zone v_timezone)::date;

  for v_period in
    select p.achievement_id, p.period_start, p.period_end, p.target, p.policy_start
    from public.progression_policy_cutovers c
    cross join lateral (values
      ('perfect-week'::text, date_trunc('week', v_today::timestamp)::date,
        date_trunc('week', v_today::timestamp)::date + 6, 7, c.perfect_week_start),
      ('perfect-month'::text, date_trunc('month', v_today::timestamp)::date,
        (date_trunc('month', v_today::timestamp) + interval '1 month' - interval '1 day')::date,
        extract(day from (date_trunc('month', v_today::timestamp) + interval '1 month' - interval '1 day'))::integer,
        c.perfect_month_start),
      ('perfect-year'::text, date_trunc('year', v_today::timestamp)::date,
        (date_trunc('year', v_today::timestamp) + interval '1 year' - interval '1 day')::date,
        ((date_trunc('year', v_today::timestamp) + interval '1 year' - interval '1 day')::date
          - date_trunc('year', v_today::timestamp)::date + 1), c.perfect_year_start)
    ) p(achievement_id, period_start, period_end, target, policy_start)
    where c.id
  loop
    v_count := 0;
    v_status := 'in_progress';
    v_message := 'Confirmed Perfect Days so far.';

    if v_period.period_start < v_period.policy_start then
      v_status := 'unavailable';
      v_message := 'This calendar period starts before the current qualification policy.';
    else
      v_day := v_period.period_start;
      while v_day <= least(v_period.period_end, v_today) loop
        v_state := public.progression_evaluate_perfect_day(p_user_id, v_day);
        if v_state = 'unsupported' then
          v_status := 'unavailable';
          v_message := 'This period includes dates without reliable schedule history.';
          exit;
        elsif v_state in ('failed', 'neutral') then
          v_status := 'failed';
          v_message := 'A required date was not a Perfect Day. Qualification starts again next period.';
          exit;
        elsif v_state = 'perfect' and public.progression_perfect_period_day_qualifies(p_user_id, v_day) then
          v_count := v_count + 1;
        elsif v_state = 'perfect' then
          v_status := 'failed';
          v_message := 'No eligible positive target was confirmed on this date.';
          exit;
        end if;
        v_day := v_day + 1;
      end loop;
    end if;

    if v_status = 'in_progress' and v_period.period_end <= v_today and v_count = v_period.target then
      v_status := 'earned';
      v_message := 'Every date in this calendar period was confirmed as a Perfect Day.';
    end if;

    update public.progression_achievement_progress
    set qualification_details = jsonb_build_object(
          'status', v_status,
          'label', case v_period.achievement_id
            when 'perfect-week' then 'Current calendar week'
            when 'perfect-month' then 'Current calendar month'
            else 'Current calendar year' end,
          'period_start', v_period.period_start,
          'period_end', v_period.period_end,
          'progress', v_count,
          'target', v_period.target,
          'percentage', round(v_count::numeric / v_period.target * 100, 0),
          'message', v_message || ' ' || v_count::text || ' of ' || v_period.target::text || ' dates confirmed.'
        ),
        updated_at = clock_timestamp()
    where user_id = p_user_id and achievement_id = v_period.achievement_id;
  end loop;
end;
$$;
revoke all on function public.refresh_progression_perfect_period_details(uuid) from public, anon, authenticated, service_role;

-- Refresh through the full wrapper: repeatable/base badges, Perfect Year, and
-- truthful current-period details. The RPC remains owner-scoped and compatible
-- with clients that already call it.
create or replace function public.refresh_my_progression_qualification_progress()
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform public.initialize_progression_account(v_user_id);
  insert into public.progression_achievement_accounts(user_id, initialized_at)
    select v_user_id, initialized_at from public.progression_account_state where user_id = v_user_id
    on conflict(user_id) do nothing;
  perform public.reconcile_missing_perfect_days(v_user_id);
  perform public.reconcile_progression_achievements(v_user_id);
end;
$$;
revoke all on function public.refresh_my_progression_qualification_progress() from public, anon, authenticated, service_role;
grant execute on function public.refresh_my_progression_qualification_progress() to authenticated;

comment on function public.reconcile_missing_perfect_days(uuid) is
  'Repairs missing Perfect Day ledger awards for one owner using the canonical evaluator and supported history boundary.';
comment on function public.reconcile_current_perfect_days(integer) is
  'Bounded five-minute worker for current account-local dates; reconciles at most 50 canonical Perfect Days that became current after future-dated check-in sync.';
comment on function public.refresh_my_progression_qualification_progress() is
  'Owner-scoped refresh that reconciles missing supported Perfect Days and refreshes all achievement and current-period qualification details.';

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname = 'progress-tracker-current-perfect-days' loop
    perform cron.unschedule(v_job_id);
  end loop;
  perform cron.schedule(
    'progress-tracker-current-perfect-days', '*/5 * * * *',
    'select public.reconcile_current_perfect_days(50);'
  );
end;
$$;

commit;
