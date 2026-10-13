-- Install the final Perfect Day reconciliation hooks for already initialized
-- local and future environments. Tracker creation can add a new eligible item
-- to a date that was previously awarded, so INSERT must also reconcile dates.
begin;

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
