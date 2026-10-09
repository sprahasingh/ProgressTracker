# ProgressTracker

A local-first personal productivity app for daily consistency, focused work, and measurable goals.

## Project status

The project has generic tracker setup, multi-metric success-rule editing, adaptive planning, local persistence, account-isolated IndexedDB workspaces, Supabase magic-link and email/password authentication, daily check-ins, goal summaries, analytics, dashboard summaries, history, and explicit account-scoped sync for generic trackers and entries. See [the product and architecture roadmap](docs/ROADMAP.md).

## Tech stack

- React 19 and TypeScript with strict compiler checks
- Vite for development and production builds
- Tailwind CSS 4 for utility styling, with a small CSS layer for the initial visual system
- React Router using hash-based URLs for reliable navigation and refreshes on GitHub Pages
- React Hook Form and Zod for upcoming form workflows
- Supabase JavaScript client for optional account-based cloud integration
- Vitest, jsdom, and React Testing Library for automated domain and UI tests

## Application structure

- `src/app` contains the shared application shell.
- `src/routes` defines client-side navigation.
- `src/features` groups page-level work by product area.
- `src/components/ui` contains shared presentation primitives.
- `src/styles/tokens.css` defines color, type, and radius tokens used by the interface.
- `src/test` contains shared test setup.

Shared UI components should remain presentation-focused. Product rules belong in domain modules as those features are introduced. Workspace settings now include a light, dark, or device-following appearance choice, applied using the existing design token palette.

## Generic tracker domain foundation

`src/domain/trackers/types.ts` defines a storage-independent, schema-versioned tracker model for habits, goals, challenges, and projects. It represents schedule variants, typed metrics and thresholds, nested qualification rules, custom fields, milestones, and dated entries with extensible JSON values. `schema.ts` validates definitions and entries with Zod at data boundaries, including schedule ranges, threshold ordering, metric references, and custom-field option rules.

`legacyAdapters.ts` projects existing category and daily-entry records into this domain shape while preserving IDs and history. A legacy category is represented as a boolean habit, and completed/skipped entries retain their identity and metadata. Quantitative progress cannot be inferred from legacy free-text notes. Generic records are persisted locally by Dexie; the tracker library, setup forms, check-ins, outbox, and sync state use the local repository. Account-scoped cloud sync requires the documented RPC migration and runs after account workspace activation, after reconnection, and shortly after a committed tracker/entry edit in that account workspace. Manual sync remains available on the Account screen. Guest workspaces remain local-only. See `docs/ROADMAP.md` for the staged plan and known risks.

Pure planning and qualification calculations live in `src/domain/trackers/planning.ts`. They classify minimum/target/stretch levels, evaluate nested `all`/`any`/`at-least` rules across metrics, and distribute remaining work evenly over eligible days. Recalculate with updated completed work/dates to redistribute the remaining load. Plans report planned, rest, missed, early-completion, and overdue dates plus completion and overdue summaries. Daily-recurring and cumulative-deadline goals have separate per-metric target maps; cumulative totals only include explicitly incremental metric entries. Deterministic calculations take the as-of date as input. The Goals page visualizes both modes, and Analytics provides a 7/30/90-day workspace-local consistency summary plus separate per-metric value charts.

Planning limitation: schedule cadence and quota handling are intentionally simple. Dates are date-only values; `times-per-week` and `times-per-month` choose approximate eligible work dates, not an optimized schedule. Workspace time zones drive current-day labels, while recurrence calculations are not timezone-aware. Cumulative progress is calculated separately per metric and counts only explicitly incremental data. See the limitations in `docs/ROADMAP.md`.

## Local data foundation

Dexie wraps IndexedDB behind `src/db/localRepository.ts`; components should call repository methods rather than access object stores directly. The versioned database contains categories, per-category daily entries, daily journals, goals, goal metrics, append-only metric progress snapshots, settings, and a pending sync operation table. Calendar dates are stored as `YYYY-MM-DD` strings, separate from event timestamps.

Database schema version 5 upgrades earlier installations transactionally. Version 3 adds generic `trackers` and `trackerEntries` stores and projects each legacy category and daily entry into them, preserving the existing IDs, date, note, timestamps, completion/skipped state, and tombstones. Version 4 adds workspace metadata; version 5 adds account-owned sync jobs, server revision state, and retained conflict records, and queues existing authenticated-workspace tracker data for sync. The original legacy stores are retained unchanged as compatibility copies. Guest and per-account workspaces use separate IndexedDB databases. Guest import is an explicit, recoverable copy; source rows remain in the guest workspace. Daily entries have a unique category/date index and generic tracker entries have a unique tracker/date index. Repository methods validate calendar dates and use date strings as daily identity, separate from timestamps. Progress history stores each recorded value; it does not keep only a mutable current total.

The tracker library and setup screens use local repository methods to list, create, edit, and archive generic trackers. Creation starts with a choice of Habit, Goal, Challenge, or Project and keeps each type's everyday fields in view. New measurable Goals ask for a total, unit, and deadline; they use cumulative incremental progress and show an estimated pace based on scheduled days. This goal total is independent from the metric's per-check-in minimum, target, and stretch thresholds. New habits default to a daily yes/no check-in, while their schedule is configurable. After creation, users can record their first check-in or progress, view the tracker, or customize it. Existing trackers retain their kind and schema version during ordinary edits, and existing goal targets retain their original planning or per-check-in meaning. Advanced options keep multiple boolean, quantity, duration, and checklist measures; increasing/decreasing minimum, target, and stretch thresholds; streak qualification; nested AND/OR/at-least success rules; typed custom fields; milestones linked to measures; and planning controls available without crowding basic setup. Checklist thresholds count completed items and cannot exceed the checklist length. Schedule controls include daily, weekdays, three-times-weekly, or flexible options with optional start/deadline dates. Archiving retains data and archived trackers can be shown again; the flow does not physically delete records.

The Account page offers **Download workspace backup** after the guest or signed-in account workspace is ready. It creates a versioned JSON snapshot of that one active IndexedDB workspace, including legacy and generic records, workspace metadata, tombstones, sync operations, revision metadata, and conflict snapshots. Export runs in a read-only transaction and checks the expected workspace owner. The backup is downloaded to the browser and is not encrypted by the app; store it somewhere private.

To restore, open Account in the matching guest workspace or signed-in account, choose the backup JSON under **Restore a backup**, review the preview, then confirm if there are no conflicts. Restore validates the format and owner, adds missing rows in one transaction, skips identical rows, and aborts without overwriting anything when IDs or daily unique keys conflict. Repeating a successful restore is safe. It does not upload directly; restored account outbox jobs can be processed by the existing sync flow. A backup cannot be restored into a different account. There is no cross-account data transfer flow or app-side encryption.

## Daily check-ins

The Today screen shows active trackers scheduled for the calendar date in the active workspace's selected time zone. It supports boolean, quantity, duration, checklist, and configured custom-field inputs; required fields are checked before saving. Each tracker has at most one generic entry per date: edits preserve that entry's ID, and clearing creates a local tombstone that a subsequent save restores. Skips are recorded as an outcome. Recorded values are evaluated against the tracker's configured success rule and the screen explains whether it qualified. Check-ins save to IndexedDB and enqueue account-scoped work; authenticated tracker and entry edits trigger a debounced sync attempt after the IndexedDB transaction commits. Offline edits stay queued for reconnection, and manual sync remains available from Account.

Schedule occurrences are deterministic for every supported schedule kind. Weekday schedules use JavaScript weekday numbering (Sunday 0). Every-N-days anchors to `startDate`, or the tracker's creation date when no start is configured. Quota schedules choose evenly spaced dates when no preferred weekdays are set; this is a simple recurring prompt schedule, not a capacity optimizer. The Settings screen stores an IANA calendar time zone and light, dark, or device-following appearance in the active local workspace. Today, Overview, History, Analytics ranges, and new tracker start-date defaults use the selected time zone. Existing date-only records are not rewritten when the setting changes. Preferences do not sync across devices, and planning recurrence is still date-based rather than timezone-aware. Cloud synchronization for legacy records/settings is future work. Local tombstones are retained; there is no purge/retention process yet.

## Streaks and progression rewards

`src/domain/trackers/progression.ts` provides pure `calculateStreak` and `calculateProgressRewards` functions. Streaks count qualifying scheduled occurrences, not calendar days: rest days do not increment or break a streak, while a missed, skipped, or below-rule scheduled entry resets the current run. An unlogged occurrence on the supplied `asOfDate` remains open; an explicit skip or failed entry on that date counts as a miss. When a tracker has a success rule, that rule determines qualification. Without one, the first metric's configured streak qualification (minimum, target, or any recorded value) is used.

The default reward policy grants 10 points for each qualifying retained entry and a 25-point bonus for personal-best streak milestones of 3, 7, 14, 30, 60, and 100 scheduled occurrences. A missed day resets only the current streak; points and personal-best milestones are recalculated from retained history and shown on Achievements. They are not stored in a reward ledger; editing/deleting historical entries can recalculate totals, and redemption or reward-specific sync behavior does not exist. Pass an explicit `asOfDate` and optional reward policy for reproducible calculations.

## Overview and history

The Overview route now summarizes actual local activity: active tracker count, successful scheduled check-ins over the rolling seven-day window, weekly consistency, derived reward points, current-month activity, and per-tracker current/best streaks with each latest recorded value. History lists actual entries with their values, notes, skip/success state, and filters for a tracker and the last 7, 30, or 90 days, or a custom inclusive start/end date range. Custom ranges cannot end after today in the active workspace time zone. Existing check-ins can be explicitly edited in History; saves retain the entry identity, validate tracker fields, and use the existing account outbox when in an authenticated workspace. Archived trackers remain read-only. The activity calendar covers the current local month; month navigation is not available. Neither view seeds sample activity or adds entry deletion/purge controls.

The **Goals** route lists generic trackers whose kind is `goal`, including active, paused, completed, and archived items. It summarizes deadline state, the most recent saved metric values, and metric-linked milestones using the best retained recorded value (minimum for decrease metrics, maximum otherwise). Milestone completion is derived and can change if saved history is edited. Configured goals display a daily-recurring plan or cumulative-deadline plan per metric, including schedule-aware consistency, expected and actual progress, remaining work, and required pace. The page links to the existing tracker editor and History, reads only the active local workspace, and does not add a second goal model or persistence path. The legacy SQL/IndexedDB `goals` tables remain outside the generic tracker UI and cloud sync.

The **Analytics** route summarizes recorded and skipped check-ins, success-rule qualification, and scheduled-day consistency for active trackers over the last 7, 30, or 90 days. An unlogged current day remains open and is not counted as missed; a current-day check-in is included. Individual metric charts retain their own units and display logged values by day without adding snapshots across dates. Analytics reads the current local IndexedDB workspace; it does not query Supabase directly.

The **Achievements** screen summarizes points, qualified check-ins, personal-best streak milestones, and current streaks across local tracker history. These are deterministic derived values, not a reward ledger; editing history may recalculate totals. Archived trackers remain visible for their retained history.

## Quality and accessibility checks

The app shell provides a keyboard skip link, named primary/mobile navigation, visible focus, and reduced-motion styling. Forms use associated labels and fieldsets; loading, errors, and qualification feedback use status/alert semantics. The activity calendar is a semantic table, and History filter counts are announced politely. Today, Overview, History, and Analytics have local-data, empty/error/retry, or calculation coverage in Vitest. Responsive breakpoints at 1100, 760, and 380 pixels were reviewed in CSS. A real browser viewport sweep and assistive-technology session remain manual follow-up: this environment has no installed Playwright/browser runner or screen reader.

IndexedDB schema upgrades run as a database transaction; tests cover upgrades from both v1 and v2 fixtures, preservation of legacy records/tombstones, and reading migrated rows after closing and reopening the database. Generic tracker definitions are validated before local writes.

## Supabase configuration

The browser client is optional until configured. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. The publishable key is expected to be visible in a client bundle; database access must be protected by authenticated sessions and Row Level Security. Never place a Supabase secret key or legacy `service_role` key in Vite variables. Local IndexedDB use does not require Supabase configuration.

## Email authentication

ProgressTracker supports passwordless email sign-in, email/password sign-up and sign-in, password reset, and password setup/change for signed-in users. A password reset uses Supabase's recovery email; the verified `PASSWORD_RECOVERY` event opens the password form. Users who first joined with a magic link can sign in with that link and set a password from the account screen. The magic-link flow remains available alongside password sign-in. Passwords must contain at least 8 characters in the client; configure any stronger password rules in Supabase Auth. The callback uses PKCE and returns to the current app path, compatible with the GitHub Pages repository path and hash-based client routing. The Supabase JS client persists the session locally and refreshes it. Productivity data remains local-first; account tracker and entry edits initiate a debounced sync after local commit. Reconnection and manual retry remain available.

In **Authentication → URL Configuration**, set the Site URL to `https://sprahasingh.github.io/ProgressTracker/` and add that URL plus `http://localhost:5173/ProgressTracker/` to the allowed Redirect URLs. Keep the Email provider enabled under **Authentication → Sign In / Providers**. Configure confirmation and password-recovery email templates to use Supabase's redirect placeholder so links return to the app URL requested by the client. For a new account, Supabase may require email confirmation before sign-in depending on project settings; the app displays confirmation guidance when no session is returned. Supabase's built-in email sender is limited to project organization members and 2 emails per hour; broader delivery requires custom SMTP, which is not configured by this project.

Password reset responses intentionally use neutral copy so the UI does not reveal whether an email address has an account. A recovery link must be valid and successfully exchanged by the Supabase JS PKCE client before the password form is shown. Password policy enforcement, email delivery, rate limits, confirmation requirements, and redirect allow-list behavior are controlled by Supabase project settings and must be verified in the hosted project. Browser authentication enables account access only; the app still reads and writes productivity data locally.

### Local workspace isolation

The original `ProgressTracker` IndexedDB database remains the guest workspace. The app waits for Supabase's initial persisted-session event before selecting guest or account data. Each signed-in user opens a separate local database keyed to that authenticated user ID, and the route shell requires the selected workspace owner to match the current auth state before rendering records. Switching accounts closes the current workspace, temporarily blocks record screens, clears them from the rendered route tree, and opens the new account's database. Tracker-list reads are scoped to that workspace and discarded if it changes before the read completes. Offline edits and queued local operations remain in that account's database across sign-out and later sign-in. Cloud transfer starts once after the account workspace is ready and again after an offline-to-online transition; **Sync this account** remains available for manual sync.

When an account first opens while guest data exists, ProgressTracker asks whether to copy that data into the account workspace, copy it while keeping both versions when IDs overlap, or keep it separate. The collision-safe copy gives colliding records new IDs and remaps their local parent links, including category/activity, goal/metric/history, and tracker/entry links. It also forks a category or tracker when separate activity rows would otherwise collide on their unique category/date or tracker/date key. The source is read in one IndexedDB transaction so other tabs cannot produce a mixed-table snapshot during import. Two different daily journals for the same date cannot both exist in one workspace; that import rolls back, leaving the guest copy untouched, and the user can keep the workspaces separate. A workspace has one settings row, so an existing account's settings take precedence; the unchanged guest settings remain in the guest workspace. Import runs as a local transaction with post-copy verification and a per-account completion marker; concurrent/repeated decisions are idempotent, interrupted runs roll back and can be retried, and imported decisions record their completion time. The guest source is never modified. Pending guest sync operations are not copied into an account queue; imported tracker records and entries receive new account-owned operations.

Local workspace partitioning is a browser-side isolation boundary, not a defense against someone with access to the browser profile or developer tools. The sync RPC migration must be applied before using **Sync this account**; without it, writes fail and remain queued locally. The existing Supabase RLS policies on generic tracker tables require `user_id = auth.uid()` for every operation and composite foreign keys enforce same-owner parent links. The client also passes an expected account ID to the RPC, which verifies it against `auth.uid()`.

## Supabase database schema and security

The original PostgreSQL migration is `supabase/migrations/20261008000100_progress_tracker_schema.sql`. It creates seven user-owned tables based on the legacy IndexedDB models. The additive migration `supabase/migrations/20261009000100_generic_trackers.sql` adds `trackers` and `tracker_entries` for the generic domain model. It does not change, drop, or backfill the legacy tables. The generic definition is stored as versioned JSON with indexed kind/status/name fields; daily values are JSON objects associated with a tracker and date.

| Table | Contents |
| --- | --- |
| `categories` | Category name, icon, description, accent, JSON schedule, order, archive and deletion timestamps |
| `daily_entries` | One completed/skipped category entry per user and calendar date, with a note |
| `daily_journals` | One free-text journal per user and calendar date |
| `goals` | Goal details, optional category, date range, status and completion timestamp |
| `goal_metrics` | Named numeric targets and optional weights for a goal |
| `goal_progress_logs` | Dated progress snapshots and optional notes for a metric |
| `app_settings` | One per-user timezone, appearance, and backup reminder settings row |
| `trackers` | Versioned generic habit, goal, challenge, or project definition stored as JSON |
| `tracker_entries` | Dated recorded/skipped values and notes for a generic tracker |

Application record IDs remain UUIDs generated by clients; timestamps are `timestamptz`, while calendar-only dates remain PostgreSQL `date`. `user_id` defaults to `auth.uid()` and is required in every table. Each table has RLS enabled with separate authenticated select, insert, update, and delete policies. Policies constrain both the existing and resulting row to the caller. Child foreign keys pair `user_id` with the parent ID, preventing cross-account category, goal, or metric references even if a foreign ID is known. Immediate, deferrable parent constraints block deleting a parent with children while allowing Supabase Auth to cascade deletion of an entire account in one statement.

For offline sync, mutable entities carry `updated_at`, `deleted_at`, and server-maintained `server_changed_at` and `server_revision` fields. `updated_at` is client event metadata, not a trusted sync cursor or concurrency token. `server_changed_at` is an indexed scan hint, not a commit-safe cursor. New rows start at revision 1; triggers reject stale revisions with SQLSTATE `40001`. The additive `20261009000200_sync_write_boundary.sql` migration adds a `SECURITY DEFINER` RPC that derives the owner from `auth.uid()`, also checks the caller's expected workspace user ID, performs inserts/updates only when the expected revision matches, returns conflicts without overwriting the row, and atomically records per-user operation receipts for safe retries. The receipt table has RLS enabled and no direct client grants. The browser calls this RPC only from the account-scoped sync engine, which starts after the authenticated workspace opens, on reconnect, after committed tracker/entry edits in that account workspace, or when the user chooses **Sync this account**. Edit-triggered calls are debounced and do not run for guest workspaces or a nonmatching active account. If the session changes after the client check, the server rejects the owner mismatch and the operation remains queued for the original account.

Tracker and entry timestamps stored by the domain use UTC ISO 8601 strings ending in `Z`. At the sync boundary, timestamp strings returned in PostgreSQL/PostgREST forms (including explicit UTC offsets and `YYYY-MM-DD HH:mm:ss[.fraction]+HH[:MM]`) are converted to the same UTC representation before strict domain validation. Offset conversion preserves the represented instant and fractional seconds. Upload conversion canonicalizes a copy of older persisted records only; it does not rewrite or discard the IndexedDB record. Malformed values still fail validation and the operation remains queued for recovery.

`deleted_at` is a tombstone, not a physical delete. Unique owner/date constraints intentionally include tombstoned daily entries and journals: a new UUID cannot create a second logical record for the same day, but the original UUID can be restored by setting `deleted_at` to null with its current `server_revision`. Do not purge tombstones until every device that may have missed the deletion has synchronized. Composite foreign keys remain enforced for tombstoned parent/child rows; physical parent deletion is restricted while any child history references it. Soft-deleted parents can still be restored without changing their IDs. The sync client uploads tracker parents first and holds dependent entry writes if that parent fails or conflicts. A child can still reference a soft-deleted parent because the schema preserves historical entries; deleting/restoring a tracker does not cascade to its entry history.

### Apply the original migration safely

Before reconciling this migration with Supabase CLI history, verify the hosted schema without changing it. Run the complete `supabase/verification/inspect_original_schema.sql` file in the intended project's SQL Editor. It returns one result table with a row for each expected object/configuration, a classification (`exact match`, `semantically equivalent difference`, `safe additional safeguard`, or `genuine mismatch requiring intervention`), explicit failures for missing or unexpected objects, and a final `OVERALL` row. The script opens a read-only transaction and inspects catalog metadata only; it does not read application rows or execute DDL. The original migration's policy predicates are compared by role, command, permissive mode, and normalized `USING`/`WITH CHECK` expressions; CHECK expression comparisons ignore only deparser parentheses and explicit text/numeric casts. Only consider the migration matched if every `ok` value is true, including `OVERALL`; investigate any genuine mismatch against `supabase/migrations/20261008000100_progress_tracker_schema.sql` before deciding whether to reconcile migration history.

1. Confirm the Supabase dashboard is on the intended ProgressTracker project and that authentication is enabled. Do not paste any secret or service-role key into the SQL Editor.
2. Open **SQL Editor → New query**. Open the migration file above locally and copy its complete contents into the editor. It is a transactional, app-table-only migration, uses `create table if not exists`, and replaces its named policies so it can be safely re-applied during development.
3. Review the selected project and SQL, then click **Run** once. Do not run on production data if app tables with these names already exist but have a different schema; inspect and reconcile first. The current project step assumes no ProgressTracker cloud tables exist. The SQL Editor does not register a Supabase CLI migration-history row; if CLI migrations are adopted later, reconcile this version in `supabase_migrations.schema_migrations` with `supabase migration repair --status applied 20261008000100` before running later migrations.
4. Verify the seven original tables in **Database → Tables** and confirm each shows RLS enabled. The client publishable key can only use the authenticated role after sign-in; never grant `anon` access.

### Apply the generic tracker migration

The hosted project already has the original schema migration applied. To add the generic tables, open `supabase/migrations/20261009000100_generic_trackers.sql` locally and copy the complete SQL into a new **SQL Editor** query in the intended Supabase project. Review the project and query, then run it once. It requires standard Supabase Auth roles and creates only `trackers` and `tracker_entries`; it does not backfill or alter legacy rows. It is versioned and intended to run once, so do not paste it repeatedly or rerun the original migration.

Verify that `trackers` and `tracker_entries` exist under **Database → Tables** and both show RLS enabled. The `tracker_entries_tracker_owner_fk` constraint combines owner and tracker IDs, preventing cross-account references. The account screen can write to these tables only through the authenticated sync RPC after its migration is installed.

### Apply the sync write-boundary migration

Only after the generic tracker migration has been applied, open `supabase/migrations/20261009000200_sync_write_boundary.sql`, copy it into a new SQL Editor query in the same intended project, review it, and run it once. It creates the private `sync_operation_receipts` table and the `apply_tracker_sync_operation` RPC. Verify the function exists under **Database → Functions**, receipts have RLS enabled, and `anon` has no execute grant. The app uses account-scoped synchronization after an authenticated workspace opens or the browser reconnects, with manual sync available on the Account screen. Local pgTAP coverage is in `supabase/tests/sync_write_boundary.test.sql` and declares 17 assertions.

Before trying hosted sync, run `supabase/verification/verify_sync_write_boundary.sql` as a read-only query in that same project's SQL Editor. It checks the generic tables and owner foreign key, RLS, the locked-down receipt table, and the RPC's security-definer/search-path/execute grants. Every returned `ok` value must be `true`; a missing migration or failed check means stop before using **Sync this account** and inspect the named object. This catalog query does not exercise live user writes and does not replace local pgTAP or an account-by-account sync smoke test. Running it here does not mean the hosted project has been checked.

To verify locally, run `supabase start`, then `supabase migration up --local`, then `supabase test db`. The migration command applies pending migrations to the local database without resetting it; the test command runs the pgTAP files in rolled-back transactions. This uses only the local Supabase stack and does not contact the hosted project. The suites include the original schema, generic tracker metadata/RLS/ownership/tombstones, sync write boundary/idempotent receipts, and planner schema v2/v3 compatibility.

### Goal planning and allocation schemas (v2/v3)

Goal planning targets are stored inside the versioned generic tracker `definition` JSON. Per-check-in metric thresholds (`minimum`, `target`, and `stretch`) remain independent. Daily recurring targets compare each recorded day's value against its own target on scheduled dates; rest days are omitted from missed-day and consistency counts. Cumulative deadline targets sum only recorded entries for metrics explicitly marked **Incremental**. Existing metrics default to snapshot meaning, and cumulative targets cannot be saved until the user explicitly confirms incremental semantics; this confirmation applies that interpretation to retained historical entries. Editing a date replaces that date's entry value, skipped or tombstoned entries do not count, and unrelated metric units are never combined. Checklist cumulative totals count checked items for each recorded day, so the same item can contribute again on another date.

The Goals page includes an **Interactive Planner** for active cumulative-deadline metrics. It distributes each remaining metric total over scheduled dates through the deadline, leaves rest days unallocated, and permits manual per-day adjustments. Schema v4 numeric metrics can define a maximum of two decimal places and an allowed increment. Suggestions split by that increment and preserve the exact sum when possible; if older recorded values make the remainder incompatible with the increment, the planner rounds the suggestion up to the next allowed increment and visibly reports the resulting over-allocation. It never rounds or rewrites recorded entries. Checklist allocations remain whole item counts. Actual recorded progress is shown separately from planned allocations. Reset to Suggested Allocation, Save Plan, and Discard Changes are available. Unsaved edits are visibly marked; saving changes only the tracker's planning definition and never changes check-in history. The saved planning time zone records the calendar context used for those dates.


Schema v3 adds `goalPlanning.planningTimeZone` and `goalPlanning.allocations`, a map of metric IDs to calendar dates and nonnegative amounts. Allocations are supported only for cumulative-target metrics explicitly marked incremental. Boolean metrics are excluded; checklist amounts must be whole item counts no greater than the checklist size per date. Dates must be scheduled occurrences within the goal's start date and deadline. Amounts may intentionally leave a shortfall or exceed the remaining target; the UI reports both rather than silently adjusting them. Allocations are separate from actual entry values. Existing v1/v2 documents remain unchanged unless the user saves an allocation plan; then only that goal upgrades to v3. Both mode-specific target maps and all recorded entries remain intact.

The forward-only migration is `supabase/migrations/20261009000400_goal_allocations_v3.sql`. It only expands the `trackers.schema_version` check to allow 1, 2, or 3; it does not change RLS, ownership keys, revision triggers, or the sync RPC. The application reuses the existing tracker transaction/outbox and server revision conflict flow. A tracker with an unresolved cloud conflict cannot be saved from this planner; resolve the conflict explicitly first. Backups/import, sync payload validation, and conflict snapshots preserve the whole v3 definition. The migration is **not applied to hosted Supabase by this change**. Do not run a production build with `VITE_ENABLE_TRACKER_SCHEMA_V3=true` until the hosted migration has been applied and verified. It defaults to disabled in production; local development remains enabled for testing.

Deployment order: review and apply `20261009000400_goal_allocations_v3.sql` in the hosted Supabase SQL Editor first; verify the `trackers_schema_version_check` constraint allows 1, 2, and 3 and verify the migration succeeded; then, only after confirming that result, set the production build variable `VITE_ENABLE_TRACKER_SCHEMA_V3=true` and deploy the v3-capable application. If an older client encounters a v3 tracker, it will reject that definition during pull; keep all active devices updated before creating persistent plans. The schema suite is `supabase/tests/goal_allocations_v3.test.sql`; it covers v1/v2 retention, v3 storage/RPC/revision behavior, and rejection of unsupported or mismatched versions. The application tests cover validation, outbox, sync, conflict preservation, and backup/restore. Database tests have not been executed in this environment.

Schema v4 adds optional per-metric numeric `precision` settings with `decimalPlaces` (0, 1, or 2) and an `increment` that must fit that precision. The setting applies to numeric check-ins, thresholds, planning targets, and allocation suggestions. Existing v1-v3 definitions remain valid, and ordinary viewing or editing does not upgrade them. A v4 definition is created only after the user configures precision. Existing recorded values are preserved; unchanged historical values remain editable even if they do not match a newly selected increment. New or changed values must use the configured increment.

The forward-only migration is `supabase/migrations/20261012000100_tracker_numeric_precision_v4.sql`. It only expands the tracker schema-version check from 1–3 to 1–4 and updates its comment; it does not change rows, RLS, ownership, revision triggers, or the sync RPC. Application production writes for v4 remain disabled unless `VITE_ENABLE_TRACKER_SCHEMA_V4=true` is explicitly set. The migration has not been applied to hosted Supabase. Apply and verify it before enabling that build variable. Older clients may reject v4 definitions during pull, so update all active devices before creating precision-configured trackers.

The SQL regression suite is `supabase/tests/tracker_numeric_precision_v4.test.sql`; `goal_allocations_v3.test.sql` also now expects the expanded 1–4 version constraint. These SQL tests must be run only after the migration is applied to the local test database. Do not reset a database that contains data; use the normal forward migration path and retain a backup first. The app tests cover version gates, precision validation, preserving unchanged legacy values, allocation increments, decimal cumulative sums, setup deadlines, help popovers, and existing sync behavior.

The schema test is `supabase/tests/goal_planning_v2.test.sql`; it checks RLS/policy and revision-trigger retention, v1/v2 inserts, revision advancement/stale-write rejection, and unsupported/mismatched version rejection. The hosted application and migration-history reconciliation are owner-reported; do not replay or repair this migration without checking the hosted migration catalog first.

If you later adopt `supabase db push`, note that running SQL Editor migrations does not add rows to the CLI migration history. Inspect `supabase_migrations.schema_migrations` first and use `supabase migration repair --status applied <version>` for each SQL-Editor-applied migration that is missing from history. Do not let CLI push replay an already-applied migration.

The original schema security checks are in `supabase/tests/progress_tracker_schema.test.sql` and use pgTAP. They test schema metadata, two simulated authenticated users, anonymous denial for all four operations, row filtering, attempted ownership reassignment, cross-user category/goal/metric foreign keys, revision conflicts, server timestamp integrity, tombstone uniqueness/restoration, parent-delete restrictions, and full account deletion cascades. All SQL tests use transaction-local fixtures and roll them back; they do not connect to or modify your hosted project. The browser app does not sync the seven legacy tables; account-scoped automatic and manual sync use only the separate generic tracker tables.

Known limitations: sync supports only generic trackers and entries. Account-owned tracker and entry edits, archive changes, entry tombstones, and local conflict choices that queue writes trigger a debounced attempt after their IndexedDB transaction commits. Guest edits remain local-only. Failed requests are retained but do not trigger polling or retry loops; retry by making another edit, reconnecting, or using manual sync. Pull uses a full keyset scan because `server_changed_at` is not a commit-safe cursor. The account screen displays local and cloud conflict snapshots only after the active account workspace is ready, and lets you explicitly keep either version when the cloud row is readable by this account. “Keep this device” queues a retry against the displayed cloud revision; when two same-day entries have different IDs, it adopts the existing cloud ID before retrying. “Use cloud” replaces the local copy and removes its stale queued write. If the server cannot return a readable cloud row (for example, a cross-account ID collision), “Save local copy as new” assigns a fresh ID; for a tracker it also relinks its local entry history and clears stale child conflict snapshots so the updated entries can be checked again on the next sync. These choices preserve the local payload, but resolving a same-day duplicate means selecting which values occupy that date. Edits made while an upload is in flight stay in the local record and a new queued operation, advanced to the just-acknowledged server revision. Client-provided `updated_at` remains untrusted event metadata. Category schedule structure receives only basic object/kind validation. PostgreSQL does not duplicate the full recursive Zod validation of generic tracker definitions. Tombstones reserve record IDs and owner/date uniqueness keys; retain them until all account devices have reconciled deletions.

### Hosted sync verification (manual, owner-reported)

The project owner reports successful manual tests against the hosted Supabase project for email authentication; Chrome → Brave and Brave → Safari synchronization; tracker archive synchronization; offline creation followed by sync; concurrent edit conflict detection, resolution, and propagation; repeated sync without duplicates; and account isolation through the UI. These are browser tests reported by the owner, not automated CI tests run by this repository. They do not cover all browsers, devices, network failure modes, or account deletion.

### Deletion and retention limitations

The tracker library supports **Archive** and **Move to Bin**. A deleted tracker, its full entry history, and its planning definition remain recoverable for 30 days. The Bin shows the countdown; restoring during that period preserves the same tracker and entry IDs. For an authenticated account, the server sets the authoritative tombstone time when the deletion syncs. An offline device displays permanent deletion as pending and retains all local content until the server confirms it.

After the forward migration is verified and the feature is explicitly enabled, **Permanently delete** requires a confirmation and erases the tracker, entries, and receipts that may contain their payloads from the account and synchronized devices. A durable owner-scoped ledger row remains indefinitely. Sync and import paths check that ledger before accepting old tracker/entry writes or replaying old receipts, preventing an offline device or old backup from recreating the cloud tracker. A permanent-delete RPC checks the current server revision and serializes against sync writes with a per-account/tracker transaction lock. This behavior has not been enabled for production.

The hourly `pg_cron` cleanup job purges account Bin rows whose server tombstone is at least 30 days old in bounded batches; it retains ledger rows. The migration creates the active job but leaves `tracker_deletion_cleanup_control.enabled=false`. After migration, inspect `supabase/verification/verify_tracker_bin_deletion.sql`; enable cleanup only when its checks pass, the job is active at `17 * * * *`, and an operator has verified a successful job run. In **Database → Cron Jobs**, monitor the job's last run/status. If runs fail or stop, leave the app feature flag off, preserve the Bin content, and repair the Cron/extension configuration before enabling deletion. The cleanup function is not client-executable. Guest data has no server; expired guest Bin content is removed locally the next time that guest workspace opens.

The migration is `supabase/migrations/20261010000100_tracker_bin_permanent_deletion.sql`. Apply it only after the generic tracker, sync write-boundary, planner v2, and v3 migrations are present. First run the SQL in the intended hosted project's SQL Editor, then run `supabase/verification/verify_tracker_bin_deletion.sql` there. Do not set `VITE_ENABLE_PERMANENT_DELETION=true` or enable the cleanup control until every verification row is true and the scheduled job has actually run successfully. To enable server cleanup after that verification, run this SQL manually in the same project:

```sql
update public.tracker_deletion_cleanup_control
set enabled = true, updated_at = clock_timestamp()
where id = true;
```

Then rerun the read-only verification script and confirm the control is enabled and the Cron job remains active. Only afterward set the GitHub Actions repository variable `VITE_ENABLE_PERMANENT_DELETION=true` for a reviewed application deployment. Leave it unset or `false` to keep permanent-deletion UI, ledger preflight, and requests gated off. Configure/enable the Supabase `pg_cron` extension in **Database → Extensions** first if the migration reports it is unavailable. Never enable the app flag if the cleanup job is missing or failing.

This migration is forward-only and irreversible at the data level. Once a tracker has been permanently purged, rollback cannot recover its cloud content; the permanent ledger must remain to reject stale devices. Do not drop the ledger or disable its sync check as a rollback. A normal application rollback to an older client can still be protected server-side, but users may see sync errors until they return to a compatible client. All active clients should be upgraded before allowing permanent deletion. Existing backups remain restorable for unrelated records; a later successful sync consults the server ledger and removes only permanently deleted IDs belonging to that account. An imported pending permanent-delete request is deliberately inert and requires a fresh confirmation.

The local pgTAP suite is `supabase/tests/tracker_bin_permanent_deletion.test.sql` (53 assertions declared). It checks migration objects, access grants, owner isolation, RPC retry behavior, stale receipt/tracker/entry rejection, restoration and expiry behavior, server timestamps, schema v1/v2/v3 constraint retention, and cleanup wiring. Browser tests cover Bin retention/restoration, account-scoped deletion requests, offline confirmation, backup resurrection defense, and preservation of unrelated data when IDs collide across entity tables. These do not prove hosted Cron execution or actual database lock contention; both require the manual hosted checks below. There is no in-app account deletion flow. Deleting a Supabase Auth user and uninstalling the app do not erase local IndexedDB copies on that user's devices.

## Dependency audit note

On 2026-10-09, the development-only Vitest toolchain was upgraded from Vitest 3.2.7 to 4.1.11. This updates `@vitest/mocker` from 3.2.7 to 4.1.11 and removes the vulnerable `tinypool` 1.1.1 dependency from the installed tree. After the update, `npm audit` and `npm audit --omit=dev` both reported zero vulnerabilities. Rerun both audits when dependencies change and periodically during maintenance.

`npm ci` may show npm's script-approval notices for esbuild and fsevents. The install, tests, typecheck, and production build succeed without approving those scripts; no install-script approval was added to the deployment workflow.

## Local development

Requires Node.js 20.19 or newer and npm.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

## GitHub Pages deployment

The production site is [https://sprahasingh.github.io/ProgressTracker/](https://sprahasingh.github.io/ProgressTracker/). Vite's `base` is `/ProgressTracker/`; React Router uses hash URLs such as `/#/trackers`, so GitHub Pages serves the same app shell on a refresh rather than looking for a server-side `/trackers` file. The auth callback returns to the current origin and pathname (`/ProgressTracker/`), then Supabase's PKCE client handles the callback query parameters.

### Required GitHub settings

1. In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.
2. In **Settings → Secrets and variables → Actions → Variables**, add these repository variables:

   | Variable | Value |
   | --- | --- |
   | `VITE_SUPABASE_URL` | The Supabase project URL |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | The project's `sb_publishable_...` key |
   | `VITE_ENABLE_TRACKER_SCHEMA_V3` | Optional; leave unset or `false` until the v3 migration is applied and verified, then set to `true` to enable v3 writes in production |
   | `VITE_ENABLE_TRACKER_SCHEMA_V4` | Leave unset or `false` until migration `20261012000100` is applied and verified; set to `true` only for a reviewed build that enables precision-aware v4 writes |
   | `VITE_ENABLE_PERMANENT_DELETION` | Leave unset or `false` until migration `20261010000100`, the owner-scoped ledger, and a successful scheduled cleanup run are verified; only then set to `true` |

   Supabase values are build-time public values and will be included in the browser bundle. Never use a Supabase secret key or legacy `service_role` key here. The workflow validates that the Supabase values are present without printing them and makes these variables available to the production build. When the schema-version feature variable is absent, writes and imports for that schema version stay disabled in production; set each flag only after its hosted SQL migration is verified. `VITE_ENABLE_PERMANENT_DELETION` is an independent feature gate and must remain false until the deletion migration and hosted cleanup schedule have been verified.

### How deployment runs

The workflow is `.github/workflows/deploy.yml`. A push to `main` runs `npm ci`, the Vitest suite, TypeScript typechecking, and the Vite production build. It then uploads `dist` as a Pages artifact and deploys it. Deployments are serialized to avoid overlapping updates. Actions are pinned to official releases/commit SHAs; build jobs receive repository read access, while only the deployment job receives Pages write and OIDC token permissions.

To deploy manually, open **Actions → Deploy to GitHub Pages → Run workflow**, select the `main` branch, and run it. A manual run from another branch fails before checkout. A failed install, test, typecheck, missing variable, or production build blocks the deployment job. The workflow has not been run against GitHub Pages from this workspace; do not consider the site deployed until a successful Actions deployment is visible and the production URL has been opened.

### Required Supabase Auth URLs

In the Supabase dashboard under **Authentication → URL Configuration**, set **Site URL** to `https://sprahasingh.github.io/ProgressTracker/` and include these exact values in **Redirect URLs**:

- `https://sprahasingh.github.io/ProgressTracker/`
- `http://localhost:5173/ProgressTracker/`

Keep the email provider enabled and use the Supabase redirect placeholder in confirmation and password-recovery email templates. The client callback uses the origin plus pathname, not the hash route. These settings are documented requirements; this implementation does not inspect or change the hosted Supabase dashboard.

### Troubleshooting

- **Missing production configuration:** check the two names under repository **Variables** (not Secrets); do not paste or log the values in workflow output.
- **Pages 404 or blank page:** confirm Pages source is **GitHub Actions**, the artifact contains `dist/index.html`, and the production address includes `/ProgressTracker/`. App routes should use the hash, for example `/#/history`.
- **Sign-in/recovery redirect rejected:** compare Supabase Site URL and Redirect URLs with the exact values above, including the trailing slash; check the email template redirect placeholder.
- **Workflow did not deploy:** inspect the failing build step in **Actions**. Deploy runs only for `main`; verify Pages workflow permissions and any `github-pages` environment protection rules.
- **Supabase client reports missing/invalid config:** verify the project URL is HTTPS and the browser key is the publishable `sb_publishable_...` value. Never substitute a service-role/secret key.

## Interface foundation

The interface uses semantic violet actions, cyan analytics, emerald success, amber attention, and coral error colors, with light/dark theme tokens. Shared `Button`, `Surface`, `PageHeader`, and `EmptyState` components establish reusable patterns. Navigation has four primary areas—Today, My Space, Insights, and Settings—with contextual links to Goals, Analytics, History, Wins, and Account & sync. All routes remain reachable on desktop and mobile. Tracker cards show each metric’s planned target or per-check-in threshold and link directly to Today when the tracker is scheduled. Today shows a schedule-aware progress summary and upcoming goal deadlines without adding them to the check-in count. The shell reflects local/sync status and opens account details. Tracker setup starts with four explained tracker types. Goal setup asks for a cumulative total, unit, and deadline with an estimated pace; habit setup defaults to daily check-ins. After creation, clear actions lead to the first check-in/progress, tracker library, or editing. Existing trackers keep their original target semantics and version. Advanced measures, thresholds, rule builder, custom fields, milestones, and planning controls are split into focused disclosures. Theme selection remains workspace-local, and reduced-motion and visible-focus behavior are retained. A pre-implementation findings and solution map is documented in `docs/UX_REDESIGN_AUDIT.md`; real-browser viewport and assistive-technology verification remain manual follow-up.

### Installable app and offline shell

The production build includes a web app manifest and service worker scoped to `/ProgressTracker/`. When the browser supports installation, the header offers an **Install app** action; Safari users can use the browser's **Add to Home Screen** option. The service worker caches the app shell and same-origin static build assets so the interface can reopen offline. It does not cache Supabase/API requests, authentication responses, or productivity records; IndexedDB remains the only local record store. Service worker registration is production-only. Verify installation and offline startup on target browsers/devices before relying on them; this workspace build has not been deployed or browser-tested.

## Planned architecture

IndexedDB provides the immediate local persistence layer through Dexie repositories. Guest and authenticated account workspaces are isolated locally; account-scoped sync uses Supabase after account workspace activation, reconnection, and committed tracker, entry, and holiday edits in the signed-in workspace, with manual sync available, and requires the applicable write-boundary migrations to be applied. The deployed static application will not include a custom backend. No analytics service is configured.

## Global holidays and breaks

The **Holidays & Breaks** destination is available from My Space and the mobile More menu. A single date or inclusive date range can be marked with an optional Travel, Exam, Personal, or Other reason. Each date is stored as one account-wide record, so it applies to every tracker and goal without editing tracker schedules. Removing a date creates a sync tombstone; the removed-date list can restore it. Existing tracker entries are retained and visible in History, even when that date is shown as a blue holiday.

Calendar and planner status meanings are consistent and do not rely on color alone: green check means the daily success rule was met; orange half-circle means values were logged but the rule was not met; red exclamation means an elapsed scheduled day was missed; blue sun means a global holiday. Holidays are excluded from streak opportunities, missed-day counts, weekly consistency, daily recurring plan denominators, cumulative expected pace, and allocation suggestions. They do not add to a streak. Recorded incremental progress on a holiday remains actual progress and is still included in its metric total. Streak qualification can use its per-metric configured threshold even when a stricter daily success rule is not met.

Holidays are date-only values in the workspace time zone. Date-range expansion uses calendar-day arithmetic and does not shift dates across daylight-saving transitions. Guest holidays remain in the guest IndexedDB. Account holidays are isolated with the account workspace and synchronize through the authenticated `apply_account_holiday_sync_operation` RPC, an owner-filtered read policy, server revisions, and a private idempotency receipt table. Local changes and their account outbox entries commit in the same IndexedDB transaction. Backups include holidays and queued holiday writes; earlier backup versions remain importable with no holiday rows.

The forward-only migration is `supabase/migrations/20261011000100_global_holidays.sql`. It creates `public.account_holidays`, enables owner-only RLS reads, revokes direct client writes, and grants the account-scoped RPC permission. This workspace has not applied the migration to hosted Supabase. Start the local Supabase stack without resetting it, then inspect local migration history:

```bash
supabase migration list --local
```

If `20261010000100` is missing from local history even though the permanent-deletion schema is already present and `tracker_bin_permanent_deletion.test.sql` passes, record that existing migration in **local history only**. This changes migration bookkeeping and does not execute its SQL:

```bash
supabase migration repair 20261010000100 --status applied --local
```

Then apply the pending migrations and run the database suite:

```bash
supabase migration up --local
supabase test db
```

After the local suite passes, review and apply that migration in the intended hosted project's SQL Editor before deploying the app changes. Until the migration is applied, account holiday uploads/downloads will fail safely and stay queued locally; guest mode works locally. All signed-in clients need the migration for cross-device holiday sync. Older app clients ignore holidays because the table is additive and tracker definitions are unchanged.
