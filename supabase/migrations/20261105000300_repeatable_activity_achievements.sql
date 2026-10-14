-- Repeat activity-based achievements by stable server reward identity. Existing
-- unlocks are retained and mapped; historical activity is not backfilled.
begin;

create table public.progression_achievement_repeatable_cutover (
  id boolean primary key default true check (id),
  recorded_at timestamptz not null default statement_timestamp()
);
alter table public.progression_achievement_repeatable_cutover enable row level security;
revoke all on public.progression_achievement_repeatable_cutover from public, anon, authenticated, service_role;
insert into public.progression_achievement_repeatable_cutover(id) values (true);

alter table public.progression_achievement_progress add column qualification_details jsonb not null default '{}'::jsonb
  check (jsonb_typeof(qualification_details) = 'object');

create table public.progression_achievement_occurrences (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id text not null check (achievement_id in ('perfect-day','milestone-maker','goal-crusher')),
  occurrence_key uuid not null,
  achievement_event_id uuid not null,
  award_key uuid not null,
  source_event_id uuid,
  source_date date not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, achievement_id, occurrence_key, achievement_event_id),
  unique (user_id, achievement_id, achievement_event_id),
  foreign key (user_id, achievement_event_id)
    references public.progression_achievement_events(user_id, id) on delete cascade
);
alter table public.progression_achievement_occurrences enable row level security;
revoke all on public.progression_achievement_occurrences from public, anon, authenticated, service_role;
grant select on public.progression_achievement_occurrences to authenticated;
create policy progression_achievement_occurrences_select_own on public.progression_achievement_occurrences
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create index progression_achievement_occurrences_award_idx
  on public.progression_achievement_occurrences(user_id, achievement_id, award_key);

-- Preserve already earned badge state by mapping the original active event to
-- its existing active ledger award. No achievement event or XP row is created.
insert into public.progression_achievement_occurrences(
  user_id, achievement_id, occurrence_key, achievement_event_id, award_key, source_event_id, source_date
)
select e.user_id, e.achievement_id, s.award_key, e.id, s.award_key, e.source_event_id, coalesce(e.source_date,s.effective_date)
from public.progression_achievement_events e
join public.progression_award_state s on s.user_id=e.user_id and s.current_event_id=e.source_event_id
where e.event_type='unlocked' and e.achievement_id in ('perfect-day','milestone-maker','goal-crusher')
on conflict do nothing;

-- These rows are reconciled from individual reward source identities below.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.reconcile_progression_achievements_base(uuid)'::regprocedure);
  v_marker text;
  v_markers text[] := array[
    $m$      ('perfect-day', v_perfect_days::numeric, 1::numeric, false, 'One server-confirmed Perfect Day after achievement cutover'),$m$,
    $m$      ('milestone-maker', v_goal_milestones::numeric, 1::numeric, false, 'One server-confirmed goal milestone after achievement cutover'),$m$,
    $m$      ('goal-crusher', v_completed_goals::numeric, 1::numeric, false, 'One server-confirmed completed goal after achievement cutover'),$m$
  ];
begin
  foreach v_marker in array v_markers loop
    if pg_catalog.strpos(v_definition,v_marker)=0 then raise exception 'Expected activity badge rule missing: %',v_marker; end if;
    v_definition := pg_catalog.replace(v_definition,v_marker||E'\n','');
  end loop;
  execute v_definition;
end;
$$;

update public.progression_achievement_progress p
set repeatable=true,target=1,
  current_tier=(select count(distinct o.occurrence_key)::integer
    from public.progression_achievement_occurrences o
    join public.progression_achievement_events u on u.user_id=o.user_id and u.id=o.achievement_event_id
    where o.user_id=p.user_id and o.achievement_id=p.achievement_id and u.event_type='unlocked'
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)),
  progress=(select count(distinct o.occurrence_key)::numeric
    from public.progression_achievement_occurrences o
    join public.progression_achievement_events u on u.user_id=o.user_id and u.id=o.achievement_event_id
    where o.user_id=p.user_id and o.achievement_id=p.achievement_id and u.event_type='unlocked'
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)),
  updated_at=clock_timestamp()
where p.achievement_id in ('perfect-day','milestone-maker','goal-crusher');

create or replace function public.reconcile_progression_repeatable_achievements(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_cutover timestamptz; v_timezone text; v_cutover_date date; v_today date;
  v_item record; v_existing uuid; v_event public.progression_achievement_events%rowtype;
  v_active integer; v_generation integer; v_count integer;
  v_period record; v_date date; v_state text; v_qualifying integer; v_failed boolean; v_unsupported boolean;
  v_details jsonb; v_has_episode boolean; v_has_missed boolean;
begin
  if p_user_id is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':progression-achievements',11));
  select c.recorded_at,coalesce(s.timezone,'UTC'),(clock_timestamp() at time zone coalesce(s.timezone,'UTC'))::date
    into v_cutover,v_timezone,v_today
  from public.progression_achievement_repeatable_cutover c left join public.app_settings s on s.user_id=p_user_id where c.id;
  if not found then return; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone:='UTC'; v_today:=(clock_timestamp() at time zone 'UTC')::date;
  end if;
  v_cutover_date:=(v_cutover at time zone v_timezone)::date;

  -- Ledger award_key is the occurrence identity: date for Perfect Day, stable
  -- goal+milestone ID for Milestone Maker, and goal completion for Goal Crusher.
  for v_item in
    select s.award_key,s.reason_code,s.effective_date,s.current_event_id,
      case s.reason_code when 'PERFECT_DAY_BONUS' then 'perfect-day'
        when 'GOAL_MILESTONE' then 'milestone-maker' else 'goal-crusher' end as achievement_id
    from public.progression_award_state s join public.progression_events e on e.user_id=s.user_id and e.id=s.current_event_id
    where s.user_id=p_user_id and s.current_xp>0
      and s.reason_code in ('PERFECT_DAY_BONUS','GOAL_MILESTONE','GOAL_COMPLETED')
      and e.recorded_at>=v_cutover and s.effective_date>=v_cutover_date
    order by s.effective_date,s.award_key
  loop
    select u.id into v_existing from public.progression_achievement_occurrences o
    join public.progression_achievement_events u on u.user_id=o.user_id and u.id=o.achievement_event_id
    where o.user_id=p_user_id and o.achievement_id=v_item.achievement_id and o.occurrence_key=v_item.award_key
      and u.event_type='unlocked'
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)
    order by u.recorded_at desc limit 1;
    if v_existing is null then
      select count(distinct o.occurrence_key)::integer into v_active from public.progression_achievement_occurrences o
      join public.progression_achievement_events u on u.user_id=o.user_id and u.id=o.achievement_event_id
      where o.user_id=p_user_id and o.achievement_id=v_item.achievement_id and u.event_type='unlocked'
        and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id);
      select coalesce(max(u.generation),0)+1 into v_generation from public.progression_achievement_occurrences o
      join public.progression_achievement_events u on u.user_id=o.user_id and u.id=o.achievement_event_id
      where o.user_id=p_user_id and o.achievement_id=v_item.achievement_id and o.occurrence_key=v_item.award_key;
      insert into public.progression_achievement_events(
        user_id,achievement_id,tier,generation,event_type,source_event_id,source_date,source_reference,idempotency_key
      ) values(p_user_id,v_item.achievement_id,v_active+1,v_generation,'unlocked',v_item.current_event_id,v_item.effective_date,
        jsonb_build_object('rule','A distinct server-confirmed reward source qualified','occurrence','ledger-award'),
        'occurrence:'||v_item.achievement_id||':'||v_item.award_key::text||':'||v_generation)
      on conflict(user_id,idempotency_key) do nothing returning * into v_event;
      if v_event.id is not null then
        insert into public.progression_achievement_occurrences(user_id,achievement_id,occurrence_key,achievement_event_id,award_key,source_event_id,source_date)
        values(p_user_id,v_item.achievement_id,v_item.award_key,v_event.id,v_item.award_key,v_item.current_event_id,v_item.effective_date)
        on conflict do nothing;
      end if;
    end if;
    v_existing:=null; v_event:=null;
  end loop;

  -- A source reversal revokes its own occurrence only. Requalification may
  -- append a fresh generation for the same stable key, which counts once.
  for v_item in
    select o.*,u.id as unlock_id,u.tier,u.generation,u.source_event_id as unlock_source,u.source_date as unlock_date
    from public.progression_achievement_occurrences o
    join public.progression_achievement_events u on u.user_id=o.user_id and u.id=o.achievement_event_id
    join public.progression_award_state s on s.user_id=o.user_id and s.award_key=o.award_key
    where o.user_id=p_user_id and u.event_type='unlocked' and s.current_xp=0
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)
  loop
    insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_event_id,source_date,source_reference,idempotency_key,reverses_event_id)
    values(p_user_id,v_item.achievement_id,v_item.tier,v_item.generation,'revoked',v_item.unlock_source,v_item.unlock_date,
      jsonb_build_object('reason','The source reward was reversed'),'revoke:'||v_item.unlock_id::text,v_item.unlock_id)
    on conflict(user_id,idempotency_key) do nothing;
  end loop;
  for v_item in select unnest(array['perfect-day','milestone-maker','goal-crusher']) as achievement_id loop
    select count(distinct o.occurrence_key)::integer into v_count from public.progression_achievement_occurrences o
    join public.progression_achievement_events u on u.user_id=o.user_id and u.id=o.achievement_event_id
    where o.user_id=p_user_id and o.achievement_id=v_item.achievement_id and u.event_type='unlocked'
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id);
    update public.progression_achievement_progress set progress=v_count,target=1,current_tier=v_count,repeatable=true,
      updated_at=clock_timestamp() where user_id=p_user_id and achievement_id=v_item.achievement_id;
  end loop;

  -- Numeric period progress measures qualifying activity dates only. Failed
  -- and unsupported periods have explicit statuses and no misleading bar.
  for v_period in select * from (values
    ('perfect-week'::text,date_trunc('week',v_today::timestamp)::date,(date_trunc('week',v_today::timestamp)::date+6),3),
    ('perfect-month'::text,date_trunc('month',v_today::timestamp)::date,(date_trunc('month',v_today::timestamp)+interval '1 month-1 day')::date,12)
  ) p(achievement_id,start_date,end_date,target)
  loop
    v_qualifying:=0; v_failed:=false; v_unsupported:=false;
    select greatest((a.initialized_at at time zone v_timezone)::date,
      coalesce(max((t.updated_at at time zone v_timezone)::date),(a.initialized_at at time zone v_timezone)::date))
      into v_date from public.progression_achievement_accounts a left join public.trackers t on t.user_id=a.user_id
        and t.status in ('active','archived') and t.deleted_at is null
      where a.user_id=p_user_id group by a.initialized_at;
    if v_period.start_date<v_date then v_unsupported:=true; end if;
    if v_period.achievement_id='perfect-week' then
      select c.perfect_week_start into v_date from public.progression_policy_cutovers c where c.id;
    else
      select c.perfect_month_start into v_date from public.progression_policy_cutovers c where c.id;
    end if;
    if v_period.start_date<v_date then v_unsupported:=true; end if;
    if not v_unsupported then
      v_date:=v_period.start_date;
      while v_date<=least(v_period.end_date,v_today) loop
        v_state:=public.progression_evaluate_account_day(p_user_id,v_date);
        if v_state='unsupported' then v_unsupported:=true;
        elsif v_state='failed' then v_failed:=true;
        elsif v_state='perfect' then v_qualifying:=v_qualifying+1; end if;
        v_date:=v_date+1;
      end loop;
    end if;
    if v_unsupported then
      v_details:=jsonb_build_object('status','unavailable','label',case when v_period.achievement_id='perfect-week' then 'Current week' else 'Current month' end,
        'message','Progress is unavailable because this period lacks reliable schedule history.');
    elsif v_failed then
      v_details:=jsonb_build_object('status','ineligible','label',case when v_period.achievement_id='perfect-week' then 'Current week' else 'Current month' end,
        'message','A required opportunity did not qualify in this period. Progress starts again in the next period.');
    else
      v_details:=jsonb_build_object('status','in_progress','label',case when v_period.achievement_id='perfect-week' then 'Current week' else 'Current month' end,
        'progress',v_qualifying,'target',v_period.target,
        'message',v_qualifying::text||' of '||v_period.target::text||' qualifying activity dates so far.');
    end if;
    update public.progression_achievement_progress set qualification_details=v_details,updated_at=clock_timestamp()
    where user_id=p_user_id and achievement_id=v_period.achievement_id;
  end loop;

  -- Comeback has several linked conditions, so expose a truthful description.
  select exists(select 1 from public.progression_comeback_candidates(p_user_id,
    greatest(v_cutover_date,(select (initialized_at at time zone v_timezone)::date from public.progression_achievement_accounts where user_id=p_user_id)),v_today-1))
    into v_has_episode;
  select exists(
    with eligible as (
      select t.id tracker_id,d.day::date activity_date,
        exists(select 1 from public.tracker_entries e where e.user_id=p_user_id and e.tracker_id=t.id and e.entry_date=d.day::date and e.deleted_at is null
          and e.outcome='recorded' and public.progression_entry_qualifies(t.definition,e.entry_values,e.outcome)) qualifies,
        exists(select 1 from public.tracker_entries e where e.user_id=p_user_id and e.tracker_id=t.id and e.entry_date=d.day::date and e.deleted_at is null) has_entry
      from public.trackers t cross join lateral generate_series(v_cutover_date::timestamp,(v_today-1)::timestamp,interval '1 day') d(day)
      where t.user_id=p_user_id and t.status in ('active','archived') and t.deleted_at is null
        and public.progression_date_is_eligible(p_user_id,t,d.day::date)
    ), ordered as (select *,lag(qualifies,1,false) over(partition by tracker_id order by activity_date) prior_qualifies from eligible)
    select 1 from ordered where prior_qualifies and not qualifies and not has_entry
  ) into v_has_missed;
  if v_has_episode then
    v_details:=jsonb_build_object('status','episode_confirmed','message','A qualifying comeback episode is in your history. Another episode starts after a qualifying opportunity is followed by a genuinely missed required opportunity.');
  elsif v_has_missed then
    v_details:=jsonb_build_object('status','recovery_possible','message','A genuinely missed required opportunity followed a qualifying day. Keep qualifying on subsequent required opportunities to complete this comeback episode.');
  else
    v_details:=jsonb_build_object('status','waiting','message','A comeback episode can begin after a qualifying opportunity is followed by a genuinely missed required opportunity.');
  end if;
  update public.progression_achievement_progress set qualification_details=v_details,updated_at=clock_timestamp()
  where user_id=p_user_id and achievement_id='the-comeback';
end;
$$;
revoke all on function public.reconcile_progression_repeatable_achievements(uuid) from public,anon,authenticated,service_role;

alter function public.reconcile_progression_achievements(uuid) rename to reconcile_progression_achievements_before_occurrence_policy;
create function public.reconcile_progression_achievements(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.reconcile_progression_achievements_before_occurrence_policy(p_user_id);
  perform public.reconcile_progression_repeatable_achievements(p_user_id);
end;
$$;
revoke all on function public.reconcile_progression_achievements(uuid) from public,anon,authenticated,service_role;

create or replace function public.refresh_my_progression_qualification_progress()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform public.reconcile_progression_repeatable_achievements(auth.uid());
end;
$$;
revoke all on function public.refresh_my_progression_qualification_progress() from public,anon,authenticated,service_role;
grant execute on function public.refresh_my_progression_qualification_progress() to authenticated;

commit;
