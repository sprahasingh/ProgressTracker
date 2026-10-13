-- Goal rewards are derived from server-accepted post-cutover progress only.
-- Each metric target is one deterministic milestone; completing the goal pays
-- the completion reward instead of stacking the same target milestone.
begin;

-- The event ledger is readable to its owner only. No API role receives a
-- direct write grant; SECURITY DEFINER trigger routines write as the owner.
revoke all on public.progression_events, public.progression_event_sources from service_role;

create or replace function public.reconcile_progression_goal(p_user_id uuid,p_goal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_goal public.goals%rowtype;
  v_cutover timestamptz;
  v_metric record;
  v_award_key uuid;
  v_completed boolean;
begin
  if p_user_id is null or p_goal_id is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-goal:' || p_goal_id::text, 6));
  select * into v_goal from public.goals where user_id=p_user_id and id=p_goal_id;
  if not found then return; end if;
  select initialized_at into v_cutover from public.progression_account_state where user_id=p_user_id;
  if v_cutover is null then return; end if;
  v_completed := v_goal.deleted_at is null and v_goal.status='completed' and v_goal.completed_at is not null
    and v_goal.completed_at <= clock_timestamp();

  for v_metric in
    select m.id,m.target,coalesce(crossing.crossing_date,(clock_timestamp() at time zone coalesce((select timezone from public.app_settings where user_id=p_user_id),'UTC'))::date) as crossing_date,
      coalesce(crossing.reached,false) as reached
    from public.goal_metrics m
    left join lateral (
      select min(progress_date) filter(where accumulated >= m.target) as crossing_date,
        coalesce(bool_or(accumulated >= m.target),false) as reached
      from (
        select l.progress_date,sum(l.value) over(order by l.progress_date,l.server_changed_at,l.id rows between unbounded preceding and current row) as accumulated
        from public.goal_progress_logs l
        where l.user_id=p_user_id and l.metric_id=m.id and l.deleted_at is null and l.server_changed_at >= v_cutover
      ) totals
    ) crossing on true
    where m.user_id=p_user_id and m.goal_id=p_goal_id and m.deleted_at is null
  loop
    v_award_key := md5(p_user_id::text || ':goal-metric-target:' || p_goal_id::text || ':' || v_metric.id::text)::uuid;
    perform public.reconcile_progression_award(p_user_id,v_award_key,'GOAL_MILESTONE',v_metric.crossing_date,25,null,p_goal_id,v_metric.id,
      v_metric.reached and not v_completed,'A goal metric reached its configured target');
  end loop;

  v_award_key := md5(p_user_id::text || ':goal-completed:' || p_goal_id::text)::uuid;
  perform public.reconcile_progression_award(p_user_id,v_award_key,'GOAL_COMPLETED',coalesce(v_goal.completed_at::date,(clock_timestamp() at time zone coalesce((select timezone from public.app_settings where user_id=p_user_id),'UTC'))::date),100,
    null,p_goal_id,null,v_completed,'The goal was marked complete by an accepted server write');
end;
$$;
revoke all on function public.reconcile_progression_goal(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.reconcile_progression_goal_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_goal_id uuid;
begin
  if tg_table_name='goals' then
    if tg_op='UPDATE' and old.user_id is distinct from new.user_id then
      perform public.reconcile_progression_goal(old.user_id,old.id);
    end if;
    perform public.reconcile_progression_goal(new.user_id,new.id);
  elsif tg_table_name='goal_metrics' then
    if tg_op='UPDATE' and (old.user_id,old.goal_id) is distinct from (new.user_id,new.goal_id) then
      perform public.reconcile_progression_goal(old.user_id,old.goal_id);
    end if;
    perform public.reconcile_progression_goal(new.user_id,new.goal_id);
  else
    select goal_id into v_goal_id from public.goal_metrics where user_id=new.user_id and id=new.metric_id;
    perform public.reconcile_progression_goal(new.user_id,v_goal_id);
    if tg_op='UPDATE' and (old.user_id,old.metric_id) is distinct from (new.user_id,new.metric_id) then
      select goal_id into v_goal_id from public.goal_metrics where user_id=old.user_id and id=old.metric_id;
      perform public.reconcile_progression_goal(old.user_id,v_goal_id);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.reconcile_progression_goal_trigger() from public,anon,authenticated,service_role;

create trigger goals_progression_rewards after insert or update on public.goals
  for each row execute function public.reconcile_progression_goal_trigger();
create trigger goal_metrics_progression_rewards after insert or update on public.goal_metrics
  for each row execute function public.reconcile_progression_goal_trigger();
create trigger goal_progress_logs_progression_rewards after insert or update on public.goal_progress_logs
  for each row execute function public.reconcile_progression_goal_trigger();

commit;
