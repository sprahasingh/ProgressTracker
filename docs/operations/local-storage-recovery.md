# Local storage failure recovery runbook

## User-facing recovery

1. Ask the user not to clear browser/site data, uninstall the app, reset the account, or recreate trackers. Those actions can remove device-only offline work.
2. If the account is signed in and the workspace cannot be opened, use **Open Cloud Recovery — Read Only**. If the workspace remains loading for several seconds, the app also offers this option without assuming storage failed. The screen verifies the signed-in identity and displays only rows visible through the account's ordinary RLS-protected cloud reads.
3. Treat the cloud retrieval timestamp as the time that read completed, not proof of synchronization. Offline changes may be absent. An empty response does not establish that the device has no records.
4. Use **Retry cloud read** only for a cloud authentication, network, query, or data-validation failure. Reauthenticate through the normal app flow if authentication is reported; do not bypass RLS.
5. Use **Retry local workspace** only when ready to return to the local editable app. If the app says an earlier workspace, sync, or device-account operation is still running, wait for it to settle; retry is disabled during that time. Recovery does not cancel that operation, and it may finish work already underway. It does not reset or recreate IndexedDB. Subsequent normal synchronization retains the established optimistic revision and conflict protections.

## Diagnostic collection

Local structured diagnostics are transient browser events and contain operation, stage, category, coarse browser family, and time only. They exclude account identifiers, record content, tokens, query details, and raw exception messages. If further diagnosis is needed, request the category and stage, browser/version, app build, whether the failure occurred during initialize/open/upgrade/read, and the cloud recovery result category. Never request or paste authentication tokens or user record exports into a public issue.

Interpret categories distinctly:

- `database-open`: IndexedDB could not be opened; inspect the exact browser exception locally through a privacy-safe support workflow.
- `version-upgrade`: a schema upgrade failed; preserve the existing database and investigate the upgrade path.
- `blocked-connection`: another tab/connection is preventing an upgrade; close other ProgressTracker tabs and retry without clearing site data.
- `transaction`: a local database transaction failed; do not replay writes manually.
- `quota`: browser storage capacity was exceeded; do not clear ProgressTracker data as a first response.
- `browser-restricted`: the browser context denied or does not support storage.
- `record-validation`: a stored or remote record did not match the known schema; preserve the record for controlled diagnosis.
- Cloud `authentication`, `authorization`, `network`, `schema-compatibility`, `local-storage`, `invalid-cloud-data`, `unknown`, and `not-configured` identify failures in the separate read-only cloud path. A safe SQLSTATE/PostgREST/HTTP code may be included; raw server messages are not.

If production schema status is unknown, use [cloud-recovery-schema-verification.sql](./cloud-recovery-schema-verification.sql) in the Supabase Dashboard SQL Editor after verifying the project selector. The checks are read-only and inspect objects and policies rather than trusting only the migration ledger. A missing nullable `holiday_treatment` column is supported by the explicit legacy reader path; any missing required column blocks recovery.

## Production investigation

Verify the project reference `fdhbbsjxyzmslzbvnadd` against the approved deployment configuration before any production access. Use existing approved read-only auth/API/database logs and RLS-scoped reads. Do not use service-role or RLS-bypass credentials for account inspection, modify user rows, apply migrations, or deploy during diagnosis. If approved access is unavailable, stop the production inspection and report the missing read-only log/database access. Do not infer data deletion from a client loading failure.
