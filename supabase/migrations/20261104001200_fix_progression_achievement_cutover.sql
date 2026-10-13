-- Fix the achievement consistency selector to use account cutover state only.
begin;
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
  perform public.initialize_progression_account(p_user_id);
  insert into public.progression_achievement_accounts(user_id,initialized_at)
    select p_user_id, initialized_at from public.progression_account_state where user_id=p_user_id
    on conflict(user_id) do nothing;
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
commit;
