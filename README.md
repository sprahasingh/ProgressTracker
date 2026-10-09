# ProgressTracker

A local-first personal productivity app for daily consistency, focused work, and measurable goals.

## Project status

The project has generic tracker setup, multi-metric success-rule editing, adaptive planning, local persistence, account-isolated IndexedDB workspaces, Supabase magic-link and email/password authentication, daily check-ins, dashboard summaries, history, and explicit account-scoped sync for generic trackers and entries. See [the product and architecture roadmap](docs/ROADMAP.md).

## Tech stack

- React 19 and TypeScript with strict compiler checks
- Vite for development and production builds
- Tailwind CSS 4 for utility styling, with a small CSS layer for the initial visual system
- React Router using hash-based URLs for reliable navigation and refreshes on GitHub Pages
- React Hook Form and Zod for upcoming form workflows
- Supabase JavaScript client for optional account-based cloud integration
- Vitest, jsdom, and React Testing Library for upcoming domain and UI tests

## Application structure

- `src/app` contains the shared application shell.
- `src/routes` defines client-side navigation.
- `src/features` groups page-level work by product area.
- `src/components/ui` contains shared presentation primitives.
- `src/styles/tokens.css` defines color, type, and radius tokens used by the interface.
- `src/test` contains shared test setup.

Shared UI components should remain presentation-focused. Product rules belong in domain modules as those features are introduced. The design tokens include a dark palette hook (`data-theme="dark"`); appearance controls are not implemented yet.

## Generic tracker domain foundation

`src/domain/trackers/types.ts` defines a storage-independent, schema-versioned tracker model for habits, goals, challenges, and projects. It represents schedule variants, typed metrics and thresholds, nested qualification rules, custom fields, milestones, and dated entries with extensible JSON values. `schema.ts` validates definitions and entries with Zod at data boundaries, including schedule ranges, threshold ordering, metric references, and custom-field option rules.

`legacyAdapters.ts` projects existing category and daily-entry records into this domain shape while preserving IDs and history. A legacy category is represented as a boolean habit, and completed/skipped entries retain their identity and metadata. Quantitative progress cannot be inferred from legacy free-text notes. Generic records are persisted locally by Dexie; the tracker library, setup forms, check-ins, outbox, and sync state use the local repository. Account-scoped cloud sync is explicit and requires the documented RPC migration. See `docs/ROADMAP.md` for the staged plan and known risks.

Pure planning and qualification calculations live in `src/domain/trackers/planning.ts`. They classify minimum/target/stretch levels, evaluate nested `all`/`any`/`at-least` rules across metrics, and distribute remaining work evenly over eligible days. Recalculate with updated completed work/dates to redistribute the remaining load. Plans report planned, rest, missed, early-completion, and overdue dates plus completion and overdue summaries. Callers choose `daily-recurring` or `cumulative-deadline` mode. These functions have no persistence, clock, timezone, or UI dependencies; the as-of date is an explicit input for deterministic calculations.

Current planning limitation: schedule cadence and quota handling are intentionally simple. Dates are UTC calendar dates; `times-per-week` and `times-per-month` choose approximate eligible work dates, not an optimized schedule. Before shipping the planner UI, define timezone behavior, exact quota windows, whether missed work rolls forward for each goal mode, and how completed work on unscheduled dates should affect plans. See the Phase 2 notes in `docs/ROADMAP.md`.

## Local data foundation

Dexie wraps IndexedDB behind `src/db/localRepository.ts`; components should call repository methods rather than access object stores directly. The versioned database contains categories, per-category daily entries, daily journals, goals, goal metrics, append-only metric progress snapshots, settings, and a pending sync operation table. Calendar dates are stored as `YYYY-MM-DD` strings, separate from event timestamps.

Database schema version 5 upgrades earlier installations transactionally. Version 3 adds generic `trackers` and `trackerEntries` stores and projects each legacy category and daily entry into them, preserving the existing IDs, date, note, timestamps, completion/skipped state, and tombstones. Version 4 adds workspace metadata; version 5 adds account-owned sync jobs, server revision state, and retained conflict records, and queues existing authenticated-workspace tracker data for sync. The original legacy stores are retained unchanged as compatibility copies. Guest and per-account workspaces use separate IndexedDB databases. Guest import is an explicit, recoverable copy; source rows remain in the guest workspace. Daily entries have a unique category/date index and generic tracker entries have a unique tracker/date index. Repository methods validate calendar dates and use date strings as daily identity, separate from timestamps. Progress history stores each recorded value; it does not keep only a mutable current total.

The tracker library and setup screens use local repository methods to list, create, edit, and archive generic trackers. Setup supports multiple boolean, quantity, duration, and checklist measures; increasing/decreasing minimum, target, and stretch thresholds; streak qualification; nested AND/OR/at-least success rules; typed custom fields; and milestones linked to measures. Checklist thresholds count completed items and cannot exceed the checklist length. Schedule controls include daily, weekdays, three-times-weekly, or flexible options with optional start/deadline dates. Tracker type and creation identity are stable after creation. Archiving retains data and archived trackers can be shown again; the flow does not physically delete records.

## Daily check-ins

The Today screen shows active trackers scheduled for the device's current local calendar date. It supports boolean, quantity, duration, checklist, and configured custom-field inputs; required fields are checked before saving. Each tracker has at most one generic entry per date: edits preserve that entry's ID, and clearing creates a local tombstone that a subsequent save restores. Skips are recorded as an outcome. Recorded values are evaluated against the tracker's configured success rule and the screen explains whether it qualified. Check-ins save to IndexedDB and enqueue account-scoped work; cloud changes run only when the signed-in user explicitly starts sync.

Schedule occurrences are deterministic for every supported schedule kind. Weekday schedules use JavaScript weekday numbering (Sunday 0). Every-N-days anchors to `startDate`, or the tracker's creation date when no start is configured. Quota schedules choose evenly spaced dates when no preferred weekdays are set; this is a simple recurring prompt schedule, not a capacity optimizer. Today uses the device's local date, while planning calculations continue to use explicit UTC calendar-date strings. Account timezones, check-in history/editing for past dates, analytics, and cloud synchronization for legacy records/settings are future work. Local tombstones are retained; there is no purge/retention process yet.

## Streaks and progression rewards

`src/domain/trackers/progression.ts` provides pure `calculateStreak` and `calculateProgressRewards` functions. Streaks count qualifying scheduled occurrences, not calendar days: rest days do not increment or break a streak, while a missed, skipped, or below-rule scheduled entry resets the current run. An unlogged occurrence on the supplied `asOfDate` remains open; an explicit skip or failed entry on that date counts as a miss. When a tracker has a success rule, that rule determines qualification. Without one, the first metric's configured streak qualification (minimum, target, or any recorded value) is used.

The default reward policy grants 10 points for each qualifying retained entry and a one-time 25-point bonus for personal-best streak milestones of 3, 7, 14, 30, 60, and 100 scheduled occurrences. A missed day resets only the current streak; accumulated entry points and personal-best milestones remain derived from retained history. These are deterministic calculations, not stored rewards or UI: editing/deleting historical entries can recalculate the totals, and no reward ledger, redemption, or sync behavior exists yet. Pass an explicit `asOfDate` and optional reward policy for reproducible evaluations.

## Overview and history

The Overview route now summarizes actual local activity: active tracker count, successful scheduled check-ins over the rolling seven-day window, weekly consistency, derived reward points, current-month activity, and per-tracker current/best streaks with each latest recorded value. History lists actual entries with their values, notes, skip/success state, and filters for a tracker and the last 7, 30, or 90 days. The activity calendar covers the current local month. These views use `listTrackerEntriesBetween` and never seed sample activity. They remain device-local and read-only; past entries cannot be edited from History, calendar month navigation and longer custom date ranges are not available, and there is no cloud sync.

## Quality and accessibility checks

The app shell provides a keyboard skip link, named primary/mobile navigation, visible focus, and reduced-motion styling. Forms use associated labels and fieldsets; loading, errors, and qualification feedback use status/alert semantics. The activity calendar is a semantic table, and History filter counts are announced politely. Today, Overview, and History have local-data, empty/error/retry, and navigation coverage in Vitest. Responsive breakpoints at 1100, 760, and 380 pixels were reviewed in CSS. A real browser viewport sweep and assistive-technology session remain manual follow-up: this environment has no installed Playwright/browser runner or screen reader.

IndexedDB schema upgrades run as a database transaction; tests cover upgrades from both v1 and v2 fixtures, preservation of legacy records/tombstones, and reading migrated rows after closing and reopening the database. Generic tracker definitions are validated before local writes.

## Supabase configuration

The browser client is optional until configured. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. The publishable key is expected to be visible in a client bundle; database access must be protected by authenticated sessions and Row Level Security. Never place a Supabase secret key or legacy `service_role` key in Vite variables. Local IndexedDB use does not require Supabase configuration.

## Email authentication

ProgressTracker supports passwordless email sign-in, email/password sign-up and sign-in, password reset, and password setup/change for signed-in users. A password reset uses Supabase's recovery email; the verified `PASSWORD_RECOVERY` event opens the password form. Users who first joined with a magic link can sign in with that link and set a password from the account screen. The magic-link flow remains available alongside password sign-in. Passwords must contain at least 8 characters in the client; configure any stronger password rules in Supabase Auth. The callback uses PKCE and returns to the current app path, compatible with the GitHub Pages repository path and hash-based client routing. The Supabase JS client persists the session locally and refreshes it. Productivity data remains local-first and sync is user-triggered.

In **Authentication → URL Configuration**, set the Site URL to `https://sprahasingh.github.io/ProgressTracker/` and add that URL plus `http://localhost:5173/ProgressTracker/` to the allowed Redirect URLs. Keep the Email provider enabled under **Authentication → Sign In / Providers**. Configure confirmation and password-recovery email templates to use Supabase's redirect placeholder so links return to the app URL requested by the client. For a new account, Supabase may require email confirmation before sign-in depending on project settings; the app displays confirmation guidance when no session is returned. Supabase's built-in email sender is limited to project organization members and 2 emails per hour; broader delivery requires custom SMTP, which is not configured by this project.

Password reset responses intentionally use neutral copy so the UI does not reveal whether an email address has an account. A recovery link must be valid and successfully exchanged by the Supabase JS PKCE client before the password form is shown. Password policy enforcement, email delivery, rate limits, confirmation requirements, and redirect allow-list behavior are controlled by Supabase project settings and must be verified in the hosted project. Browser authentication enables account access only; the app still reads and writes productivity data locally.

### Local workspace isolation

The original `ProgressTracker` IndexedDB database remains the guest workspace. Each signed-in Supabase user opens a separate local database keyed to that authenticated user ID. Switching accounts closes the current workspace, temporarily blocks record screens, clears them from the rendered route tree, and opens the new account's database. Offline edits and queued local operations remain in that account's database across sign-out and later sign-in. Cloud transfer runs only after the user explicitly selects **Sync this account**.

When an account first opens while guest data exists, ProgressTracker asks whether to copy that data into the account workspace or keep it separate. The copy includes existing local records and tombstones, retains stable record IDs, and leaves the guest source untouched. It runs as a local transaction with collision detection, post-copy verification, and a per-account completion marker; retrying after interruption is safe. If a different record already uses the same ID, the transaction stops without overwriting either copy. The user can keep the guest workspace separate and ask for import again only through a future explicit flow. Pending guest sync operations are not copied into an account queue.

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

For offline sync, mutable entities carry `updated_at`, `deleted_at`, and server-maintained `server_changed_at` and `server_revision` fields. `updated_at` is client event metadata, not a trusted sync cursor or concurrency token. `server_changed_at` is an indexed scan hint, not a commit-safe cursor. New rows start at revision 1; triggers reject stale revisions with SQLSTATE `40001`. The additive `20261009000200_sync_write_boundary.sql` migration adds a `SECURITY DEFINER` RPC that derives the owner from `auth.uid()`, also checks the caller's expected workspace user ID, performs inserts/updates only when the expected revision matches, returns conflicts without overwriting the row, and atomically records per-user operation receipts for safe retries. The receipt table has RLS enabled and no direct client grants. The browser calls this RPC only when the signed-in user explicitly chooses **Sync this account**; failed writes remain queued and conflicts are retained for review.

`deleted_at` is a tombstone, not a physical delete. Unique owner/date constraints intentionally include tombstoned daily entries and journals: a new UUID cannot create a second logical record for the same day, but the original UUID can be restored by setting `deleted_at` to null with its current `server_revision`. Do not purge tombstones until every device that may have missed the deletion has synchronized. Composite foreign keys remain enforced for tombstoned parent/child rows; physical parent deletion is restricted while any child history references it. Soft-deleted parents can still be restored without changing their IDs. Foreign keys enforce ownership and parent existence, but do not block a child from referencing a soft-deleted parent; current sync ordering uploads parents first, but explicit lifecycle validation and parent/child restore policy remain open work.

### Apply the original migration safely

1. Confirm the Supabase dashboard is on the intended ProgressTracker project and that authentication is enabled. Do not paste any secret or service-role key into the SQL Editor.
2. Open **SQL Editor → New query**. Open the migration file above locally and copy its complete contents into the editor. It is a transactional, app-table-only migration, uses `create table if not exists`, and replaces its named policies so it can be safely re-applied during development.
3. Review the selected project and SQL, then click **Run** once. Do not run on production data if app tables with these names already exist but have a different schema; inspect and reconcile first. The current project step assumes no ProgressTracker cloud tables exist. The SQL Editor does not register a Supabase CLI migration-history row; if CLI migrations are adopted later, reconcile this version in `supabase_migrations.schema_migrations` with `supabase migration repair --status applied 20261008000100` before running later migrations.
4. Verify the seven original tables in **Database → Tables** and confirm each shows RLS enabled. The client publishable key can only use the authenticated role after sign-in; never grant `anon` access.

### Apply the generic tracker migration

The hosted project already has the original schema migration applied. To add the generic tables, open `supabase/migrations/20261009000100_generic_trackers.sql` locally and copy the complete SQL into a new **SQL Editor** query in the intended Supabase project. Review the project and query, then run it once. It requires standard Supabase Auth roles and creates only `trackers` and `tracker_entries`; it does not backfill or alter legacy rows. It is versioned and intended to run once, so do not paste it repeatedly or rerun the original migration.

Verify that `trackers` and `tracker_entries` exist under **Database → Tables** and both show RLS enabled. The `tracker_entries_tracker_owner_fk` constraint combines owner and tracker IDs, preventing cross-account references. The account screen can write to these tables only through the authenticated sync RPC after its migration is installed.

### Apply the sync write-boundary migration

Only after the generic tracker migration has been applied, open `supabase/migrations/20261009000200_sync_write_boundary.sql`, copy it into a new SQL Editor query in the same intended project, review it, and run it once. It creates the private `sync_operation_receipts` table and the `apply_tracker_sync_operation` RPC. Verify the function exists under **Database → Functions**, receipts have RLS enabled, and `anon` has no execute grant. The app has an explicit account-scoped sync action; use it only after this migration is applied to the intended hosted project. Local pgTAP coverage is in `supabase/tests/sync_write_boundary.test.sql` and declares 17 assertions.

To verify locally, run `supabase start`, then `supabase migration up --local`, then `supabase test db`. The migration command applies pending migrations to the local database without resetting it; the test command runs all three pgTAP files in rolled-back transactions. This uses only the local Supabase stack and does not contact the hosted project. The suites contain 106 assertions total: 55 for the original schema, 34 for generic tracker metadata/RLS/ownership/tombstones, and 17 for the sync write boundary and idempotent receipts.

If you later adopt `supabase db push`, note that running SQL Editor migrations does not add rows to the CLI migration history. Inspect `supabase_migrations.schema_migrations` first and use `supabase migration repair --status applied <version>` for each SQL-Editor-applied migration that is missing from history. Do not let CLI push replay an already-applied migration.

The original schema security checks are in `supabase/tests/progress_tracker_schema.test.sql` and use pgTAP. They test schema metadata, two simulated authenticated users, anonymous denial for all four operations, row filtering, attempted ownership reassignment, cross-user category/goal/metric foreign keys, revision conflicts, server timestamp integrity, tombstone uniqueness/restoration, parent-delete restrictions, and full account deletion cascades. All SQL tests use transaction-local fixtures and roll them back; they do not connect to or modify your hosted project. The browser app does not sync the seven legacy tables; its explicit sync action uses only the separate generic tracker tables.

Known limitations: sync is an explicit user action and currently supports only generic trackers and entries. Pull uses a full keyset scan because `server_changed_at` is not a commit-safe cursor. The account screen displays local and cloud conflict snapshots only after the active account workspace is ready, and lets you explicitly keep either version when the cloud row is readable by this account. “Keep this device” queues a retry against the displayed cloud revision; when two same-day entries have different IDs, it adopts the existing cloud ID before retrying. “Use cloud” replaces the local copy and removes its stale queued write. If the server cannot return a readable cloud row (for example, a cross-account ID collision), “Save local copy as new” assigns a fresh ID; for a tracker it also relinks its local entry history. These choices preserve the local payload, but resolving a same-day duplicate means selecting which values occupy that date. The client protocol and local pgTAP/RLS/receipt suite pass, but the hosted project migration and live sync flow have not been verified. Client-provided `updated_at` remains untrusted event metadata. Category schedule structure receives only basic object/kind validation. PostgreSQL does not duplicate the full recursive Zod validation of generic tracker definitions. Tombstones reserve record IDs and owner/date uniqueness keys; retain them until all account devices have reconciled deletions.

## Dependency audit note

On 2026-10-07, `npm audit --omit=dev` reported no production dependency vulnerabilities. The full audit reported one moderate and two critical findings in the development-only Vitest 3 toolchain (`@vitest/mocker` and `tinypool`); these do not ship in the GitHub Pages bundle. npm offered Vitest 5.0.3 as an automatic fix, which is a major upgrade with breaking changes, so it was not applied automatically. Re-audit before production CI is added and review a Vitest upgrade separately.

The same install reported npm's script-approval notice for esbuild 0.28.2. Its platform binary runs and the production build succeeds without approving that postinstall script, so no install-script approval or dependency change was needed for this foundation.

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

## Deployment path

Vite is configured to build assets under `/ProgressTracker/`, matching the GitHub Pages repository URL. Client navigation currently uses hash URLs so direct page loads and refreshes do not depend on server-side route rewrites. Automated GitHub Pages deployment will be added in a later step.

## Interface foundation

The current visual language uses a muted botanical green accent, warm neutral surfaces, editorial serif headings, and restrained borders. Shared `Button`, `Surface`, `PageHeader`, and `EmptyState` components establish reusable patterns. The layout includes a compact mobile navigation and honors reduced-motion preferences. Theme switching and the final accessibility review remain future steps.

## Planned architecture

IndexedDB provides the immediate local persistence layer through Dexie repositories. Guest and authenticated account workspaces are isolated locally; the account-scoped sync flow uses Supabase only when the user explicitly starts it and the write-boundary migration has been applied. The deployed static application will not include a custom backend. No analytics service is configured.
