# Automatic tracker Bin cleanup

## Overview

The database cleanup routine permanently removes account-owned trackers that have been in the Bin for 30 days. It runs in bounded batches and retains the deletion ledger so stale devices cannot restore purged records. The scheduled job and the protected database control are separate: both must be active for scheduled cleanup to delete data.

The frontend flag `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP` controls whether the Bin describes automatic cleanup. It does not enable or disable database deletion.

## Current deployment status

The following hosted status was reported during the latest review:

- Migration `20261101000100_schedule_tracker_bin_cleanup.sql` has been applied.
- The `progress-tracker-bin-cleanup` job is installed and active for 03:00 UTC daily (08:30 IST).
- The protected database cleanup control has been explicitly enabled.
- The last reported eligible tracker count was zero. The check date was not recorded here.
- A successful scheduled execution has not been confirmed.
- The production frontend flag has not been independently verified.

Because execution success is unconfirmed, verify the latest run before treating cleanup as operationally confirmed. The GitHub Pages workflow currently does not pass `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP` to its build step. Setting a repository variable alone therefore does not configure that production build; the deployment configuration must be updated before relying on the Bin wording gate.

## How automatic cleanup works

The migration installs one active daily pg_cron job named `progress-tracker-bin-cleanup`, scheduled at `0 3 * * *`. It creates the cleanup control row disabled if the row is absent, but preserves an existing row. The routine does nothing while the control is disabled. In the hosted deployment described above, the control is enabled.

Cleanup is server-side. The purge and finalization functions are not executable by ordinary authenticated users. The manual permanent-delete RPC and the frontend's `VITE_ENABLE_PERMANENT_DELETION` flag are separate features.

## Verify the scheduled job

Run these read-only checks in the intended Supabase project. Do not select tracker content.

Confirm pg_cron and its timezone:

```sql
select e.extname, n.nspname as extension_schema,
       current_setting('cron.timezone', true) as cron_timezone
from pg_extension e
join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pg_cron';
```

Confirm exactly one active daily job with the expected command:

```sql
select jobid, jobname, schedule, active, username, command
from cron.job
where jobname = 'progress-tracker-bin-cleanup';
```

Check recent execution results. A successful execution must be recorded before enabling cleanup in another environment:

```sql
select d.status, d.return_message, d.start_time, d.end_time
from cron.job_run_details d
join cron.job j using (jobid)
where j.jobname = 'progress-tracker-bin-cleanup'
order by d.start_time desc
limit 5;
```

Confirm the database switch:

```sql
select enabled, updated_at
from public.tracker_deletion_cleanup_control
where id = true;
```

Estimate the eligible count without reading tracker content or changing data by running [`count_expired_tracker_bin.sql`](../../supabase/verification/count_expired_tracker_bin.sql).

## Enable cleanup in another environment

Apply the migration through the normal Supabase migration workflow. If pg_cron is not installed, enable it in **Dashboard → Database → Extensions** before applying the migration. Confirm `cron.timezone` is `GMT`, `UTC`, or `Etc/UTC`; pg_cron defaults to GMT. Supabase records schedules and execution history in `cron.job` and `cron.job_run_details` ([Supabase Cron documentation](https://supabase.com/docs/guides/cron), [pg_cron configuration](https://github.com/citusdata/pg_cron/blob/main/README.md#setting-up-pg_cron)).

Keep the database switch off while checking the schedule and waiting for a successful execution. Once the migration, timezone, exactly one active job, and a successful run have been verified, an authorized operator can enable the database control with this guarded block:

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

Configure the frontend build with `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP=true` only after the database cleanup is active. The flag is read at build time. Confirm that the deployment workflow passes it into the build; the current GitHub Pages workflow does not.

## Disable or roll back

First disable the database switch, then unschedule the job. This stops future scheduled purges but cannot restore trackers already deleted:

```sql
update public.tracker_deletion_cleanup_control
set enabled = false, updated_at = clock_timestamp()
where id = true;

select cron.unschedule(jobid)
from cron.job
where jobname = 'progress-tracker-bin-cleanup';
```

Set `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP=false` in the next frontend build so the Bin no longer describes automatic removal. The frontend flag does not stop database cleanup. The pg_cron extension may remain installed, and manual permanent deletion remains separate.

## Important safety notes

- Do not enable the database control until the schedule and a successful run have been verified.
- The 30-day period is enforced by the database routine. Do not change the threshold as part of routine activation or rollback.
- Cleanup is permanent. Disabling the control does not recover already purged data.
- Do not grant ordinary users execution on the purge or finalization functions.
