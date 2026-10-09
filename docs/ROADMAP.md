# ProgressTracker roadmap

This roadmap describes the adaptive productivity and goal-tracking direction while keeping existing local records and the already deployed Supabase schema intact. Each implementation step should be separately reviewable, tested, and documented.

## Repository audit

- Today now provides current-day local check-ins; there is still no goal/history dashboard, streak/reward UI, analytics, or planner screen.
- Dexie v3 stores legacy categories/daily entries alongside the generic tracker/entry tables; journals, legacy goals, metrics, progress snapshots, settings, and pending operations remain in their original stores.
- `localRepository.ts` wraps local reads and writes. UI code should continue to use repositories rather than reach into Dexie directly.
- Supabase has the seven legacy user-owned tables plus forward-only generic `trackers` and `tracker_entries` tables, each protected by RLS. The original migration is treated as applied history and must not be edited as a schema redesign mechanism.
- Supabase magic-link authentication is present. Password authentication and synchronization are not part of the generic domain step.

## Architecture boundaries

- `src/domain/trackers` owns transport- and storage-independent tracker definitions, schedule shapes, metrics, qualification rules, custom fields, milestones, entry values, planning, streaks, and derived rewards.
- Zod schemas validate persisted/imported/API-shaped values at boundaries. Evaluation/planning are pure domain operations; the setup editor validates all configured nested values before persistence.
- `src/db` remains the IndexedDB adapter. Dexie v4 keeps the original database as the guest workspace and uses per-user database names for authenticated workspaces. Guest import is explicit, transactional, verified, and non-destructive.
- Future cloud persistence requires additive, forward-only migrations and RLS/pgTAP coverage. Keep sync transport out of components and do not treat client timestamps as trusted concurrency data.

## Stages

1. **Generic domain foundation** — completed: versioned generic tracker/entry types, validation schemas, and non-destructive projections from legacy categories and daily entries.
2. **Pure domain behavior** — completed in this phase: deterministic achievement classification, nested AND/OR/at-least rule evaluation, rest-day-aware workload distribution, recalculation, and deadline state results. Timezone-aware schedules and richer recurrence semantics remain limitations to close before shipping UI.
3. **IndexedDB evolution** — completed in this phase: Dexie v3 generic tracker/entry tables and a transactional projection of legacy categories/entries, verified from v1/v2 fixtures and after reopen. Original legacy rows remain intact.
4. **Cloud schema evolution** — implemented in this phase as an additive migration and pgTAP coverage for generic tracker ownership, cross-user references, tombstones, and revisions. Hosted application remains a user-run dashboard step; no hosted project was accessed.
5. **Tracker setup flows** — implemented in this phase: local tracker list/create/edit/archive with schedule and date setup, first metrics, type-aware defaults, and Zod validation.
6. **Metrics and rules editor** — completed in this phase: editable multi-metric definitions, numeric/duration/checklist measures, directional thresholds, streak qualification, nested AND/OR/at-least rules, typed custom fields, and metric-linked milestones.
7. **Daily logging and adaptive schedules** — completed: Today filters by deterministic schedule occurrences, captures configured metric/custom-field values, supports skip/update/clear, persists local tombstones, and explains configured rule qualification. Account workspaces enqueue generic tracker and entry changes for explicit sync; no background uploads run.
8. **Challenges and rewards** — completed: pure streak summaries count qualifying scheduled occurrences, treat rest days as neutral, keep the current day open until explicitly logged or elapsed, and preserve personal-best streak rewards after missed opportunities. Default points and milestone rewards are deterministic and derived from retained entries; no persistence or UI was added.
9. **Dashboard and history** — completed: Overview summarizes active trackers, recent success/consistency, derived rewards, current-month calendar activity, and per-tracker streak/latest-value progress; History filters real entries by tracker and 7/30/90-day range. No sample activity, edits, or cloud reads are introduced.
10. **Quality pass** — code-level pass completed: keyboard skip-to-content and route navigation, semantic calendar table, field labels/status messages, retry and empty states, responsive CSS breakpoint review, and connected Today → Overview → History test coverage. Manual real-browser viewport and screen-reader verification remains.
11. **Authentication expansion** — completed: retain magic-link sign-in and add email/password sign-up/sign-in, neutral password-reset requests, recovery-session password update, and password setup/change for signed-in magic-link users. UI and service behavior are covered by mocked tests; hosted inbox delivery/configuration remains owner-verified.
12. **Offline/cloud sync** — phased. **12a local account isolation (completed):** preserve guest data, create per-user IndexedDB workspaces, offer an explicit guest import/separate choice, and isolate rendered state on account switches. **12b server write boundary (implemented and locally pgTAP-verified):** account-bound RPC, expected-revision checks, idempotent receipts, and cross-owner protection. **12c client outbox/pull engine (implemented with explicit user initiation):** account-bound queued writes, revision metadata, full keyset pulls, tombstone propagation, retry retention, and conflict records; never merge rows whose owner differs. App and local database tests pass; hosted behavior remains unverified. **12d recovery UX (not started):** richer retry controls and user-directed conflict resolution. Use sync only after the write-boundary migration is applied to the intended hosted project.

Backup/export, timezone/account settings, installable PWA behavior, and deployment automation should be planned as separately reviewable work where they fit the finalized product flows.

## Known limitations and risks

- Generic definitions and entries are persisted in IndexedDB. Guest data remains in the original database; every authenticated account has a separate workspace. Account switching gates and unmounts record routes until the correct database is open. Guest import is copied transactionally and the guest source is retained. Sync is a user-triggered action and requires the account-scoped server RPC migration; no background uploads run.
- The setup screen supports a compact set of schedules. Rule summaries/preview, reorder controls, checklist progress calculation, and richer conditional custom-field behavior are future refinements.
- The read-only legacy projection maps each old category to a boolean habit with one completion metric. It cannot infer quantitative progress from the free-form note field.
- Category schedules lack an explicit timezone. The current Today screen uses the device's local calendar date; changing travel/account timezone behavior and timezone-aware history/streak semantics remain future work.
- Generic metric and rule schemas are versioned, but future migrations still need explicit conversion rules and compatibility tests.
- Generic cloud tables and the account-scoped sync client are implemented. Apply the write-boundary migration to the intended hosted project before using the explicit sync action; local PostgreSQL migration and all 106 pgTAP assertions have passed, while hosted behavior remains unverified.
- Authentication supports magic links, email/password registration and sign-in, recovery, and setting a password for existing accounts. Hosted Supabase email templates/provider configuration and real inbox delivery require project-owner verification; automated tests mock auth responses and do not perform hosted end-to-end flows.
- Guest import detects duplicate IDs with differing content and rolls the transaction back, retaining both workspaces. Merging those records requires a later user-directed conflict flow. Existing guest sync-operation records remain in the guest database and are not copied to account queues.
- Client-side IndexedDB separation protects against accidental cross-account display/upload by the app, but does not protect against access to the same browser profile or developer tools. The client binds queued work to the active account and the server boundary verifies ownership and revisions; hosted end-to-end behavior has not been exercised.
- The additive sync write-boundary migration and its 17 pgTAP assertions pass against the local Supabase database. The explicit sync action and transport unit tests are present; the hosted migration and live hosted behavior remain unverified.
- Daily logging currently covers today's scheduled trackers only. Past-date history, analytics, goal/reward UI, and tombstone cleanup are not implemented. Weekly/monthly quota prompts use deterministic evenly spaced calendar dates and do not rebalance around missed check-ins.
- Overview shows only the current local month and active trackers; History has fixed 7/30/90-day ranges and is read-only. Custom calendar navigation, arbitrary date ranges, historical edits, and cloud-backed history are future work.
- Responsive layouts have been reviewed in CSS and exercised structurally in jsdom, but not visually in a real browser viewport. Screen-reader behavior has semantic markup and accessible-name tests but still needs manual assistive-technology verification; no browser automation or screen reader is available in the current environment.
- Streak and reward values are derived from available entry history, not stored in a reward ledger. Historical edits/deletions can recalculate earned points and milestones; future sync must define how retroactive changes and account merges affect reward history.
- Phase 2 planning currently treats dates as UTC calendar dates and has a deliberately simple cadence model; monthly/weekly quotas are approximate distribution rules, not a timezone-aware recurrence engine. Daily recurring and cumulative-deadline are caller-selected modes and both return deadline/status information; product policy for carrying missed work forward must be finalized before UI integration.
