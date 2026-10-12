-- Install one daily UTC cleanup job. The database control row deliberately
-- stays disabled until an operator verifies the schedule and explicitly opts in.
begin;

create extension if not exists pg_cron with schema pg_catalog;

insert into public.tracker_deletion_cleanup_control(id, enabled)
values (true, false)
on conflict (id) do nothing;

do $$
declare
  v_timezone text := current_setting('cron.timezone', true);
  v_job_count integer;
  v_job_matches boolean;
  v_job_id bigint;
begin
  if v_timezone is not null and upper(v_timezone) not in ('UTC', 'GMT', 'ETC/UTC') then
    raise exception 'pg_cron timezone must be UTC or GMT before scheduling tracker cleanup (current: %)', v_timezone;
  end if;

  select count(*), coalesce(bool_and(
    schedule = '0 3 * * *'
    and command = 'select public.purge_expired_tracker_bin();'
    and username = current_user
    and active
  ), false)
  into v_job_count, v_job_matches
  from cron.job
  where jobname = 'progress-tracker-bin-cleanup';

  if v_job_count = 1 and v_job_matches then
    return;
  end if;

  for v_job_id in
    select jobid from cron.job where jobname = 'progress-tracker-bin-cleanup'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'progress-tracker-bin-cleanup',
    '0 3 * * *',
    'select public.purge_expired_tracker_bin();'
  );
end;
$$;

comment on function public.purge_expired_tracker_bin() is
  'Scheduled daily at 03:00 UTC. Inert until tracker_deletion_cleanup_control.enabled is explicitly set true after operational verification.';

commit;
