# ProgressTracker UI/UX redesign audit

Reviewed before implementation on 2026-10-09. This is a frontend presentation and interaction pass over the existing React routes, tracker editor, Today check-in flow, planner, analytics, authentication/workspace controls, and shared CSS. It does not change persistence or synchronization semantics.

## Findings and solution map

| Area | Current friction | Proposed treatment |
| --- | --- | --- |
| Navigation | Seven equally weighted links split daily work, goal setup, and insights. Mobile renders only the first six, hiding Achievements. | Use four primary areas—Today, My Space, Insights, and Settings—with related goals, analytics, history, wins, and account destinations grouped beneath them. Preserve every route on mobile and desktop. |
| Visual system | A quiet green palette and scattered literal colors make hierarchy weak and some statuses inconsistent across light/dark themes. | Use shared semantic tokens for violet/blue actions, cyan insights, emerald success, amber attention, and coral errors. Keep contrast and focus indicators explicit; derive component states from tokens. |
| Tracker setup | Creation opened the entire metrics/rules/custom-fields/milestones/planning editor, even for a simple habit or goal. The default habit was a yes/no measure without an obvious target/deadline path. | Keep type-specific name/target/deadline/frequency controls in the first view. Put thresholds, multiple measures, rule, custom fields, milestones, and planning controls in labeled focused disclosures. Existing values remain loaded and saved. |
| Today | Check-ins are available, but there is no compact progress summary or visible path to the next useful action. | Add a truthful scheduled/completed summary and concise progress cue, keep existing per-tracker forms and rule evaluation, and make empty/loading/error states direct users to the next step. Never infer success for unlogged or rest days. |
| Goals and planner | Rich per-metric planning is present but presented as dense card details; saved allocations and actual progress need stronger visual distinction. | Improve headings, spacing, labels, and semantic color use around the existing daily/cumulative visuals and planner preview/save state. Preserve the v3 production write gate and existing mode-specific target data. |
| Analytics | Accurate per-metric data is present, but visual hierarchy and chart descriptions are subdued. | Highlight period controls, workspace-derived summary figures, per-metric units, and accessible chart descriptions without combining measures or manufacturing statistics. |
| Responsive/accessibility | Mobile navigation is crowded; several visual colors are hardcoded; reduced motion support exists but interactions need a consistent focus and touch target treatment. | Reflow cards/forms at narrow widths, keep all destinations reachable, increase control hit areas, use theme-aware tokens and visible focus, and honor reduced-motion preferences. |

## Tracker creation follow-up

The original page asked every tracker kind to complete the same core form. Its type selector did not explain the kinds, new goals exposed a per-check-in threshold where users expected a total target, and creation returned to the library without a direct next action. The follow-up below records the implemented solution.

Implemented locally: the type choices now explain Habit, Goal, Challenge, and Project. A new Goal takes a total amount, unit, and deadline, defaults to a 30-day period, and displays an estimate per scheduled day. It saves as a cumulative-deadline goal with incremental progress semantics; the default per-check-in threshold stays a separate value. New habits default to daily yes/no check-ins. After save, users can record progress/check in, open the relevant library, or customize. Existing legacy goals retain their schema version and existing per-check-in target meaning during edits. Advanced measures/success levels, success conditions, extra check-in details, milestones, and planning each have their own disclosure. Automated tests cover new habit/goal journeys, legacy goal edits, project advanced configuration, and custom schedules. Device-size and screen-reader checks remain manual.

The shell groups primary links into Today, My Space, Insights, and Settings. Goals appear under My Space; Analytics, History, and Wins appear under Insights; Preferences and Account & sync appear under Settings. A four-item bottom bar keeps the groups on mobile and a labeled More menu keeps the secondary destinations reachable. Sync state is presented in the top bar and links to account details. Today adds a compact near-term deadline list that stays separate from its scheduled check-in count. Tracker cards now summarize each metric’s goal plan or per-check-in target and offer a direct check-in link only on scheduled days. History and empty states describe offline-first and account sync behavior accurately.

## Data and behavior invariants

- Existing tracker definitions, entries, account workspaces, guest data, IndexedDB transactions, outbox operations, Supabase sync, conflict handling, backups, and schema versions 1–3 remain owned by the current domain/repository layer.
- The simple setup surface is a progressive disclosure over the current configuration editor. Its target is explicitly labeled per check-in and remains distinct from goal-planning targets. Existing measure types are fixed in quick edit; changing a threshold is explicit, leaves saved entry values intact, and can change how historical entries qualify.
- Planned allocations remain separate from logged actual progress. V3 writes remain disabled in production until hosted migration verification is confirmed.
- Any summary uses existing deterministic schedule and evaluation functions; rest days and unlogged current dates are not counted as failures.
- Existing routes remain addressable, including Auth, History, Overview, Achievements, and Settings.
