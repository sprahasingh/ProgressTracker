-- Unify account-day qualification and move Perfect Week/Month to the approved
-- completed-period policy. Period awards begin only after a full post-migration
-- period, so existing history is never backfilled under a changed rule.
begin;

create table public.progression_policy_cutovers (
  id boolean primary key default true check (id),
  perfect_week_start date not null,
  perfect_month_start date not null,
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.progression_policy_cutovers enable row level security;
revoke all on public.progression_policy_cutovers from public, anon, authenticated, service_role;
insert into public.progression_policy_cutovers(id, perfect_week_start, perfect_month_start)
values (
  true,
  (date_trunc('week', current_date::timestamp)::date + 7),
  (date_trunc('month', current_date::timestamp) + interval '1 month')::date
);

create or replace function public.progression_evaluate_account_day(
  p_user_id uuid, p_date date, p_excluded_tracker_id uuid default null
)
returns text
language plpgsql
stable
security definer
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
  select coalesce(s.timezone, 'UTC'),
      (clock_timestamp() at time zone coalesce(s.timezone, 'UTC'))::date,
      (a.initialized_at at time zone coalesce(s.timezone, 'UTC'))::date
    into v_timezone, v_today, v_cutover
  from public.progression_achievement_accounts a
  left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if not found then return 'unsupported'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC';
    v_today := (clock_timestamp() at time zone 'UTC')::date;
    select (a.initialized_at at time zone 'UTC')::date into v_cutover
      from public.progression_achievement_accounts a where a.user_id = p_user_id;
  end if;
  if p_date > v_today then return 'future'; end if;
  select greatest(v_cutover, coalesce(max((t.updated_at at time zone v_timezone)::date), v_cutover))
    into v_definition_boundary
  from public.trackers t
  where t.user_id = p_user_id and t.status in ('active', 'archived') and t.deleted_at is null;
  if p_date < v_definition_boundary then return 'unsupported'; end if;

  select count(*)::integer,
      count(*) filter (where e.id is not null and e.deleted_at is null
        and e.outcome = 'recorded'
        and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome))::integer,
      count(*) filter (where e.outcome = 'skipped' or (e.id is not null and e.deleted_at is null
        and not public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome) and p_date < v_today)
        or (e.id is null and p_date < v_today))::integer,
      count(*) filter (where p_date = v_today and (e.id is null or (e.outcome = 'recorded'
        and not public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome))))::integer
    into v_required, v_qualified, v_failed, v_pending
  from public.trackers t
  left join public.tracker_entries e
    on e.user_id = t.user_id and e.tracker_id = t.id and e.entry_date = p_date and e.deleted_at is null
  where t.user_id = p_user_id and t.id is distinct from p_excluded_tracker_id
    and t.status in ('active', 'archived') and t.deleted_at is null
    and (t.status <> 'archived' or t.definition->>'archivedAt' is null
      or p_date <= pg_catalog.left(t.definition->>'archivedAt', 10)::date)
    and public.progression_date_is_eligible(p_user_id, t, p_date);

  if coalesce(v_required, 0) = 0 then return 'neutral'; end if;
  if coalesce(v_failed, 0) > 0 then return 'failed'; end if;
  if coalesce(v_pending, 0) > 0 then return 'pending'; end if;
  if v_qualified = v_required then return 'perfect'; end if;
  return 'failed';
end;
$$;
revoke all on function public.progression_evaluate_account_day(uuid, date, uuid) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_perfect_day(p_user_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_cutover_at timestamptz;
  v_state text;
  v_key uuid;
begin
  if p_user_id is null or p_date is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':progression-perfect-day:' || p_date::text, 5)
  );
  select coalesce(s.timezone, 'UTC'), a.initialized_at
    into v_timezone, v_cutover_at
  from public.progression_account_state a
  left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if not found then return; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then v_timezone := 'UTC'; end if;
  v_today := (clock_timestamp() at time zone v_timezone)::date;
  if p_date > v_today or p_date < (v_cutover_at at time zone v_timezone)::date then return; end if;
  v_state := public.progression_evaluate_account_day(p_user_id, p_date);
  v_key := md5(p_user_id::text || ':perfect-day:' || p_date::text)::uuid;
  perform public.reconcile_progression_award(
    p_user_id, v_key, 'PERFECT_DAY_BONUS', p_date, 20, null, null, null,
    v_state = 'perfect', 'Every required tracker qualified on this date'
  );
end;
$$;
revoke all on function public.reconcile_progression_perfect_day(uuid, date) from public, anon, authenticated, service_role;

-- Preserve the old month rule for already-earned months. Only complete months
-- beginning at the stored policy cutover use the new 12-required-date rule.
alter function public.progression_perfect_month_qualifies(uuid, date, uuid)
  rename to progression_perfect_month_qualifies_legacy;
create function public.progression_perfect_month_qualifies(
  p_user_id uuid, p_month_start date, p_excluded_tracker_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month_end date;
  v_today date;
  v_timezone text;
  v_policy_start date;
  v_state text;
  v_required_dates integer := 0;
  v_event_exists boolean;
  v_day date;
begin
  if p_user_id is null or p_month_start is null
    or p_month_start <> date_trunc('month', p_month_start::timestamp)::date then return false; end if;
  select c.perfect_month_start into v_policy_start from public.progression_policy_cutovers c where c.id;
  select coalesce(s.timezone, 'UTC'), (clock_timestamp() at time zone coalesce(s.timezone, 'UTC'))::date
    into v_timezone, v_today
  from public.progression_achievement_accounts a left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if not found then return false; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC'; v_today := (clock_timestamp() at time zone 'UTC')::date;
  end if;
  v_month_end := (p_month_start + interval '1 month' - interval '1 day')::date;
  if v_month_end >= v_today then return false; end if;

  if p_month_start < v_policy_start then
    select exists (select 1 from public.progression_achievement_events e
      where e.user_id = p_user_id and e.achievement_id = 'perfect-month' and e.event_type = 'unlocked'
        and e.source_reference->>'month' = to_char(p_month_start, 'YYYY-MM')) into v_event_exists;
    return v_event_exists and public.progression_perfect_month_qualifies_legacy(p_user_id, p_month_start, p_excluded_tracker_id);
  end if;

  v_day := p_month_start;
  while v_day <= v_month_end loop
    v_state := public.progression_evaluate_account_day(p_user_id, v_day, p_excluded_tracker_id);
    if v_state = 'unsupported' or v_state = 'failed' or v_state = 'pending' then return false; end if;
    if v_state = 'perfect' then v_required_dates := v_required_dates + 1; end if;
    v_day := v_day + 1;
  end loop;
  return v_required_dates >= 12;
end;
$$;
revoke all on function public.progression_perfect_month_qualifies(uuid, date, uuid) from public, anon, authenticated, service_role;

create or replace function public.progression_perfect_week_qualifies(
  p_user_id uuid, p_week_start date, p_excluded_tracker_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_timezone text;
  v_policy_start date;
  v_date date;
  v_state text;
  v_required_dates integer := 0;
begin
  if p_user_id is null or p_week_start is null
    or p_week_start <> date_trunc('week', p_week_start::timestamp)::date then return false; end if;
  select c.perfect_week_start into v_policy_start from public.progression_policy_cutovers c where c.id;
  select coalesce(s.timezone, 'UTC'), (clock_timestamp() at time zone coalesce(s.timezone, 'UTC'))::date
    into v_timezone, v_today
  from public.progression_achievement_accounts a left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if not found or p_week_start < v_policy_start then return false; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC'; v_today := (clock_timestamp() at time zone 'UTC')::date;
  end if;
  if p_week_start + 6 >= v_today then return false; end if;
  v_date := p_week_start;
  while v_date <= p_week_start + 6 loop
    v_state := public.progression_evaluate_account_day(p_user_id, v_date, p_excluded_tracker_id);
    if v_state = 'unsupported' or v_state = 'failed' or v_state = 'pending' then return false; end if;
    if v_state = 'perfect' then v_required_dates := v_required_dates + 1; end if;
    v_date := v_date + 1;
  end loop;
  return v_required_dates >= 3;
end;
$$;
revoke all on function public.progression_perfect_week_qualifies(uuid, date, uuid) from public, anon, authenticated, service_role;

-- The previous reconciler treated Perfect Week as a single seven-Perfect-Day
-- badge. Remove just that definition from its preserved base implementation;
-- the new period reconciler below owns this badge after the policy cutover.
-- New Perfect Month history records the rule actually enforced by the
-- post-cutover qualifier. Existing historical events are left untouched.
do $$
declare
  v_definition text;
  v_old text := $old$'Every calendar date had eligible trackers, all qualified, and the month had no account-wide holidays'$old$;
  v_new text := $new$'Every required date qualified on at least twelve distinct dates in this completed calendar month'$new$;
begin
  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_extended_achievements(uuid)'::regprocedure);
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected legacy Perfect Month rule label was not found in the existing reconciler';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

do $$
declare
  v_definition text;
  v_marker text := $marker$      ('perfect-week', v_perfect_weeks::numeric, 1::numeric, false, 'Seven server-confirmed Perfect Days in one calendar week'),$marker$;
begin
  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_achievements_base(uuid)'::regprocedure);
  if pg_catalog.strpos(v_definition, v_marker) = 0 then
    raise exception 'Expected Perfect Week definition was not found in the existing reconciler';
  end if;
  execute pg_catalog.replace(v_definition, v_marker, '');
end;
$$;

update public.progression_achievement_progress
set target = 1, repeatable = true, updated_at = clock_timestamp()
where achievement_id = 'perfect-week';

create or replace function public.reconcile_progression_perfect_weeks(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy_start date;
  v_reliable_start date;
  v_today date;
  v_timezone text;
  v_week date;
  v_week_end date;
  v_event public.progression_achievement_events%rowtype;
  v_new public.progression_achievement_events%rowtype;
  v_tier integer;
  v_generation integer;
begin
  if p_user_id is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-achievements', 11));
  select c.perfect_week_start, coalesce(s.timezone, 'UTC'),
      (clock_timestamp() at time zone coalesce(s.timezone, 'UTC'))::date,
      greatest((a.initialized_at at time zone coalesce(s.timezone, 'UTC'))::date,
        coalesce(max((t.updated_at at time zone coalesce(s.timezone, 'UTC'))::date), (a.initialized_at at time zone coalesce(s.timezone, 'UTC'))::date))
    into v_policy_start, v_timezone, v_today, v_reliable_start
  from public.progression_achievement_accounts a
  cross join public.progression_policy_cutovers c
  left join public.app_settings s on s.user_id = a.user_id
  left join public.trackers t on t.user_id = a.user_id and t.status in ('active', 'archived') and t.deleted_at is null
  where a.user_id = p_user_id and c.id
  group by c.perfect_week_start, a.initialized_at, s.timezone;
  if not found then return; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC'; v_today := (clock_timestamp() at time zone 'UTC')::date;
  end if;
  v_reliable_start := greatest(v_policy_start, v_reliable_start);

  for v_event in
    select u.* from public.progression_achievement_events u
    where u.user_id = p_user_id and u.achievement_id = 'perfect-week' and u.event_type = 'unlocked'
      and u.source_reference->>'week' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and (u.source_reference->>'week')::date >= v_reliable_start
      and not exists (select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)
      and not exists (select 1 from public.progression_retained_achievement_unlocks k where k.user_id=u.user_id and k.achievement_event_id=u.id)
  loop
    v_week := (v_event.source_reference->>'week')::date;
    if not public.progression_perfect_week_qualifies(p_user_id, v_week) then
      insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_event_id,source_date,source_reference,idempotency_key,reverses_event_id)
      values(p_user_id,'perfect-week',v_event.tier,v_event.generation,'revoked',v_event.source_event_id,v_event.source_date,
        jsonb_build_object('reason','A historical correction changed this completed week'), 'revoke:'||v_event.id::text,v_event.id)
      on conflict(user_id,idempotency_key) do nothing;
      delete from public.progression_achievement_event_sources s where s.user_id=p_user_id and s.achievement_event_id=v_event.id;
    end if;
  end loop;

  for v_week in
    select w.week_start::date from pg_catalog.generate_series(
      date_trunc('week', v_reliable_start::timestamp), date_trunc('week', (v_today - 7)::timestamp), interval '1 week'
    ) w(week_start)
    where w.week_start::date >= v_reliable_start and w.week_start::date >= v_policy_start
    order by w.week_start
  loop
    if not public.progression_perfect_week_qualifies(p_user_id, v_week) then continue; end if;
    select u.* into v_event from public.progression_achievement_events u
    where u.user_id=p_user_id and u.achievement_id='perfect-week' and u.event_type='unlocked'
      and u.source_reference->>'week'=v_week::text
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)
    order by u.recorded_at desc limit 1;
    if v_event.id is null then
      select count(*)::integer into v_tier from public.progression_achievement_events u
      where u.user_id=p_user_id and u.achievement_id='perfect-week' and u.event_type='unlocked'
        and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id);
      select coalesce(max(generation),0)+1 into v_generation from public.progression_achievement_events u
      where u.user_id=p_user_id and u.achievement_id='perfect-week' and u.source_reference->>'week'=v_week::text;
      v_week_end := v_week + 6;
      insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_date,source_reference,idempotency_key)
      values(p_user_id,'perfect-week',v_tier+1,v_generation,'unlocked',v_week_end,
        jsonb_build_object('rule','Every required opportunity qualified on at least three dates in this completed calendar week','week',v_week::text),
        'perfect-week:'||v_week::text||':unlock:'||v_generation)
      on conflict(user_id,idempotency_key) do nothing returning * into v_new;
      if v_new.id is not null then v_event := v_new; end if;
    end if;
    if v_event.id is not null then
      delete from public.progression_achievement_event_sources s where s.user_id=p_user_id and s.achievement_event_id=v_event.id;
      insert into public.progression_achievement_event_sources(user_id,achievement_event_id,source_tracker_id,source_key)
      select p_user_id,v_event.id,t.id,'perfect-week:'||v_week::text
      from public.trackers t
      where t.user_id=p_user_id and t.status in ('active','archived') and t.deleted_at is null
        and exists(select 1 from generate_series(v_week::timestamp,(v_week+6)::timestamp,interval '1 day') d(day)
          where public.progression_date_is_eligible(p_user_id,t,d.day::date))
      on conflict do nothing;
      v_event := null;
    end if;
  end loop;

  select count(*)::integer into v_tier from public.progression_achievement_events u
  where u.user_id=p_user_id and u.achievement_id='perfect-week' and u.event_type='unlocked'
    and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id);
  insert into public.progression_achievement_progress(user_id,achievement_id,progress,target,current_tier,repeatable)
  values(p_user_id,'perfect-week',v_tier,1,v_tier,true)
  on conflict(user_id,achievement_id) do update set progress=excluded.progress,target=1,current_tier=excluded.current_tier,
    repeatable=true,source_event_id=null,source_date=(select max(u.source_date) from public.progression_achievement_events u
      where u.user_id=p_user_id and u.achievement_id='perfect-week' and u.event_type='unlocked'
        and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)),
    updated_at=clock_timestamp();
end;
$$;
revoke all on function public.reconcile_progression_perfect_weeks(uuid) from public, anon, authenticated, service_role;

-- Add repeatable Perfect Week reconciliation after the existing achievement
-- and Perfect Month reconciliations. The account lock is shared by all three.
alter function public.reconcile_progression_achievements(uuid)
  rename to reconcile_progression_achievements_before_week_policy;
create function public.reconcile_progression_achievements(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.reconcile_progression_achievements_before_week_policy(p_user_id);
  perform public.reconcile_progression_perfect_weeks(p_user_id);
end;
$$;
revoke all on function public.reconcile_progression_achievements(uuid) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_perfect_week_before_tracker_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.progression_achievement_events%rowtype;
  v_week date;
  v_active integer;
begin
  if new.wins_retention <> 'delete_wins' then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text || ':progression-achievements', 11));
  for v_event in
    select u.* from public.progression_achievement_events u
    join public.progression_achievement_event_sources s on s.user_id=u.user_id and s.achievement_event_id=u.id
    where u.user_id=new.user_id and u.achievement_id='perfect-week' and u.event_type='unlocked'
      and s.source_tracker_id=new.tracker_id and u.source_reference->>'week' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)
      and not exists(select 1 from public.progression_retained_achievement_unlocks k where k.user_id=u.user_id and k.achievement_event_id=u.id)
  loop
    v_week := (v_event.source_reference->>'week')::date;
    if not public.progression_perfect_week_qualifies(new.user_id,v_week,new.tracker_id) then
      insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_event_id,source_date,source_reference,idempotency_key,reverses_event_id)
      values(new.user_id,v_event.achievement_id,v_event.tier,v_event.generation,'revoked',v_event.source_event_id,v_event.source_date,
        jsonb_build_object('reason','The remaining required trackers no longer qualify after Delete Tracker and Wins'),
        'revoke:'||v_event.id::text,v_event.id) on conflict(user_id,idempotency_key) do nothing;
    end if;
  end loop;
  select count(*)::integer into v_active from public.progression_achievement_events u
  where u.user_id=new.user_id and u.achievement_id='perfect-week' and u.event_type='unlocked'
    and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id);
  update public.progression_achievement_progress set progress=v_active,current_tier=v_active,repeatable=true,target=1,updated_at=clock_timestamp()
  where user_id=new.user_id and achievement_id='perfect-week';
  return new;
end;
$$;
revoke all on function public.reconcile_progression_perfect_week_before_tracker_deletion() from public, anon, authenticated, service_role;
create trigger tracker_deletion_reconcile_perfect_week
before insert on public.tracker_deletion_ledger
for each row execute function public.reconcile_progression_perfect_week_before_tracker_deletion();

comment on function public.progression_evaluate_account_day(uuid,date,uuid) is
  'Shared authoritative account-day outcome: perfect, failed, pending, neutral, future, or unsupported; respects strict/standard date eligibility and never treats an unresolved current day as failed.';
comment on function public.progression_perfect_week_qualifies(uuid,date,uuid) is
  'Qualifies a completed Monday-based week with at least three distinct required dates and no failed or unsupported required opportunity.';
comment on function public.progression_perfect_month_qualifies(uuid,date,uuid) is
  'Uses the pre-migration rule for already-earned months; post-cutover months need twelve distinct required dates, no failed opportunities, and a completed calendar month.';

commit;
