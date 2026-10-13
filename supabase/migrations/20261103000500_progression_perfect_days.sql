-- Award Perfect Day from the server's eligible tracker set. The current tracker
-- definition is the only schedule snapshot available; do not reconstruct dates
-- preceding a tracker definition's last update.
begin;

create or replace function public.reconcile_progression_perfect_day(p_user_id uuid, p_date date)
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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':progression-perfect-day:' || p_date::text, 5));
  select coalesce(s.timezone, 'UTC'), a.initialized_at into v_timezone, v_cutover_at
  from public.progression_account_state a left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if v_timezone is null then return; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then v_timezone := 'UTC'; end if;
  v_today := (clock_timestamp() at time zone v_timezone)::date;

  select max(t.updated_at) into v_latest_definition_change
  from public.trackers t where t.user_id = p_user_id
    and t.status in ('active','archived') and t.deleted_at is null;

  -- Only score dates at/after the latest known definition change. Older dates
  -- lack a reliable historical schedule snapshot and must not be invented.
  if p_date > v_today or (v_cutover_at is not null and p_date < (v_cutover_at at time zone v_timezone)::date)
     or (v_latest_definition_change is not null and p_date < (v_latest_definition_change at time zone v_timezone)::date) then
    v_eligible := false;
  else
    select count(*), count(*) filter (where e.id is not null and e.deleted_at is null
      and public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome))
      into v_eligible_count, v_completed_count
    from public.trackers t
    left join public.tracker_entries e on e.user_id = t.user_id and e.tracker_id = t.id and e.entry_date = p_date
    where t.user_id = p_user_id
      and t.status in ('active','archived') and t.deleted_at is null
      and public.progression_date_is_eligible(p_user_id,t,p_date);
    v_eligible := v_eligible_count > 0 and v_eligible_count = v_completed_count;
  end if;
  v_key := md5(p_user_id::text || ':perfect-day:' || p_date::text)::uuid;
  perform public.reconcile_progression_award(p_user_id,v_key,'PERFECT_DAY_BONUS',p_date,20,null,null,null,v_eligible,
    'Every eligible tracker was completed for this date');
end;
$$;
revoke all on function public.reconcile_progression_perfect_day(uuid,date) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_entry_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    perform public.record_progression_entry_award(old.user_id, old.tracker_id, old.id, old.entry_date, old.entry_values, old.outcome, clock_timestamp());
    perform public.reconcile_progression_tracker_milestones(old.user_id, old.tracker_id);
    perform public.reconcile_progression_perfect_day(old.user_id, old.entry_date);
  end if;
  perform public.record_progression_entry_award(new.user_id,new.tracker_id,new.id,new.entry_date,new.entry_values,new.outcome,new.deleted_at);
  perform public.reconcile_progression_tracker_milestones(new.user_id,new.tracker_id);
  perform public.reconcile_progression_perfect_day(new.user_id,new.entry_date);
  if tg_op = 'UPDATE' and (old.tracker_id,old.entry_date) is distinct from (new.tracker_id,new.entry_date) then
    perform public.reconcile_progression_tracker_milestones(old.user_id,old.tracker_id);
    perform public.reconcile_progression_perfect_day(old.user_id,old.entry_date);
  end if;
  return new;
end;
$$;
revoke all on function public.reconcile_progression_entry_trigger() from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_tracker_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.tracker_entries%rowtype;
  v_date date;
begin
  for v_entry in select * from public.tracker_entries where user_id=new.user_id and tracker_id=new.id loop
    perform public.record_progression_entry_award(new.user_id,new.id,v_entry.id,v_entry.entry_date,v_entry.entry_values,v_entry.outcome,v_entry.deleted_at);
    perform public.reconcile_progression_perfect_day(new.user_id,v_entry.entry_date);
  end loop;
  perform public.reconcile_progression_tracker_milestones(new.user_id,new.id);
  for v_date in
    select distinct dates.day from (
      select e.entry_date as day from public.tracker_entries e where e.user_id=new.user_id
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
revoke all on function public.reconcile_progression_tracker_trigger() from public, anon, authenticated, service_role;

drop trigger if exists trackers_progression_definition_changed on public.trackers;
create trigger trackers_progression_definition_changed
  after insert or update of definition on public.trackers
  for each row execute function public.reconcile_progression_tracker_trigger();

commit;
