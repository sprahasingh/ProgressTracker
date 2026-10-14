-- Add two server-authoritative, repeatable achievements. Historical months and
-- recovery episodes are evaluated only where current schedule data is reliable.
begin;

create table public.progression_achievement_event_sources (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_event_id uuid not null,
  source_tracker_id uuid not null,
  source_key text not null,
  primary key (user_id, achievement_event_id, source_tracker_id, source_key),
  foreign key (user_id, achievement_event_id)
    references public.progression_achievement_events(user_id, id) on delete cascade,
  foreign key (user_id, source_tracker_id)
    references public.trackers(user_id, id) on delete cascade
);
alter table public.progression_achievement_event_sources enable row level security;
revoke all on public.progression_achievement_event_sources from public, anon, authenticated, service_role;
create index progression_achievement_event_sources_tracker_idx
  on public.progression_achievement_event_sources(user_id, source_tracker_id, achievement_event_id);

-- Give already-initialized accounts locked rows for the new badges so the
-- existing Wins repository can render them immediately after this migration.
-- This does not inspect tracker history or create award events.
insert into public.progression_achievement_progress(user_id, achievement_id, progress, target, current_tier, repeatable)
select account.user_id, badge.achievement_id, 0, 1, 0, true
from public.progression_achievement_accounts account
cross join (values ('perfect-month'), ('the-comeback')) as badge(achievement_id)
on conflict (user_id, achievement_id) do nothing;

create or replace function public.progression_perfect_month_qualifies(
  p_user_id uuid, p_month_start date, p_excluded_tracker_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_cutover date;
  v_definition_boundary date;
  v_end date;
  v_bad_days integer;
begin
  if p_user_id is null or p_month_start is null
    or p_month_start <> pg_catalog.date_trunc('month', p_month_start::timestamp)::date then
    return false;
  end if;
  select coalesce(s.timezone, 'UTC'), (clock_timestamp() at time zone coalesce(s.timezone, 'UTC'))::date,
    (a.initialized_at at time zone coalesce(s.timezone, 'UTC'))::date
    into v_timezone, v_today, v_cutover
  from public.progression_achievement_accounts a
  left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if not found then return false; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC';
    v_today := (clock_timestamp() at time zone 'UTC')::date;
    select (a.initialized_at at time zone 'UTC')::date into v_cutover
      from public.progression_achievement_accounts a where a.user_id = p_user_id;
  end if;
  v_end := (p_month_start + interval '1 month' - interval '1 day')::date;
  if v_end >= v_today then return false; end if;
  -- A partial cutover month or a month whose starting schedule may have been
  -- edited is unsupported. Do not reconstruct missing schedule history.
  select greatest(v_cutover, coalesce(max((t.updated_at at time zone v_timezone)::date), v_cutover))
    into v_definition_boundary
  from public.trackers t
  where t.user_id = p_user_id and t.status in ('active', 'archived') and t.deleted_at is null;
  if p_month_start < v_definition_boundary
    or (p_month_start = v_definition_boundary and extract(day from v_definition_boundary) > 1) then
    return false;
  end if;
  if exists (
    select 1 from public.account_holidays h
    where h.user_id = p_user_id and h.deleted_at is null
      and h.holiday_date between p_month_start and v_end
  ) then return false; end if;

  select count(*)::integer into v_bad_days
  from pg_catalog.generate_series(p_month_start::timestamp, v_end::timestamp, interval '1 day') as days(day)
  cross join lateral (
    select count(*)::integer as eligible_count,
      count(*) filter (where exists (
        select 1 from public.tracker_entries e
        where e.user_id = p_user_id and e.tracker_id = t.id and e.entry_date = days.day::date
          and e.deleted_at is null and e.outcome = 'recorded'
          and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome)
      ))::integer as completed_count
    from public.trackers t
    where t.user_id = p_user_id and t.status in ('active', 'archived') and t.deleted_at is null
      and (p_excluded_tracker_id is null or t.id <> p_excluded_tracker_id)
      and public.progression_date_is_eligible(p_user_id, t, days.day::date)
  ) day_state
  where day_state.eligible_count = 0 or day_state.completed_count <> day_state.eligible_count;
  return v_bad_days = 0;
end;
$$;
revoke all on function public.progression_perfect_month_qualifies(uuid, date, uuid) from public, anon, authenticated, service_role;

create or replace function public.progression_comeback_candidates(p_user_id uuid, p_start date, p_end date)
returns table(source_tracker_id uuid, missed_on date, recovery_started date, qualified_on date, source_key text)
language sql
stable
security definer
set search_path = ''
as $$
  with eligible as (
    select t.id as tracker_id, d.day::date as activity_date,
      exists (
        select 1 from public.tracker_entries e
        where e.user_id = p_user_id and e.tracker_id = t.id and e.entry_date = d.day::date
          and e.deleted_at is null and e.outcome = 'recorded'
          and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome)
      ) as qualifies,
      exists (
        select 1 from public.tracker_entries e
        where e.user_id = p_user_id and e.tracker_id = t.id and e.entry_date = d.day::date and e.deleted_at is null
      ) as has_entry
    from public.trackers t
    cross join lateral pg_catalog.generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') d(day)
    where t.user_id = p_user_id and t.status in ('active', 'archived') and t.deleted_at is null
      and public.progression_date_is_eligible(p_user_id, t, d.day::date)
  ), ordered as (
    select e.*, lag(e.qualifies, 1, false) over (partition by e.tracker_id order by e.activity_date) as prior_qualifies
    from eligible e
  ), breaks as (
    select tracker_id, activity_date as break_date from ordered
    where not qualifies and not has_entry and prior_qualifies
  ), candidates as (
    select b.tracker_id, b.break_date, streak.first_date, streak.seventh_date
    from breaks b
    cross join lateral (
      select min(next_day.activity_date) as first_date,
        max(next_day.activity_date) filter (where next_day.ordinal = 7) as seventh_date,
        count(*)::integer as streak_days,
        bool_and(next_day.qualifies) as all_qualified
      from (
        select e.activity_date, e.qualifies,
          row_number() over (order by e.activity_date)::integer as ordinal
        from eligible e
        where e.tracker_id = b.tracker_id and e.activity_date > b.break_date
        order by e.activity_date limit 7
      ) next_day
    ) streak
    where streak.streak_days = 7 and streak.all_qualified
  )
  select c.tracker_id, c.break_date, c.first_date, c.seventh_date,
    pg_catalog.md5(p_user_id::text || ':' || c.tracker_id::text || ':' || c.break_date::text || ':' || c.seventh_date::text)
  from candidates c
$$;
revoke all on function public.progression_comeback_candidates(uuid, date, date) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_extended_achievements(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_cutover date;
  v_reliable_start date;
  v_month date;
  v_month_end date;
  v_event public.progression_achievement_events%rowtype;
  v_new_event public.progression_achievement_events%rowtype;
  v_tier integer;
  v_generation integer;
  v_active_count integer;
  v_source_key text;
  v_break_date date;
  v_recovery_start date;
  v_recovered_on date;
  v_tracker_id uuid;
  v_source_event_id uuid;
  v_source record;
begin
  if p_user_id is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':progression-achievements', 11)
  );
  select coalesce(s.timezone, 'UTC'),
      (clock_timestamp() at time zone coalesce(s.timezone, 'UTC'))::date,
      (a.initialized_at at time zone coalesce(s.timezone, 'UTC'))::date
    into v_timezone, v_today, v_cutover
  from public.progression_achievement_accounts a
  left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if not found then return; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC';
    v_today := (clock_timestamp() at time zone 'UTC')::date;
    select (a.initialized_at at time zone 'UTC')::date into v_cutover
      from public.progression_achievement_accounts a where a.user_id = p_user_id;
  end if;
  select greatest(v_cutover, coalesce(max((t.updated_at at time zone v_timezone)::date), v_cutover))
    into v_reliable_start
  from public.trackers t
  where t.user_id = p_user_id and t.status in ('active', 'archived') and t.deleted_at is null;

  -- Revoke only months that remain inside the reliable current-definition
  -- window. Older earned months are preserved when their historical schedule
  -- can no longer be reconstructed.
  for v_event in
    select u.* from public.progression_achievement_events u
    where u.user_id = p_user_id and u.achievement_id = 'perfect-month' and u.event_type = 'unlocked'
      and (u.source_reference->>'month') ~ '^\d{4}-\d{2}$'
      and (u.source_reference->>'month' || '-01')::date >= v_reliable_start
      and not exists (select 1 from public.progression_achievement_events r
        where r.user_id = u.user_id and r.reverses_event_id = u.id)
      and not exists (select 1 from public.progression_retained_achievement_unlocks keep
        where keep.user_id = u.user_id and keep.achievement_event_id = u.id)
  loop
    v_month := (v_event.source_reference->>'month' || '-01')::date;
    if not public.progression_perfect_month_qualifies(p_user_id, v_month) then
      insert into public.progression_achievement_events(
        user_id, achievement_id, tier, generation, event_type, source_event_id,
        source_date, source_reference, idempotency_key, reverses_event_id
      ) values (
        p_user_id, 'perfect-month', v_event.tier, v_event.generation, 'revoked',
        v_event.source_event_id, v_event.source_date,
        jsonb_build_object('reason', 'A historical correction changed this month’s eligibility'),
        'revoke:' || v_event.id::text, v_event.id
      ) on conflict (user_id, idempotency_key) do nothing;
      delete from public.progression_achievement_event_sources s
      where s.user_id = p_user_id and s.achievement_event_id = v_event.id;
    end if;
  end loop;

  for v_month in
    select months.month_start::date
    from pg_catalog.generate_series(
      pg_catalog.date_trunc('month', v_reliable_start::timestamp),
      pg_catalog.date_trunc('month', (v_today - 1)::timestamp), interval '1 month'
    ) as months(month_start)
    where months.month_start::date >= v_reliable_start
    order by months.month_start
  loop
    if not public.progression_perfect_month_qualifies(p_user_id, v_month) then continue; end if;
    v_month_end := (v_month + interval '1 month' - interval '1 day')::date;
    select u.* into v_event from public.progression_achievement_events u
    where u.user_id = p_user_id and u.achievement_id = 'perfect-month' and u.event_type = 'unlocked'
      and u.source_reference->>'month' = pg_catalog.to_char(v_month, 'YYYY-MM')
      and not exists (select 1 from public.progression_achievement_events r
        where r.user_id = u.user_id and r.reverses_event_id = u.id)
    order by u.recorded_at desc limit 1;
    if v_event.id is null then
      select count(*)::integer into v_active_count
      from public.progression_achievement_events u
      where u.user_id = p_user_id and u.achievement_id = 'perfect-month' and u.event_type = 'unlocked'
        and not exists (select 1 from public.progression_achievement_events r
          where r.user_id = u.user_id and r.reverses_event_id = u.id);
      select coalesce(max(u.generation), 0) + 1 into v_generation
      from public.progression_achievement_events u
      where u.user_id = p_user_id and u.achievement_id = 'perfect-month'
        and u.source_reference->>'month' = pg_catalog.to_char(v_month, 'YYYY-MM');
      insert into public.progression_achievement_events(
        user_id, achievement_id, tier, generation, event_type, source_date, source_reference, idempotency_key
      ) values (
        p_user_id, 'perfect-month', v_active_count + 1, v_generation, 'unlocked', v_month_end,
        jsonb_build_object('rule', 'Every calendar date had eligible trackers, all qualified, and the month had no account-wide holidays',
          'month', pg_catalog.to_char(v_month, 'YYYY-MM')),
        'perfect-month:' || pg_catalog.to_char(v_month, 'YYYY-MM') || ':unlock:' || v_generation
      ) on conflict (user_id, idempotency_key) do nothing returning * into v_new_event;
      if v_new_event.id is not null then v_event := v_new_event; end if;
    end if;
    if v_event.id is not null then
      delete from public.progression_achievement_event_sources s
      where s.user_id = p_user_id and s.achievement_event_id = v_event.id;
      insert into public.progression_achievement_event_sources(user_id, achievement_event_id, source_tracker_id, source_key)
      select p_user_id, v_event.id, t.id, 'month:' || pg_catalog.to_char(v_month, 'YYYY-MM')
      from public.trackers t
      where t.user_id = p_user_id and t.status in ('active', 'archived') and t.deleted_at is null
        and exists (
          select 1 from pg_catalog.generate_series(v_month, v_month_end, interval '1 day') dates(day)
          where public.progression_date_is_eligible(p_user_id, t, dates.day::date)
        )
      on conflict do nothing;
      v_event := null;
    end if;
  end loop;

  -- A Comeback begins only when an actually missed, closed opportunity comes
  -- immediately after a qualifying opportunity. Skips and saved nonqualifying
  -- outcomes break a streak but are not counted as missed opportunities.
  for v_tracker_id, v_break_date, v_recovery_start, v_recovered_on, v_source_key in
    select c.source_tracker_id, c.missed_on, c.recovery_started, c.qualified_on, c.source_key
    from public.progression_comeback_candidates(p_user_id, v_reliable_start, v_today - 1) c
    order by c.source_tracker_id, c.missed_on
  loop
    select u.* into v_event from public.progression_achievement_events u
    join public.progression_achievement_event_sources src
      on src.user_id = u.user_id and src.achievement_event_id = u.id and src.source_tracker_id = v_tracker_id and src.source_key = 'comeback:' || v_source_key
    where u.user_id = p_user_id and u.achievement_id = 'the-comeback' and u.event_type = 'unlocked'
      and not exists (select 1 from public.progression_achievement_events r
        where r.user_id = u.user_id and r.reverses_event_id = u.id)
    order by u.recorded_at desc limit 1;
    if v_event.id is null then
      select count(*)::integer into v_active_count
      from public.progression_achievement_events u
      where u.user_id = p_user_id and u.achievement_id = 'the-comeback' and u.event_type = 'unlocked'
        and not exists (select 1 from public.progression_achievement_events r
          where r.user_id = u.user_id and r.reverses_event_id = u.id);
      select coalesce(max(u.generation), 0) + 1 into v_generation
      from public.progression_achievement_events u
      where u.user_id = p_user_id and u.achievement_id = 'the-comeback'
        and u.idempotency_key like 'comeback:' || v_source_key || ':unlock:%';
      select e.id into v_source_event_id
      from public.progression_event_sources src
      join public.progression_award_state a on a.user_id = src.user_id and a.source_id = src.source_id
        and a.current_xp > 0 and a.reason_code = 'DAILY_CHECK_IN_COMPLETED'
      join public.progression_events e on e.user_id = a.user_id and e.id = a.current_event_id
      where src.user_id = p_user_id and src.tracker_id = v_tracker_id and e.effective_date = v_recovered_on
      order by e.recorded_at desc limit 1;
      insert into public.progression_achievement_events(
        user_id, achievement_id, tier, generation, event_type, source_event_id, source_date, source_reference, idempotency_key
      ) values (
        p_user_id, 'the-comeback', v_active_count + 1, v_generation, 'unlocked', v_source_event_id, v_recovered_on,
        jsonb_build_object('rule', 'A missed required opportunity was followed by seven consecutive qualifying opportunities',
          'missed_on', v_break_date, 'recovery_started', v_recovery_start, 'qualified_on', v_recovered_on),
        'comeback:' || v_source_key || ':unlock:' || v_generation
      ) on conflict (user_id, idempotency_key) do nothing returning * into v_new_event;
      if v_new_event.id is not null then v_event := v_new_event; end if;
    end if;
    if v_event.id is not null then
      insert into public.progression_achievement_event_sources(user_id, achievement_event_id, source_tracker_id, source_key)
      values (p_user_id, v_event.id, v_tracker_id, 'comeback:' || v_source_key)
      on conflict do nothing;
      v_event := null;
    end if;
  end loop;

  -- Revoke recovery events only when their source date remains in the reliable
  -- schedule window. A previously retained Keep Wins event is permanent.
  for v_source in
    select u.*, src.source_tracker_id, src.source_key from public.progression_achievement_events u
    join public.progression_achievement_event_sources src on src.user_id = u.user_id and src.achievement_event_id = u.id
    where u.user_id = p_user_id and u.achievement_id = 'the-comeback' and u.event_type = 'unlocked'
      and u.source_date >= v_reliable_start
      and not exists (select 1 from public.progression_achievement_events r where r.user_id = u.user_id and r.reverses_event_id = u.id)
      and not exists (select 1 from public.progression_retained_achievement_unlocks keep where keep.user_id = u.user_id and keep.achievement_event_id = u.id)
      and not exists (select 1 from public.progression_comeback_candidates(p_user_id, v_reliable_start, v_today - 1) c
        where c.source_tracker_id = src.source_tracker_id and 'comeback:' || c.source_key = src.source_key)
  loop
    insert into public.progression_achievement_events(
      user_id, achievement_id, tier, generation, event_type, source_event_id, source_date, source_reference,
      idempotency_key, reverses_event_id
    ) values (
      p_user_id, 'the-comeback', v_source.tier, v_source.generation, 'revoked', v_source.source_event_id,
      v_source.source_date, jsonb_build_object('reason', 'A historical correction changed the recovery streak'),
      'revoke:' || v_source.id::text, v_source.id
    ) on conflict (user_id, idempotency_key) do nothing;
    delete from public.progression_achievement_event_sources s
    where s.user_id = p_user_id and s.achievement_event_id = v_source.id;
  end loop;

  select count(*)::integer into v_active_count
  from public.progression_achievement_events u
  where u.user_id = p_user_id and u.achievement_id = 'perfect-month' and u.event_type = 'unlocked'
    and not exists (select 1 from public.progression_achievement_events r where r.user_id = u.user_id and r.reverses_event_id = u.id);
  insert into public.progression_achievement_progress(user_id, achievement_id, progress, target, current_tier, repeatable)
  values (p_user_id, 'perfect-month', v_active_count, 1, v_active_count, true)
  on conflict (user_id, achievement_id) do update set progress = excluded.progress, target = excluded.target,
    current_tier = excluded.current_tier, repeatable = true, source_event_id = null,
    updated_at = clock_timestamp();

  select count(*)::integer into v_active_count
  from public.progression_achievement_events u
  where u.user_id = p_user_id and u.achievement_id = 'the-comeback' and u.event_type = 'unlocked'
    and not exists (select 1 from public.progression_achievement_events r where r.user_id = u.user_id and r.reverses_event_id = u.id);
  insert into public.progression_achievement_progress(user_id, achievement_id, progress, target, current_tier, repeatable)
  values (p_user_id, 'the-comeback', v_active_count, 1, v_active_count, true)
  on conflict (user_id, achievement_id) do update set progress = excluded.progress, target = excluded.target,
    current_tier = excluded.current_tier, repeatable = true,
    source_event_id = (select u.source_event_id from public.progression_achievement_events u
      where u.user_id = p_user_id and u.achievement_id = 'the-comeback' and u.event_type = 'unlocked'
        and not exists (select 1 from public.progression_achievement_events r where r.user_id = u.user_id and r.reverses_event_id = u.id)
      order by u.recorded_at desc limit 1),
    source_date = (select u.source_date from public.progression_achievement_events u
      where u.user_id = p_user_id and u.achievement_id = 'the-comeback' and u.event_type = 'unlocked'
        and not exists (select 1 from public.progression_achievement_events r where r.user_id = u.user_id and r.reverses_event_id = u.id)
      order by u.recorded_at desc limit 1),
    updated_at = clock_timestamp();
end;
$$;
revoke all on function public.reconcile_progression_extended_achievements(uuid) from public, anon, authenticated, service_role;

-- Keep the already-deployed achievement reconciler intact and wrap it with the
-- additional deterministic rules. Existing callers resolve the wrapper by name.
alter function public.reconcile_progression_achievements(uuid) rename to reconcile_progression_achievements_base;
create function public.reconcile_progression_achievements(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.reconcile_progression_achievements_base(p_user_id);
  perform public.reconcile_progression_extended_achievements(p_user_id);
end;
$$;
revoke all on function public.reconcile_progression_achievements(uuid) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_new_badges_before_tracker_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.progression_achievement_events%rowtype;
  v_month date;
  v_reliable_start date;
  v_count integer;
begin
  if new.wins_retention <> 'delete_wins' then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text || ':progression-achievements', 11)
  );
  select greatest((a.initialized_at at time zone coalesce(s.timezone, 'UTC'))::date,
      coalesce(max((t.updated_at at time zone coalesce(s.timezone, 'UTC'))::date), (a.initialized_at at time zone coalesce(s.timezone, 'UTC'))::date))
    into v_reliable_start
  from public.progression_achievement_accounts a
  left join public.app_settings s on s.user_id = a.user_id
  left join public.trackers t on t.user_id = a.user_id and t.status in ('active', 'archived') and t.deleted_at is null
  where a.user_id = new.user_id
  group by a.initialized_at, s.timezone;

  for v_source in
    select u.* from public.progression_achievement_events u
    join public.progression_achievement_event_sources src on src.user_id = u.user_id and src.achievement_event_id = u.id
    where u.user_id = new.user_id and u.achievement_id = 'perfect-month' and u.event_type = 'unlocked'
      and src.source_tracker_id = new.tracker_id
      and not exists (select 1 from public.progression_achievement_events r where r.user_id = u.user_id and r.reverses_event_id = u.id)
      and not exists (select 1 from public.progression_retained_achievement_unlocks keep where keep.user_id = u.user_id and keep.achievement_event_id = u.id)
  loop
    v_month := (v_source.source_reference->>'month' || '-01')::date;
    if v_month < v_reliable_start or (v_month = v_reliable_start and extract(day from v_reliable_start) > 1) then
      raise exception 'Delete Wins cannot safely recalculate an earned Perfect Month after tracker schedule history changed. Choose Keep my Wins history.' using errcode = '55000';
    end if;
    if not public.progression_perfect_month_qualifies(new.user_id, v_month, new.tracker_id) then
      insert into public.progression_achievement_events(
        user_id, achievement_id, tier, generation, event_type, source_event_id, source_date,
        source_reference, idempotency_key, reverses_event_id
      ) values (
        new.user_id, v_source.achievement_id, v_source.tier, v_source.generation, 'revoked',
        v_source.source_event_id, v_source.source_date,
        jsonb_build_object('reason', 'Eligibility changed when the tracker and its Wins were deleted'),
        'revoke:' || v_source.id::text, v_source.id
      ) on conflict (user_id, idempotency_key) do nothing;
    end if;
  end loop;

  for v_source in
    select u.* from public.progression_achievement_events u
    join public.progression_achievement_event_sources src on src.user_id = u.user_id and src.achievement_event_id = u.id
    where u.user_id = new.user_id and u.achievement_id = 'the-comeback' and u.event_type = 'unlocked'
      and src.source_tracker_id = new.tracker_id
      and not exists (select 1 from public.progression_achievement_events r where r.user_id = u.user_id and r.reverses_event_id = u.id)
  loop
    insert into public.progression_achievement_events(
      user_id, achievement_id, tier, generation, event_type, source_event_id, source_date,
      source_reference, idempotency_key, reverses_event_id
    ) values (
      new.user_id, v_source.achievement_id, v_source.tier, v_source.generation, 'revoked',
      v_source.source_event_id, v_source.source_date,
      jsonb_build_object('reason', 'Tracker and its Wins were permanently deleted'),
      'revoke:' || v_source.id::text, v_source.id
    ) on conflict (user_id, idempotency_key) do nothing;
  end loop;

  select count(*)::integer into v_count
  from public.progression_achievement_events u
  where u.user_id = new.user_id and u.achievement_id = 'perfect-month' and u.event_type = 'unlocked'
    and not exists (select 1 from public.progression_achievement_events r where r.user_id = u.user_id and r.reverses_event_id = u.id);
  update public.progression_achievement_progress set progress = v_count, current_tier = v_count, updated_at = clock_timestamp()
  where user_id = new.user_id and achievement_id = 'perfect-month';
  select count(*)::integer into v_count
  from public.progression_achievement_events u
  where u.user_id = new.user_id and u.achievement_id = 'the-comeback' and u.event_type = 'unlocked'
    and not exists (select 1 from public.progression_achievement_events r where r.user_id = u.user_id and r.reverses_event_id = u.id);
  update public.progression_achievement_progress set progress = v_count, current_tier = v_count, updated_at = clock_timestamp()
  where user_id = new.user_id and achievement_id = 'the-comeback';
  return new;
end;
$$;
revoke all on function public.reconcile_progression_new_badges_before_tracker_deletion() from public, anon, authenticated, service_role;
create trigger tracker_deletion_reconcile_new_badges
before insert on public.tracker_deletion_ledger
for each row execute function public.reconcile_progression_new_badges_before_tracker_deletion();

comment on table public.progression_achievement_event_sources is
  'Private source attribution for new repeatable achievement events. Tracker identifiers are removed by tracker deletion cascades and are never exposed through the achievement read API.';
comment on function public.progression_perfect_month_qualifies(uuid, date, uuid) is
  'Checks a completed, holiday-free month against existing Perfect Day eligibility without guessing schedule history.';
comment on function public.reconcile_progression_extended_achievements(uuid) is
  'Reconciles Perfect Month and Comeback unlocks under the account achievement lock; these badges award no XP.';

commit;
