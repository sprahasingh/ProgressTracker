-- The active Goals UI stores goals in public.trackers (kind='goal'). Retire the
-- legacy normalized-goal trigger added in 007 and score the current model.
begin;
drop trigger if exists goals_progression_rewards on public.goals;
drop trigger if exists goal_metrics_progression_rewards on public.goal_metrics;
drop trigger if exists goal_progress_logs_progression_rewards on public.goal_progress_logs;

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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-goal-tracker:' || p_tracker_id::text,7));
  select * into v_tracker from public.trackers where user_id=p_user_id and id=p_tracker_id and kind='goal';
  if not found or v_tracker.deleted_at is not null then return; end if;
  select initialized_at into v_cutover from public.progression_account_state where user_id=p_user_id;
  if v_cutover is null then return; end if;
  select coalesce(timezone,'UTC') into v_timezone from public.app_settings where user_id=p_user_id;
  v_timezone:=coalesce(v_timezone,'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone:='UTC'; end if;
  v_today:=(clock_timestamp() at time zone v_timezone)::date;
  v_completed:=v_tracker.status='completed';

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
        and e.server_changed_at>=v_cutover and e.entry_date<=v_today
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

create or replace function public.reconcile_progression_entry_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op='UPDATE' and (old.user_id,old.tracker_id,old.entry_date) is distinct from (new.user_id,new.tracker_id,new.entry_date) then
    perform public.record_progression_entry_award(old.user_id,old.tracker_id,old.id,old.entry_date,old.entry_values,old.outcome,clock_timestamp());
    perform public.reconcile_progression_tracker_milestones(old.user_id,old.tracker_id);
    perform public.reconcile_progression_perfect_day(old.user_id,old.entry_date);
    perform public.reconcile_progression_goal_tracker(old.user_id,old.tracker_id);
  end if;
  perform public.record_progression_entry_award(new.user_id,new.tracker_id,new.id,new.entry_date,new.entry_values,new.outcome,new.deleted_at);
  perform public.reconcile_progression_tracker_milestones(new.user_id,new.tracker_id);
  perform public.reconcile_progression_perfect_day(new.user_id,new.entry_date);
  perform public.reconcile_progression_goal_tracker(new.user_id,new.tracker_id);
  if tg_op='UPDATE' and (old.tracker_id,old.entry_date) is distinct from (new.tracker_id,new.entry_date) then
    perform public.reconcile_progression_tracker_milestones(old.user_id,old.tracker_id);
    perform public.reconcile_progression_perfect_day(old.user_id,old.entry_date);
  end if;
  return new;
end;
$$;
revoke all on function public.reconcile_progression_entry_trigger() from public,anon,authenticated,service_role;

create or replace function public.reconcile_progression_tracker_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.tracker_entries%rowtype;
  v_date date;
  v_min_date date;
  v_timezone text;
begin
  for v_entry in select * from public.tracker_entries where user_id=new.user_id and tracker_id=new.id loop
    perform public.record_progression_entry_award(new.user_id,new.id,v_entry.id,v_entry.entry_date,v_entry.entry_values,v_entry.outcome,v_entry.deleted_at);
    perform public.reconcile_progression_perfect_day(new.user_id,v_entry.entry_date);
  end loop;
  perform public.reconcile_progression_tracker_milestones(new.user_id,new.id);
  perform public.reconcile_progression_goal_tracker(new.user_id,new.id);
  select coalesce(timezone,'UTC') into v_timezone from public.app_settings where user_id=new.user_id;
  v_timezone:=coalesce(v_timezone,'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone:='UTC'; end if;
  select greatest((a.initialized_at at time zone v_timezone)::date,
    coalesce((select max(t.updated_at) at time zone v_timezone from public.trackers t
      where t.user_id=new.user_id and t.status in ('active','archived') and t.deleted_at is null)::date,
      (a.initialized_at at time zone v_timezone)::date))
    into v_min_date from public.progression_account_state a where a.user_id=new.user_id;
  for v_date in
    select distinct dates.day from (
      select e.entry_date as day from public.tracker_entries e where e.user_id=new.user_id
        and e.entry_date>=v_min_date and e.entry_date<=(clock_timestamp() at time zone v_timezone)::date
      union all
      select s.effective_date from public.progression_award_state s where s.user_id=new.user_id and s.reason_code='PERFECT_DAY_BONUS'
      union all
      select (clock_timestamp() at time zone coalesce((select timezone from public.app_settings where user_id=new.user_id),'UTC'))::date
    ) dates
  loop
    perform public.reconcile_progression_perfect_day(new.user_id,v_date);
  end loop;
  return new;
end;
$$;
revoke all on function public.reconcile_progression_tracker_trigger() from public,anon,authenticated,service_role;
drop trigger if exists trackers_progression_definition_changed on public.trackers;
create trigger trackers_progression_definition_changed after insert or update on public.trackers
  for each row execute function public.reconcile_progression_tracker_trigger();

commit;
