-- Persist server-derived badge progress and append-only unlock/revocation history.
-- Historical opening XP is deliberately excluded by recording an achievement cutover.
begin;

create table public.progression_achievement_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  initialized_at timestamptz not null default clock_timestamp()
);
alter table public.progression_achievement_accounts enable row level security;
revoke all on public.progression_achievement_accounts from public, anon, authenticated, service_role;

-- Existing accounts are initialized by the bounded progression batch.
-- New accounts use the auth-user trigger below.

create table public.progression_achievement_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id text not null,
  progress numeric not null check (progress >= 0),
  target numeric not null check (target > 0),
  current_tier integer not null default 0 check (current_tier >= 0),
  repeatable boolean not null default false,
  source_event_id uuid,
  source_date date,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, achievement_id)
);
alter table public.progression_achievement_progress enable row level security;
revoke all on public.progression_achievement_progress from public, anon, authenticated, service_role;
grant select on public.progression_achievement_progress to authenticated;
create policy progression_achievement_progress_select_own on public.progression_achievement_progress
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create table public.progression_achievement_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id text not null,
  tier integer not null check (tier > 0),
  generation integer not null check (generation > 0),
  event_type text not null check (event_type in ('unlocked', 'revoked')),
  recorded_at timestamptz not null default clock_timestamp(),
  source_event_id uuid,
  source_date date,
  source_reference jsonb not null default '{}'::jsonb check (jsonb_typeof(source_reference) = 'object'),
  idempotency_key text not null,
  reverses_event_id uuid,
  unique (user_id, id),
  unique (user_id, idempotency_key),
  foreign key (user_id, reverses_event_id)
    references public.progression_achievement_events(user_id, id) on delete cascade,
  check ((event_type = 'revoked' and reverses_event_id is not null) or (event_type = 'unlocked' and reverses_event_id is null))
);
create index progression_achievement_events_user_recorded_idx
  on public.progression_achievement_events(user_id, recorded_at desc, id desc);
create index progression_achievement_events_user_badge_idx
  on public.progression_achievement_events(user_id, achievement_id, tier, recorded_at desc);
alter table public.progression_achievement_events enable row level security;
revoke all on public.progression_achievement_events from public, anon, authenticated, service_role;
grant select on public.progression_achievement_events to authenticated;
create policy progression_achievement_events_select_own on public.progression_achievement_events
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create or replace function public.reconcile_progression_achievements(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutover timestamptz;
  v_timezone text;
  v_today date;
  v_start_date date;
  v_qualifying integer := 0;
  v_longest integer := 0;
  v_perfect_days integer := 0;
  v_perfect_weeks integer := 0;
  v_goal_milestones integer := 0;
  v_completed_goals integer := 0;
  v_consistency numeric;
  v_consistency_days integer := 0;
  v_record record;
  v_tier integer;
  v_generation integer;
  v_unlock_generation integer;
  v_unlock public.progression_achievement_events%rowtype;
  v_event public.progression_achievement_events%rowtype;
  v_source_event uuid;
  v_source_date date;
  v_source_reference jsonb;
begin
  if p_user_id is null or not exists(select 1 from auth.users where id = p_user_id) then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-achievements', 11));
  select initialized_at into v_cutover from public.progression_achievement_accounts where user_id = p_user_id;
  if v_cutover is null then return; end if;
  select coalesce(timezone, 'UTC') into v_timezone from public.app_settings where user_id = p_user_id;
  v_timezone := coalesce(v_timezone, 'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then v_timezone := 'UTC'; end if;
  v_today := (clock_timestamp() at time zone v_timezone)::date;
  select greatest((v_cutover at time zone v_timezone)::date,
      coalesce(max(t.updated_at at time zone v_timezone)::date, (v_cutover at time zone v_timezone)::date))
    into v_start_date
    from public.trackers t where t.user_id = p_user_id and t.status in ('active','archived') and t.deleted_at is null;

  select count(*)::integer into v_qualifying
  from public.progression_award_state s
  join public.progression_events e on e.user_id = s.user_id and e.id = s.current_event_id
  where s.user_id = p_user_id and s.reason_code = 'DAILY_CHECK_IN_COMPLETED'
    and s.current_xp > 0 and e.recorded_at >= v_cutover;

  with eligible_days as (
    select t.id as tracker_id, d.day::date as activity_date,
      exists(select 1 from public.tracker_entries e
        where e.user_id = p_user_id and e.tracker_id = t.id and e.entry_date = d.day::date
          and e.deleted_at is null and e.server_changed_at >= v_cutover
          and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome)) as qualifies
    from public.trackers t
    cross join lateral generate_series(v_start_date::timestamp, v_today::timestamp, interval '1 day') d(day)
    where t.user_id = p_user_id and t.status in ('active','archived') and t.deleted_at is null
      and public.progression_date_is_eligible(p_user_id, t, d.day::date)
  ), streak_groups as (
    select tracker_id, activity_date, qualifies,
      sum(case when qualifies then 0 else 1 end) over(partition by tracker_id order by activity_date) as run_group
    from eligible_days
  ), streak_runs as (
    select tracker_id, run_group, count(*) filter(where qualifies)::integer as run_length
    from streak_groups group by tracker_id, run_group
  )
  select coalesce(max(run_length), 0) into v_longest from streak_runs;

  select count(*)::integer into v_perfect_days
  from public.progression_award_state s
  join public.progression_events e on e.user_id=s.user_id and e.id=s.current_event_id
  where s.user_id=p_user_id and s.reason_code='PERFECT_DAY_BONUS' and s.current_xp>0 and e.recorded_at>=v_cutover;

  select count(*)::integer into v_perfect_weeks from (
    select date_trunc('week', s.effective_date)::date as week_start
    from public.progression_award_state s
    join public.progression_events e on e.user_id=s.user_id and e.id=s.current_event_id
    where s.user_id=p_user_id and s.reason_code='PERFECT_DAY_BONUS' and s.current_xp>0 and e.recorded_at>=v_cutover
    group by date_trunc('week', s.effective_date)::date
    having count(distinct s.effective_date) >= 7
  ) weeks;

  select count(*) filter(where s.reason_code='GOAL_MILESTONE')::integer,
      count(*) filter(where s.reason_code='GOAL_COMPLETED')::integer
    into v_goal_milestones, v_completed_goals
    from public.progression_award_state s
    join public.progression_events e on e.user_id=s.user_id and e.id=s.current_event_id
    where s.user_id=p_user_id and s.current_xp>0 and e.recorded_at>=v_cutover;

  with dates as (
    select d.day::date as activity_date from generate_series(v_start_date::timestamp,
      (v_today - 1)::timestamp, interval '1 day') d(day)
  ), daily as (
    select d.activity_date,
      count(t.id)::integer as eligible_count,
      count(t.id) filter(where exists(select 1 from public.tracker_entries e
        where e.user_id=p_user_id and e.tracker_id=t.id and e.entry_date=d.activity_date
          and e.deleted_at is null and e.server_changed_at>=v_cutover
          and public.progression_entry_qualifies(t.definition,e.entry_values,e.outcome)))::integer as completed_count
    from dates d
    left join public.trackers t on t.user_id=p_user_id and t.status='active' and t.deleted_at is null
      and public.progression_date_is_eligible(p_user_id,t,d.activity_date)
    group by d.activity_date
  ), recent as (
    select completed_count::numeric / eligible_count::numeric as adherence
    from daily where eligible_count>0 order by activity_date desc limit 30
  )
  select avg(adherence)*100, count(*)::integer into v_consistency, v_consistency_days from recent;

  for v_record in
    select * from (values
      ('first-step', v_qualifying::numeric, 1::numeric, false, 'First qualifying saved check-in'),
      ('momentum', v_longest::numeric, 3::numeric, false, 'Three-day qualifying streak after achievement cutover'),
      ('first-flame', v_longest::numeric, 7::numeric, false, 'Seven-day qualifying streak after achievement cutover'),
      ('steady-flame', v_longest::numeric, 14::numeric, false, 'Fourteen-day qualifying streak after achievement cutover'),
      ('unstoppable', v_longest::numeric, 30::numeric, false, 'Thirty-day qualifying streak after achievement cutover'),
      ('century', v_longest::numeric, 100::numeric, false, 'One-hundred-day qualifying streak after achievement cutover'),
      ('perfect-day', v_perfect_days::numeric, 1::numeric, false, 'One server-confirmed Perfect Day after achievement cutover'),
      ('perfect-week', v_perfect_weeks::numeric, 1::numeric, false, 'Seven server-confirmed Perfect Days in one calendar week'),
      ('milestone-maker', v_goal_milestones::numeric, 1::numeric, false, 'One server-confirmed goal milestone after achievement cutover'),
      ('goal-crusher', v_completed_goals::numeric, 1::numeric, false, 'One server-confirmed completed goal after achievement cutover'),
      ('consistency-star', coalesce(v_consistency,0), 80::numeric, false, 'At least 80 percent adherence across 30 completed eligible days'),
      ('dedicated', v_qualifying::numeric, 100::numeric, true, 'Each additional 100 server-confirmed qualifying check-ins')
    ) as definitions(achievement_id, progress, target, repeatable, description)
  loop
    v_tier := case when v_record.repeatable then floor(v_record.progress / v_record.target)::integer
      when v_record.progress >= v_record.target then 1 else 0 end;
    v_source_event := null;
    v_source_date := null;
    v_source_reference := jsonb_build_object('rule', v_record.description);
    if v_record.achievement_id in ('first-step','dedicated') then
      select e.id, e.effective_date into v_source_event,v_source_date
      from public.progression_award_state s
      join public.progression_events e on e.user_id=s.user_id and e.id=s.current_event_id
      where s.user_id=p_user_id and s.reason_code='DAILY_CHECK_IN_COMPLETED' and s.current_xp>0 and e.recorded_at>=v_cutover
      order by e.effective_date,e.recorded_at,e.id limit 1;
    elsif v_record.achievement_id='perfect-day' then
      select e.id,e.effective_date into v_source_event,v_source_date from public.progression_award_state s
      join public.progression_events e on e.user_id=s.user_id and e.id=s.current_event_id
      where s.user_id=p_user_id and s.reason_code='PERFECT_DAY_BONUS' and s.current_xp>0 and e.recorded_at>=v_cutover
      order by e.effective_date,e.id limit 1;
    elsif v_record.achievement_id in ('milestone-maker','goal-crusher') then
      select e.id,e.effective_date into v_source_event,v_source_date from public.progression_award_state s
      join public.progression_events e on e.user_id=s.user_id and e.id=s.current_event_id
      where s.user_id=p_user_id and s.reason_code=case when v_record.achievement_id='milestone-maker' then 'GOAL_MILESTONE' else 'GOAL_COMPLETED' end
        and s.current_xp>0 and e.recorded_at>=v_cutover order by e.effective_date,e.id limit 1;
    elsif v_record.achievement_id='consistency-star' then
      select max(e.entry_date) into v_source_date from public.tracker_entries e
      where e.user_id=p_user_id and e.deleted_at is null and e.server_changed_at>=v_cutover and e.entry_date<v_today;
      v_source_reference := jsonb_build_object('rule',v_record.description,'eligible_days',v_consistency_days);
    end if;

    insert into public.progression_achievement_progress(user_id,achievement_id,progress,target,current_tier,repeatable,source_event_id,source_date)
    values(p_user_id,v_record.achievement_id,v_record.progress,v_record.target,v_tier,v_record.repeatable,v_source_event,v_source_date)
    on conflict(user_id,achievement_id) do update set progress=excluded.progress,target=excluded.target,
      current_tier=excluded.current_tier,repeatable=excluded.repeatable,source_event_id=excluded.source_event_id,
      source_date=excluded.source_date,updated_at=clock_timestamp();

    for v_generation in 1..greatest(v_tier, (select coalesce(max(tier),0) from public.progression_achievement_events x where x.user_id=p_user_id and x.achievement_id=v_record.achievement_id and x.event_type='unlocked')) loop
      select u.* into v_unlock from public.progression_achievement_events u
      where u.user_id=p_user_id and u.achievement_id=v_record.achievement_id and u.tier=v_generation
        and u.event_type='unlocked'
        and not exists(select 1 from public.progression_achievement_events revocation
          where revocation.user_id=u.user_id and revocation.reverses_event_id=u.id)
      order by u.recorded_at desc limit 1;
      if v_generation<=v_tier and v_unlock.id is null then
        if v_record.achievement_id='dedicated' then
          select e.id,e.effective_date into v_source_event,v_source_date
          from public.progression_award_state s
          join public.progression_events e on e.user_id=s.user_id and e.id=s.current_event_id
          where s.user_id=p_user_id and s.reason_code='DAILY_CHECK_IN_COMPLETED' and s.current_xp>0 and e.recorded_at>=v_cutover
          order by e.effective_date,e.recorded_at,e.id
          offset ((v_generation*v_record.target)::integer - 1) limit 1;
        end if;
        select coalesce(max(generation),0)+1 into v_unlock_generation
        from public.progression_achievement_events x
        where x.user_id=p_user_id and x.achievement_id=v_record.achievement_id and x.tier=v_generation and x.event_type='unlocked';
        insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_event_id,source_date,source_reference,idempotency_key)
        values(p_user_id,v_record.achievement_id,v_generation,v_unlock_generation,'unlocked',v_source_event,v_source_date,v_source_reference,
          'unlock:'||v_record.achievement_id||':'||v_generation||':'||v_unlock_generation)
        on conflict(user_id,idempotency_key) do nothing;
      end if;
      v_unlock := null;
    end loop;

    for v_unlock in select u.* from public.progression_achievement_events u
      where u.user_id=p_user_id and u.achievement_id=v_record.achievement_id and u.event_type='unlocked'
        and u.tier>v_tier
        and not exists(select 1 from public.progression_achievement_events revocation where revocation.user_id=u.user_id and revocation.reverses_event_id=u.id)
    loop
      insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_event_id,source_date,source_reference,idempotency_key,reverses_event_id)
      values(p_user_id,v_record.achievement_id,v_unlock.tier,v_unlock.generation,'revoked',v_unlock.source_event_id,v_unlock.source_date,
        jsonb_build_object('reason','Eligibility no longer holds after an accepted historical correction'),
        'revoke:'||v_unlock.id::text,v_unlock.id)
      on conflict(user_id,idempotency_key) do nothing;
    end loop;
  end loop;
end;
$$;
revoke all on function public.reconcile_progression_achievements(uuid) from public,anon,authenticated,service_role;

create or replace function public.reconcile_progression_achievements_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then perform public.reconcile_progression_achievements(old.user_id); end if;
  if tg_op <> 'DELETE' and (tg_op <> 'UPDATE' or old.user_id is distinct from new.user_id) then
    perform public.reconcile_progression_achievements(new.user_id);
  elsif tg_op = 'INSERT' then
    perform public.reconcile_progression_achievements(new.user_id);
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.reconcile_progression_achievements_trigger() from public,anon,authenticated,service_role;

create trigger z_progression_achievement_tracker_change after insert or update or delete on public.trackers
  for each row execute function public.reconcile_progression_achievements_trigger();
create trigger z_progression_achievement_entry_change after insert or update or delete on public.tracker_entries
  for each row execute function public.reconcile_progression_achievements_trigger();

create or replace function public.initialize_progression_achievement_account_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.progression_achievement_accounts(user_id) values(new.id) on conflict(user_id) do nothing;
  perform public.reconcile_progression_achievements(new.id);
  return new;
end;
$$;
revoke all on function public.initialize_progression_achievement_account_trigger() from public,anon,authenticated,service_role;
create trigger z_progression_achievement_account_initialization after insert on auth.users
  for each row execute function public.initialize_progression_achievement_account_trigger();


commit;
