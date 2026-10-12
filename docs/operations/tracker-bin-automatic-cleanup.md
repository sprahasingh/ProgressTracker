# Automatic tracker Bin cleanup

The cleanup function already exists. Migration `20261013000200_schedule_tracker_bin_cleanup.sql` installs or corrects one active daily pg_cron job at 03:00 UTC. It does not turn on the protected cleanup control. The function returns without deleting anything while `tracker_deletion_cleanup_control.enabled` is false or its row is absent.

The database cleanup switch and the frontend wording gate are separate. Keep `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP=false` until the production job has run successfully with the database switch off and an operator has explicitly enabled the switch. Then build and deploy the frontend with the flag set to `true` so the Bin copy matches the database behavior.

## Review and apply

Do not apply this migration to production until explicitly approved. After approval, apply it through the normal Supabase migration workflow. If pg_cron is not enabled for the project, enable it in **Dashboard → Database → Extensions**, then rerun the migration. Supabase Cron uses the `pg_cron` extension and records schedules and execution history in `cron.job` and `cron.job_run_details` ([Supabase Cron documentation](https://supabase.com/docs/guides/cron)).

Before enabling deletion, confirm the database parameter `cron.timezone` is `GMT`, `UTC`, or `Etc/UTC`. pg_cron defaults to GMT; if the project overrides it, set it to UTC in the Supabase database configuration and restart the database as required before relying on the 03:00 UTC schedule ([pg_cron configuration](https://github.com/citusdata/pg_cron/blob/main/README.md#setting-up-pg_cron)).

## Read-only verification

Confirm the extension and timezone:

```sql
select e.extname, n.nspname as extension_schema,
       current_setting('cron.timezone', true) as cron_timezone
from pg_extension e
join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pg_cron';
```

Confirm exactly one active daily job:

```sql
select jobid, jobname, schedule, active, username, command
from cron.job
where jobname = 'progress-tracker-bin-cleanup';
```

Confirm the latest job execution succeeded while cleanup is still disabled:

```sql
select d.status, d.return_message, d.start_time, d.end_time
from cron.job_run_details d
join cron.job j using (jobid)
where j.jobname = 'progress-tracker-bin-cleanup'
order by d.start_time desc
limit 5;
```

Confirm the protected cleanup switch remains off before activation:

```sql
select enabled, updated_at
from public.tracker_deletion_cleanup_control
where id = true;
```

Estimate the current eligible count without reading tracker content or changing data by running [`count_expired_tracker_bin.sql`](../../supabase/verification/count_expired_tracker_bin.sql).

## Explicit activation

Only after the migration is applied, `cron.timezone` is UTC-equivalent, exactly one job is active at `0 3 * * *`, and a job run has succeeded with the control off, an authorized operator can enable the database switch. The guarded block refuses activation if those conditions are not met:

```sql
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not installed';
  end if;
  if current_setting('cron.timezone', true) is not null
     and upper(current_setting('cron.timezone', true)) not in ('UTC', 'GMT', 'ETC/UTC') then
    raise exception 'cron.timezone must be UTC or GMT';
  end if;
  if (select count(*) from cron.job where jobname = 'progress-tracker-bin-cleanup'
      and schedule = '0 3 * * *' and active
      and command = 'select public.purge_expired_tracker_bin();') <> 1 then
    raise exception 'the expected single active 03:00 UTC cleanup job is not installed';
  end if;
  if not exists (
    select 1 from cron.job_run_details d
    join cron.job j using (jobid)
    where j.jobname = 'progress-tracker-bin-cleanup' and d.status = 'succeeded'
  ) then
    raise exception 'no successful cleanup job run has been recorded';
  end if;
  update public.tracker_deletion_cleanup_control
  set enabled = true, updated_at = clock_timestamp()
  where id = true;
  if not found then raise exception 'cleanup control row is missing'; end if;
end;
$$;
```

Afterward, set `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP=true` in the production frontend build environment and deploy that frontend through the normal release process. The database cleanup remains enabled independently of this UI flag.

## Rollback

To stop further scheduled cleanup, first disable the database switch, then unschedule the job. This does not restore trackers already permanently deleted:

```sql
update public.tracker_deletion_cleanup_control
set enabled = false, updated_at = clock_timestamp()
where id = true;

select cron.unschedule(jobid)
from cron.job
where jobname = 'progress-tracker-bin-cleanup';
```

Set `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP=false` in the next frontend build and deploy it so the Bin stops claiming automatic deletion. The extension may remain installed; the manual permanent-deletion RPC is unaffected.
