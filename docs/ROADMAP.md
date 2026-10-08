# ProgressTracker roadmap

This roadmap describes the adaptive productivity and goal-tracking direction while keeping existing local records and the already deployed Supabase schema intact. Each implementation step should be separately reviewable, tested, and documented.

## Repository audit

- The current Today page is a welcome/empty-state shell; it does not yet provide routine logging, goal planning, streaks, analytics, or adaptive planning.
- Dexie v2 already stores categories, daily entries, journals, goals, metrics, progress snapshots, settings, and a pending-operation table. Existing IDs, timestamps, and deletion tombstones are useful compatibility anchors.
- `localRepository.ts` wraps local reads and writes. UI code should continue to use repositories rather than reach into Dexie directly.
- Supabase currently has seven user-owned tables with RLS and a locally passing 55-assertion pgTAP suite. That migration is treated as applied history and must not be edited or replayed against the hosted project as a schema redesign mechanism.
- Supabase magic-link authentication is present. Password authentication and synchronization are not part of the generic domain step.

## Architecture boundaries

- `src/domain/trackers` owns transport- and storage-independent tracker definitions, schedule shapes, metrics, qualification rules, custom fields, milestones, and entry values.
- Zod schemas validate persisted/imported/API-shaped values at boundaries. Evaluation and planning remain pure domain operations in a later step.
- `src/db` remains the IndexedDB adapter. Legacy adapters are read-only projections; introducing a generic domain model must not rewrite or delete existing rows.
- Future cloud persistence requires additive, forward-only migrations and RLS/pgTAP coverage. Keep sync transport out of components and do not treat client timestamps as trusted concurrency data.

## Stages

1. **Generic domain foundation** — define versioned generic tracker/entry types, validate schedules, metrics, rules, custom fields and milestones, and add non-destructive projections from legacy categories and daily entries. (Current step.)
2. **Pure domain behavior** — implement schedule occurrence and qualification evaluation with deterministic tests for time zones, threshold direction, nested rules, and edge dates.
3. **IndexedDB evolution** — add a forward Dexie version and converters that preserve legacy IDs/history/tombstones; test upgrades from representative v1/v2 fixtures and interruption/reopen behavior.
4. **Cloud schema evolution** — design a new migration that adds generic records or a normalized equivalent without modifying the applied initial migration; extend local pgTAP coverage for ownership, references, tombstones, and revisions.
5. **Tracker setup flows** — build create/edit flows for habits, goals, challenges, and projects with sensible defaults and validation.
6. **Metrics and rules editor** — support numeric/duration/checklist metrics, thresholds, custom fields, milestones, and nested qualification rules with accessible controls.
7. **Daily logging and adaptive schedules** — implement quick logging, skips, schedule-aware prompts, and explainable qualification states.
8. **Challenges and rewards** — add streaks and progression based on tested domain calculations; keep rewards motivational and recoverable after missed days.
9. **Dashboard and history** — replace the welcome shell with useful today, goal, calendar, and progress views; avoid fabricated sample activity.
10. **Quality pass** — verify responsive layouts, keyboard/screen-reader behavior, empty/error/loading states, and end-to-end flows.
11. **Authentication expansion** — add email/password sign-up, sign-in, password reset, and password setup for existing magic-link accounts while retaining the magic-link flow.
12. **Offline/cloud sync** — only after the data model stabilizes, implement account ownership/bootstrap, idempotent operations, conflict resolution, tombstone propagation, retries, and recovery UI.

Backup/export, timezone/account settings, installable PWA behavior, and deployment automation should be planned as separately reviewable work where they fit the finalized product flows.

## Known limitations and risks

- The new domain model is currently an in-memory validated contract; it is not yet used by UI or persisted in IndexedDB/PostgreSQL.
- The read-only legacy projection maps each old category to a boolean habit with one completion metric. It cannot infer quantitative progress from the free-form note field.
- Category schedules lack an explicit timezone. Schedule evaluation must define whether it uses the user’s selected timezone before streak or occurrence behavior is shipped.
- Generic metric and rule schemas are versioned, but future migrations still need explicit conversion rules and compatibility tests.
- Existing cloud tables describe the legacy model. Cloud support for generic trackers must be additive, preserve RLS ownership guarantees, and be verified before any client writes to it.
- Authentication remains magic-link only. Password flows and sync are deliberately later stages.
