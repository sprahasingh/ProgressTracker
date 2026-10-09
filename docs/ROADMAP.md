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
- `src/db` remains the IndexedDB adapter. The v3 upgrade uses pure legacy projections and retains original rows/IDs/tombstones in the legacy stores.
- Future cloud persistence requires additive, forward-only migrations and RLS/pgTAP coverage. Keep sync transport out of components and do not treat client timestamps as trusted concurrency data.

## Stages

1. **Generic domain foundation** — completed: versioned generic tracker/entry types, validation schemas, and non-destructive projections from legacy categories and daily entries.
2. **Pure domain behavior** — completed in this phase: deterministic achievement classification, nested AND/OR/at-least rule evaluation, rest-day-aware workload distribution, recalculation, and deadline state results. Timezone-aware schedules and richer recurrence semantics remain limitations to close before shipping UI.
3. **IndexedDB evolution** — completed in this phase: Dexie v3 generic tracker/entry tables and a transactional projection of legacy categories/entries, verified from v1/v2 fixtures and after reopen. Original legacy rows remain intact.
4. **Cloud schema evolution** — implemented in this phase as an additive migration and pgTAP coverage for generic tracker ownership, cross-user references, tombstones, and revisions. Hosted application remains a user-run dashboard step; no hosted project was accessed.
5. **Tracker setup flows** — implemented in this phase: local tracker list/create/edit/archive with schedule and date setup, first metrics, type-aware defaults, and Zod validation.
6. **Metrics and rules editor** — completed in this phase: editable multi-metric definitions, numeric/duration/checklist measures, directional thresholds, streak qualification, nested AND/OR/at-least rules, typed custom fields, and metric-linked milestones.
7. **Daily logging and adaptive schedules** — completed: Today filters by deterministic schedule occurrences, captures configured metric/custom-field values, supports skip/update/clear, persists local tombstones, and explains configured rule qualification. IndexedDB only; no sync.
8. **Challenges and rewards** — completed: pure streak summaries count qualifying scheduled occurrences, treat rest days as neutral, keep the current day open until explicitly logged or elapsed, and preserve personal-best streak rewards after missed opportunities. Default points and milestone rewards are deterministic and derived from retained entries; no persistence or UI was added.
9. **Dashboard and history** — completed: Overview summarizes active trackers, recent success/consistency, derived rewards, current-month calendar activity, and per-tracker streak/latest-value progress; History filters real entries by tracker and 7/30/90-day range. No sample activity, edits, or cloud reads are introduced.
10. **Quality pass** — code-level pass completed: keyboard skip-to-content and route navigation, semantic calendar table, field labels/status messages, retry and empty states, responsive CSS breakpoint review, and connected Today → Overview → History test coverage. Manual real-browser viewport and screen-reader verification remains.
11. **Authentication expansion** — completed: retain magic-link sign-in and add email/password sign-up/sign-in, neutral password-reset requests, recovery-session password update, and password setup/change for signed-in magic-link users. UI and service behavior are covered by mocked tests; hosted inbox delivery/configuration remains owner-verified.
12. **Offline/cloud sync** — only after the data model stabilizes, implement account ownership/bootstrap, idempotent operations, conflict resolution, tombstone propagation, retries, and recovery UI.

Backup/export, timezone/account settings, installable PWA behavior, and deployment automation should be planned as separately reviewable work where they fit the finalized product flows.

## Known limitations and risks

- Generic definitions and entries are persisted in IndexedDB. Tracker create/edit/list/archive and current-day check-in flows use local repository methods; cloud writes are not implemented. Legacy records continue to be retained as compatibility copies.
- The setup screen supports a compact set of schedules. Rule summaries/preview, reorder controls, checklist progress calculation, and richer conditional custom-field behavior are future refinements.
- The read-only legacy projection maps each old category to a boolean habit with one completion metric. It cannot infer quantitative progress from the free-form note field.
- Category schedules lack an explicit timezone. The current Today screen uses the device's local calendar date; changing travel/account timezone behavior and timezone-aware history/streak semantics remain future work.
- Generic metric and rule schemas are versioned, but future migrations still need explicit conversion rules and compatibility tests.
- Generic cloud tables are now defined, but the new app client does not read or write them. Apply the new migration to the hosted project and verify it before any future client integration. The pgTAP suite is present but was not run because the local database was unavailable in the prior implementation turn.
- Authentication supports magic links, email/password registration and sign-in, recovery, and setting a password for existing accounts. Hosted Supabase email templates/provider configuration and real inbox delivery require project-owner verification; automated tests mock auth responses and do not perform hosted end-to-end flows. Sync remains unimplemented.
- Daily logging currently covers today's scheduled trackers only. Past-date history, analytics, goal/reward UI, and tombstone cleanup are not implemented. Weekly/monthly quota prompts use deterministic evenly spaced calendar dates and do not rebalance around missed check-ins.
- Overview shows only the current local month and active trackers; History has fixed 7/30/90-day ranges and is read-only. Custom calendar navigation, arbitrary date ranges, historical edits, and cloud-backed history are future work.
- Responsive layouts have been reviewed in CSS and exercised structurally in jsdom, but not visually in a real browser viewport. Screen-reader behavior has semantic markup and accessible-name tests but still needs manual assistive-technology verification; no browser automation or screen reader is available in the current environment.
- Streak and reward values are derived from available entry history, not stored in a reward ledger. Historical edits/deletions can recalculate earned points and milestones; future sync must define how retroactive changes and account merges affect reward history.
- Phase 2 planning currently treats dates as UTC calendar dates and has a deliberately simple cadence model; monthly/weekly quotas are approximate distribution rules, not a timezone-aware recurrence engine. Daily recurring and cumulative-deadline are caller-selected modes and both return deadline/status information; product policy for carrying missed work forward must be finalized before UI integration.
