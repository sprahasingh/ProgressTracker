# Automatic tracker Bin cleanup

## Overview

The database cleanup routine permanently removes account-owned trackers that have been in the Bin for 30 days. It runs in bounded batches and retains the deletion ledger so stale devices cannot restore purged records. The scheduled job and the protected database control are separate: both must be active for scheduled cleanup to delete data.

The frontend flag `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP` controls whether the Bin describes automatic cleanup. It does not enable or disable database deletion.

## Current deployment status

Verified for hosted project `fdhbbsjxyzmslzbvnadd` on 2026-10-14:

- Hosted migration history ends at `20261104001400`. Migrations `20261104001500` through `20261104002200` remain pending on hosted Supabase.
- The `progress-tracker-bin-cleanup` job remains installed and active at `0 3 * * *` (03:00 UTC daily).
- `public.tracker_deletion_cleanup_control.enabled` is `false`. The scheduled function therefore takes its disabled branch and does not delete records.
- The latest recorded execution on 2026-10-13 succeeded. Its run window has no corresponding permanent-deletion ledger records, so this confirms a successful no-op, not that a tracker was deleted.
- The eligible tracker count was zero at inspection, and no records were due before the next scheduled run.
- The eight pending migrations were applied only to the isolated hosted-data rehearsal copy. Its eight migrations, 335 pgTAP assertions, foreign-key validation, RLS checks, and disabled cleanup control passed.
- The GitHub Pages build passes `VITE_ENABLE_PROGRESSION_UI` from the repository variable into Vite. That variable is currently configured as `true`, so a Pages build can expose the progression UI before pending hosted migrations are applied. Set it to `false` or pause Pages deployments during the migration window, then enable it only after post-migration checks pass.
- The workflow does not pass `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP`; the frontend flag is separate from the database control and cannot enable scheduled deletion.

Keep the database cleanup control disabled. The hosted migration and deployment sequence must apply and verify migrations `20261104001500` through `20261104002200` before enabling progression UI. Do not enable automatic cleanup as part of this rollout.

## How automatic cleanup works

The scheduling migration installs one active daily pg_cron job named `progress-tracker-bin-cleanup`, scheduled at `0 3 * * *`. It creates the cleanup control row disabled if the row is absent, but preserves an existing row. Migration `20261104001500` turns the control off. The later Wins retention implementation uses Keep Wins for expiry, but the routine still does nothing while the control is disabled. The hosted switch was verified off on 2026-10-14; recheck it immediately before any cleanup activation decision.

Cleanup is server-side. The purge and finalization functions are not executable by ordinary authenticated users. The manual permanent-delete RPC and the frontend's `VITE_ENABLE_PERMANENT_DELETION` flag are separate features. Manual deletion offers Keep Wins and Delete Wins. Delete Wins is refused without changing data when the account has reconstructed XP, shared or goal rewards, achievement history, or other XP that cannot be attributed exactly to the selected tracker's entries. Scheduled expiry always chooses Keep Wins and must be explained when a tracker is moved to the Bin.

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
