-- Forward-only correction after reviewing historical and same-day cutover cases.
begin;
alter table public.progression_account_state drop constraint if exists progression_account_state_legacy_xp_kind_check;
alter table public.progression_account_state add constraint progression_account_state_legacy_xp_kind_check
  check (legacy_xp_kind in ('reconstructed','legacy_fallback','unavailable','new_account'));
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
  v_created_at timestamptz;
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
  select created_at into v_created_at from auth.users where id=p_user_id;
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
  ), eligible_dates as (
    select t.id as tracker_id, days.activity_at::date as activity_date,
      coalesce(e.deleted_at is null and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome), false) as qualifies
    from retained_trackers t
    cross join lateral generate_series(
      greatest(coalesce((t.definition->>'startDate')::date, (t.created_at at time zone v_timezone)::date), (t.created_at at time zone v_timezone)::date)::timestamp,
      v_today::timestamp,
      interval '1 day'
    ) as days(activity_at)
    left join public.tracker_entries e on e.user_id = t.user_id and e.tracker_id = t.id and e.entry_date = days.activity_at::date
      and e.deleted_at is null and e.server_changed_at < v_initialized_at
    where public.progression_date_is_eligible(p_user_id, t, days.activity_at::date)
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
    join public.tracker_entries e on e.user_id = t.user_id and e.tracker_id = t.id
      and e.deleted_at is null and e.entry_date <= v_today and e.server_changed_at < v_initialized_at
    where public.progression_date_is_eligible(p_user_id, t, e.entry_date)
      and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome)
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
    v_legacy_xp_kind := case when v_created_at >= v_initialized_at - interval '1 minute' then 'new_account' else 'unavailable' end;
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

  insert into public.progression_account_state(user_id, initialized_at, scoring_version, legacy_xp_kind)
  values (p_user_id, v_initialized_at, 1, v_legacy_xp_kind)
  on conflict (user_id) do nothing;
end;
$$;
revoke all on function public.initialize_progression_account(uuid) from public, anon, authenticated, service_role;

create or replace function public.record_progression_entry_award(
  p_user_id uuid, p_tracker_id uuid, p_entry_id uuid, p_entry_date date,
  p_values jsonb, p_outcome text, p_deleted_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers%rowtype;
  v_key uuid := md5(p_user_id::text || ':' || p_entry_id::text || ':daily-check-in-v1')::uuid;
  v_event public.progression_events%rowtype;
  v_state public.progression_award_state%rowtype;
  v_qualifies boolean := false;
  v_generation integer;
  v_event_key uuid;
  v_delta integer;
  v_cutover timestamptz;
  v_timezone text := 'UTC';
  v_historic boolean := false;
begin
  if p_user_id is null or p_tracker_id is null or p_entry_id is null or p_entry_date is null then return; end if;
  perform public.initialize_progression_account(p_user_id);
  select initialized_at into v_cutover from public.progression_account_state where user_id=p_user_id;
  select coalesce(timezone,'UTC') into v_timezone from public.app_settings where user_id=p_user_id;
  v_timezone:=coalesce(v_timezone,'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone:='UTC'; end if;
  v_historic := p_entry_date < (v_cutover at time zone v_timezone)::date;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-entry:' || p_entry_id::text, 2));
  select * into v_tracker from public.trackers where user_id = p_user_id and id = p_tracker_id;
  if not found then return; end if;
  v_qualifies := p_deleted_at is null
    and public.progression_date_is_eligible(p_user_id, v_tracker, p_entry_date)
    and public.progression_entry_qualifies(v_tracker.definition, p_values, p_outcome);

  select * into v_state from public.progression_award_state
  where user_id = p_user_id and award_key = v_key for update;
  if not found then
    select * into v_event from public.progression_events
    where user_id = p_user_id and idempotency_key = v_key;
    if found then
      insert into public.progression_award_state(
        user_id, award_key, reason_code, effective_date, tracker_id, source_id,
        current_xp, current_event_id, generation
      )
      select p_user_id, v_key, 'DAILY_CHECK_IN_COMPLETED', p_entry_date, p_tracker_id, p_entry_id,
        greatest(coalesce(sum(event.xp_delta), 0), 0)::integer,
        case when coalesce(sum(event.xp_delta), 0) > 0 then v_event.id else null end,
        count(*) filter (where event.reason_code = 'AWARD_REVERSAL')::integer
      from public.progression_events event
      left join public.progression_event_sources source on source.user_id = event.user_id and source.event_id = event.id
      where event.user_id = p_user_id and (event.id = v_event.id or source.source_id = p_entry_id);
    else
      insert into public.progression_award_state(user_id, award_key, reason_code, effective_date, tracker_id, source_id)
      values (p_user_id, v_key, 'DAILY_CHECK_IN_COMPLETED', p_entry_date, p_tracker_id, p_entry_id);
    end if;
    select * into v_state from public.progression_award_state
    where user_id = p_user_id and award_key = v_key for update;
  end if;

  -- Older dates already represented by the opening estimate cannot create a
  -- new award through a late offline upload or correction. Existing credits
  -- can still be reversed when their saved source stops qualifying.
  if v_historic and v_state.current_xp = 0 then v_qualifies := false; end if;

  if v_qualifies and v_state.current_xp = 0 then
    v_generation := v_state.generation + 1;
    v_event_key := case when v_generation = 1 then v_key
      else md5('reaward:' || v_key::text || ':' || v_generation::text)::uuid end;
    insert into public.progression_events(
      user_id, event_category, reason_code, effective_date, xp_delta,
      scoring_version, idempotency_key, metadata
    ) values (
      p_user_id, 'check_in', 'DAILY_CHECK_IN_COMPLETED', p_entry_date, 10,
      2, v_event_key, jsonb_build_object('rule', '10 XP per eligible completed check-in', 'award_generation', v_generation)
    ) returning * into v_event;
    insert into public.progression_event_sources(user_id, event_id, tracker_id, source_id, display_name)
    values (p_user_id, v_event.id, p_tracker_id, p_entry_id, v_tracker.name);
    update public.progression_award_state set
      effective_date = p_entry_date, tracker_id = p_tracker_id, source_id = p_entry_id,
      current_xp = 10, current_event_id = v_event.id, generation = v_generation, updated_at = clock_timestamp()
    where user_id = p_user_id and award_key = v_key;
  elsif not v_qualifies and v_state.current_xp > 0 then
    v_delta := -v_state.current_xp;
    insert into public.progression_events(
      user_id, event_category, reason_code, effective_date, xp_delta,
      scoring_version, idempotency_key, reverses_event_id, metadata
    ) values (
      p_user_id, 'reversal', 'AWARD_REVERSAL', p_entry_date, v_delta,
      2, md5('reverse:' || v_state.current_event_id::text)::uuid, v_state.current_event_id,
      jsonb_build_object('reason', 'Source check-in no longer qualifies', 'award_generation', v_state.generation)
    ) on conflict (user_id, idempotency_key) do nothing;
    update public.progression_award_state set
      effective_date = p_entry_date, tracker_id = p_tracker_id, source_id = p_entry_id,
      current_xp = 0, current_event_id = null, generation = generation + 1, updated_at = clock_timestamp()
    where user_id = p_user_id and award_key = v_key;
  end if;
end;
$$;
revoke all on function public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_perfect_day(p_user_id uuid,p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eligible_count integer;
  v_completed_count integer;
  v_today date;
  v_timezone text;
  v_cutover_at timestamptz;
  v_latest_definition_change timestamptz;
  v_eligible boolean := false;
  v_key uuid;
begin
  if p_user_id is null or p_date is null then return; end if;
  perform public.initialize_progression_account(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-perfect-day:' || p_date::text, 5));
  select coalesce(s.timezone,'UTC'),a.initialized_at into v_timezone,v_cutover_at
  from public.progression_account_state a left join public.app_settings s on s.user_id=a.user_id where a.user_id=p_user_id;
  if v_timezone is null then return; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone:='UTC'; end if;
  v_today:=(clock_timestamp() at time zone v_timezone)::date;
  select max(t.updated_at) into v_latest_definition_change from public.trackers t
  where t.user_id=p_user_id and t.status in ('active','archived') and t.deleted_at is null;
  if p_date>v_today or (v_cutover_at is not null and p_date<(v_cutover_at at time zone v_timezone)::date)
     or (v_latest_definition_change is not null and p_date<(v_latest_definition_change at time zone v_timezone)::date) then
    v_eligible:=false;
  else
    select count(*),count(*) filter(where e.id is not null and e.deleted_at is null and e.server_changed_at >= v_cutover_at
      and public.progression_entry_qualifies(t.definition,e.entry_values,e.outcome)) into v_eligible_count,v_completed_count
    from public.trackers t left join public.tracker_entries e
      on e.user_id=t.user_id and e.tracker_id=t.id and e.entry_date=p_date
    where t.user_id=p_user_id and t.status in ('active','archived') and t.deleted_at is null
      and public.progression_date_is_eligible(p_user_id,t,p_date);
    v_eligible:=v_eligible_count>0 and v_eligible_count=v_completed_count;
  end if;
  v_key:=md5(p_user_id::text||':perfect-day:'||p_date::text)::uuid;
  perform public.reconcile_progression_award(p_user_id,v_key,'PERFECT_DAY_BONUS',p_date,20,null,null,null,v_eligible,
    'Every eligible tracker was completed for this date');
end;
$$;
revoke all on function public.reconcile_progression_perfect_day(uuid,date) from public,anon,authenticated,service_role;

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
  v_crossed_date date;
  v_crossed_at timestamptz;
  v_award_key uuid;
begin
  if p_user_id is null or p_tracker_id is null then return; end if;
  perform public.initialize_progression_account(p_user_id);
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

  foreach v_threshold in array array[7,14,30,100] loop
    v_xp := case v_threshold when 7 then 35 when 14 then 50 when 30 then 100 else 200 end;
    with eligible as (
      select days.activity_at::date as activity_date,
        entry.server_changed_at as source_at,
        entry.id is not null and public.progression_entry_qualifies(v_tracker.definition, entry.entry_values, entry.outcome) as qualifies
      from lateral generate_series(
        greatest(coalesce((v_tracker.definition->>'startDate')::date, (v_tracker.created_at at time zone v_timezone)::date), (v_tracker.created_at at time zone v_timezone)::date, (v_cutover_at at time zone v_timezone)::date)::timestamp,
        v_today::timestamp, interval '1 day'
      ) as days(activity_at)
      left join public.tracker_entries entry on entry.user_id = p_user_id and entry.tracker_id = p_tracker_id
        and entry.entry_date = days.activity_at::date and entry.deleted_at is null
      where public.progression_date_is_eligible(p_user_id, v_tracker, days.activity_at::date)
    ), groups as (
      select activity_date, source_at, qualifies,
        sum(case when qualifies then 0 else 1 end) over (order by activity_date) as run_group
      from eligible
    ), runs as (
      select activity_date, source_at, qualifies, run_group,
        sum(case when qualifies then 1 else 0 end) over (partition by run_group order by activity_date) as run_length
      from groups
    )
    select activity_date, source_at into v_crossed_date, v_crossed_at from runs
    where qualifies and run_length = v_threshold
    order by activity_date limit 1;

    v_award_key := md5(p_user_id::text || ':streak:' || p_tracker_id::text || ':' || v_threshold::text)::uuid;
    perform public.reconcile_progression_award(
      p_user_id, v_award_key, 'STREAK_MILESTONE', coalesce(v_crossed_date, v_today), v_xp,
      p_tracker_id, null, v_award_key,
      v_crossed_date is not null and v_crossed_at > v_cutover_at
        and v_crossed_date >= (v_cutover_at at time zone v_timezone)::date,
      v_threshold::text || '-day qualifying tracker streak'
    );
  end loop;
end;
$$;
revoke all on function public.reconcile_progression_tracker_milestones(uuid,uuid) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_goal_tracker(p_user_id uuid,p_tracker_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers%rowtype;
  v_cutover timestamptz;
  v_metric jsonb;
  v_milestone jsonb;
  v_metric_id text;
  v_target numeric;
  v_best numeric;
  v_crossed_date date;
  v_metric_count integer;
  v_award_key uuid;
  v_completed boolean;
  v_completion_date date;
  v_timezone text;
  v_today date;
begin
  if p_user_id is null or p_tracker_id is null then return; end if;
  perform public.initialize_progression_account(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-goal-tracker:' || p_tracker_id::text,7));
  select * into v_tracker from public.trackers where user_id=p_user_id and id=p_tracker_id and kind='goal';
  if not found or v_tracker.deleted_at is not null then return; end if;
  select initialized_at into v_cutover from public.progression_account_state where user_id=p_user_id;
  if v_cutover is null then return; end if;
  select coalesce(timezone,'UTC') into v_timezone from public.app_settings where user_id=p_user_id;
  v_timezone:=coalesce(v_timezone,'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone:='UTC'; end if;
  v_today:=(clock_timestamp() at time zone v_timezone)::date;
  v_completed:=v_tracker.status='completed' and v_tracker.server_changed_at >= v_cutover;

  for v_milestone in select milestone from jsonb_array_elements(coalesce(v_tracker.definition->'milestones','[]'::jsonb)) as milestones(milestone) loop
    if jsonb_typeof(v_milestone->'targetValue') is distinct from 'number'
       or nullif(v_milestone->>'id','') is null then continue; end if;
    v_target:=(v_milestone->>'targetValue')::numeric;
    v_metric_id:=v_milestone->>'metricId';
    if v_metric_id is null then
      select count(*),min(metric->>'id') into v_metric_count,v_metric_id
      from jsonb_array_elements(coalesce(v_tracker.definition->'metrics','[]'::jsonb)) as metrics(metric)
      where metric->>'retiredAt' is null;
      if v_metric_count<>1 then continue; end if;
    end if;
    select metric into v_metric from jsonb_array_elements(coalesce(v_tracker.definition->'metrics','[]'::jsonb)) as metrics(metric)
      where metric->>'id'=v_metric_id and metric->>'retiredAt' is null limit 1;
    if v_metric is null then continue; end if;
    select case when v_metric->'thresholds'->>'direction'='decrease' then min(metric_rows.metric_value) else max(metric_rows.metric_value) end,
      min(metric_rows.entry_date) filter(where case when v_metric->'thresholds'->>'direction'='decrease' then metric_rows.metric_value<=v_target else metric_rows.metric_value>=v_target end)
      into v_best,v_crossed_date
    from (
      select e.entry_date,
        case
          when v_metric->>'valueType' in ('quantity','duration') and jsonb_typeof(e.entry_values->v_metric_id)='number'
            then (e.entry_values->>v_metric_id)::numeric
          when v_metric->>'valueType'='boolean' and e.entry_values->v_metric_id='true'::jsonb then 1::numeric
          when v_metric->>'valueType'='boolean' and e.entry_values->v_metric_id='false'::jsonb then 0::numeric
          when v_metric->>'valueType'='checklist' and jsonb_typeof(e.entry_values->v_metric_id)='array' then
            (select count(*)::numeric from jsonb_array_elements(e.entry_values->v_metric_id) as items(item) where item='true'::jsonb)
          when v_metric->>'valueType'='checklist' and jsonb_typeof(e.entry_values->v_metric_id)='object' then
            (select count(*)::numeric from jsonb_each(e.entry_values->v_metric_id) as items(key,item) where item='true'::jsonb)
          else null
        end as metric_value
      from public.tracker_entries e
      where e.user_id=p_user_id and e.tracker_id=p_tracker_id and e.deleted_at is null and e.outcome='recorded'
        and e.server_changed_at>=v_cutover and e.entry_date >= (v_cutover at time zone v_timezone)::date and e.entry_date<=v_today
        and e.entry_date>=coalesce((v_tracker.definition->>'startDate')::date,(v_tracker.created_at at time zone v_timezone)::date)
        and (v_tracker.definition->>'deadline' is null or e.entry_date<=(v_tracker.definition->>'deadline')::date)
    ) metric_rows where metric_rows.metric_value is not null;

    v_award_key:=md5(p_user_id::text||':goal-tracker-milestone:'||p_tracker_id::text||':'||coalesce(v_milestone->>'id',''))::uuid;
    perform public.reconcile_progression_award(p_user_id,v_award_key,'GOAL_MILESTONE',coalesce(v_crossed_date,current_date),25,
      p_tracker_id,null,null,v_best is not null and not v_completed and
      case when v_metric->'thresholds'->>'direction'='decrease' then v_best<=v_target else v_best>=v_target end,
      'A configured goal milestone was reached');
  end loop;

  v_completion_date:=coalesce(((v_tracker.definition->>'completedAt')::timestamptz at time zone v_timezone)::date,v_today);
  v_award_key:=md5(p_user_id::text||':goal-tracker-completed:'||p_tracker_id::text)::uuid;
  perform public.reconcile_progression_award(p_user_id,v_award_key,'GOAL_COMPLETED',v_completion_date,100,p_tracker_id,null,null,v_completed,
    'The goal tracker was marked complete by an accepted server write');
end;
$$;
revoke all on function public.reconcile_progression_goal_tracker(uuid,uuid) from public,anon,authenticated,service_role;

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

create or replace function public.initialize_progression_accounts_batch(p_batch_size integer default 5)
returns table(processed_accounts integer, remaining_accounts bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_processed integer := 0;
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 10 then
    raise exception 'batch size must be between 1 and 10';
  end if;
  for v_user_id in
    select u.id from auth.users u
    left join public.progression_account_state s on s.user_id=u.id
    left join public.progression_achievement_accounts a on a.user_id=u.id
    where s.user_id is null or a.user_id is null
    order by u.id
    limit p_batch_size
    for update of u skip locked
  loop
    perform public.initialize_progression_account(v_user_id);
    insert into public.progression_achievement_accounts(user_id,initialized_at)
      select v_user_id, initialized_at from public.progression_account_state where user_id=v_user_id
      on conflict(user_id) do nothing;
    perform public.reconcile_progression_achievements(v_user_id);
    v_processed := v_processed + 1;
  end loop;
  return query select v_processed,
    (select count(*) from auth.users u
      left join public.progression_account_state s on s.user_id=u.id
      left join public.progression_achievement_accounts a on a.user_id=u.id
      where s.user_id is null or a.user_id is null);
end;
$$;
revoke all on function public.initialize_progression_accounts_batch(integer) from public,anon,authenticated,service_role;
create or replace function public.initialize_new_progression_account_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.initialize_progression_account(new.id);
  update public.progression_account_state set legacy_xp_kind='new_account'
  where user_id=new.id and legacy_xp_kind='unavailable';
  return new;
end;
$$;
revoke all on function public.initialize_new_progression_account_trigger() from public,anon,authenticated,service_role;
drop trigger if exists auth_user_progression_initialization on auth.users;
create trigger auth_user_progression_initialization after insert on auth.users
  for each row execute function public.initialize_new_progression_account_trigger();


create or replace function public.get_progression_legacy_xp_status()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.legacy_xp_kind from public.progression_account_state s where s.user_id=auth.uid()),'pending')
$$;
revoke all on function public.get_progression_legacy_xp_status() from public,anon,service_role;
grant execute on function public.get_progression_legacy_xp_status() to authenticated;

commit;
