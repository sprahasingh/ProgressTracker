# Account holiday deletion

Account holidays stay in the Holidays page under **Recently deleted holidays**. This lifecycle is separate from the tracker Bin.

## Soft delete and restore

Removing an account holiday writes a `deleted_at` tombstone locally and queues it for the owner-scoped `apply_account_holiday_sync_operation` RPC. The server assigns the deletion timestamp, checks the account and server revision, and returns conflicts rather than overwriting concurrent edits. The holiday disappears from active schedule calculations but remains available under **Recently deleted holidays**.

Restore clears the tombstone and queues a revisioned sync update. While offline, the change remains local and pending. A restore after the server retention deadline is rejected and finalized as a permanent deletion.

Guest holidays are stored only in the current browser. They have no server sync or cross-device recovery.

## Manual permanent deletion

Choose the three-dot menu beside a removed date, then **Delete permanently**. The confirmation explains that the change cannot be undone.

For an account holiday, the client queues a request and waits for its tombstone to sync. It then calls `permanently_delete_account_holiday` with the owner, holiday ID, operation ID, and last server revision. The RPC verifies the authenticated owner, requires the holiday to be in Recently deleted, checks the revision, and returns an idempotent result. A conflict preserves both copies for review. A confirmed deletion writes an owner-scoped holiday deletion ledger before removing the row and relevant sync receipts.

The client reconciles that ledger before holiday uploads. Old or offline clients cannot restore a permanently deleted holiday through the sync RPC, including by replaying an earlier idempotency receipt. An offline request remains pending until sync confirms it. Repeating the request is safe. Restore and deletion requests that race are serialized by the server revision and holiday date lock.

Guest permanent deletion removes the local holiday only after the user confirms. It has no remote server confirmation because guest workspaces do not sync.

The feature is hidden unless `VITE_ENABLE_HOLIDAY_PERMANENT_DELETION=true` is present at build time. Keep it off until the migration is applied and verified. The current GitHub Pages workflow does not pass this flag into the production build. Before production activation, update the workflow to pass the repository variable into the Vite build, then run a reviewed deployment after backend verification. A repository variable alone does not affect the current build.

## Automatic 30-day cleanup

The migration `20261102000100_account_holiday_permanent_deletion.sql` creates a separate `account_holiday_cleanup_control` row with `enabled=false`, an owner-scoped holiday deletion ledger, the internal cleanup function, and one daily 03:00 UTC pg_cron job. The scheduled job is active, but the holiday cleanup control keeps it inert. It does not use or change the tracker cleanup control, job, RPC, or retention behavior.

The database computes eligibility from the server-assigned `account_holidays.deleted_at` value. A holiday is eligible at 30 days. Cleanup processes at most 500 rows per call, rechecks eligibility under the same date lock used by sync, and records a durable ledger before removing the holiday and its sync receipts. The separate ledger prevents stale devices from restoring it. Scheduled cleanup is independent from the manual-deletion UI flag. Guest holidays are local-only and are pruned when that guest workspace opens after 30 days, when `VITE_ENABLE_AUTOMATIC_BIN_CLEANUP=true` is present in the build.

Do not enable the database control until the migration, UTC schedule, and a successful run with the control off have been verified. Check the job and timezone:

```sql
select current_setting('cron.timezone', true) as cron_timezone;

select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'progress-tracker-holiday-cleanup';

select d.status, d.return_message, d.start_time, d.end_time
from cron.job_run_details d
join cron.job j using (jobid)
where j.jobname = 'progress-tracker-holiday-cleanup'
order by d.start_time desc
limit 5;

select enabled, updated_at
from public.account_holiday_cleanup_control
where id = true;
```

After verification and explicit operational approval, enable the separate control:

```sql
update public.account_holiday_cleanup_control
set enabled = true, updated_at = clock_timestamp()
where id = true;
```

To stop future holiday cleanup, disable the control first, then unschedule only the holiday job:

```sql
update public.account_holiday_cleanup_control
set enabled = false, updated_at = clock_timestamp()
where id = true;

select cron.unschedule(jobid)
from cron.job
where jobname = 'progress-tracker-holiday-cleanup';
```

This cannot restore records already permanently deleted. Do not remove the deletion ledger or grant ordinary users execute access to the finalization or cleanup functions.

## Migration and test requirements

Apply the new migration after `20261011000100_global_holidays.sql` and the currently latest `20261101000100_schedule_tracker_bin_cleanup.sql` through the normal Supabase migration process. It creates the feature disabled and does not update production holiday data during migration. Test it in a local Supabase database first:

```sh
supabase start
supabase migration up --local
supabase test db
```

Review `supabase/tests/account_holiday_permanent_deletion.test.sql` for the ownership, replay, retention, stale-restore, and cleanup assertions. Do not apply the migration to hosted Supabase or enable its cleanup control without explicit release approval.
