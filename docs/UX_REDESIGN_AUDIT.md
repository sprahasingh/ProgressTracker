# ProgressTracker UI/UX redesign audit

Reviewed before implementation on 2026-10-09. This is a frontend presentation and interaction pass over the existing React routes, tracker editor, Today check-in flow, planner, analytics, authentication/workspace controls, and shared CSS. It does not change persistence or synchronization semantics.

## Findings and solution map

| Area | Current friction | Proposed treatment |
| --- | --- | --- |
| Navigation | Seven equally weighted links split daily work, goal setup, and insights. Mobile renders only the first six, hiding Achievements. | Make Today, Trackers, Goals, and Progress the four primary destinations. Put History, Overview, Achievements, Settings, and Account under a clearly labeled secondary menu that remains reachable on small screens. Preserve every route. |
| Visual system | A quiet green palette and scattered literal colors make hierarchy weak and some statuses inconsistent across light/dark themes. | Use shared semantic tokens for violet/blue actions, cyan insights, emerald success, amber attention, and coral errors. Keep contrast and focus indicators explicit; derive component states from tokens. |
| Tracker setup | Creation opens the entire metrics/rules/custom-fields/milestones/planning editor, even for a simple habit or goal. The default habit is a yes/no measure without an obvious target/deadline path. | Keep name, type, measure, target, deadline, and optional schedule in the first view. Put advanced rule, threshold, metric, field, milestone, and planning controls in a labeled disclosure. Reuse the existing editor unchanged inside it. Existing values remain loaded and saved. |
| Today | Check-ins are available, but there is no compact progress summary or visible path to the next useful action. | Add a truthful scheduled/completed summary and concise progress cue, keep existing per-tracker forms and rule evaluation, and make empty/loading/error states direct users to the next step. Never infer success for unlogged or rest days. |
| Goals and planner | Rich per-metric planning is present but presented as dense card details; saved allocations and actual progress need stronger visual distinction. | Improve headings, spacing, labels, and semantic color use around the existing daily/cumulative visuals and planner preview/save state. Preserve the v3 production write gate and existing mode-specific target data. |
| Analytics | Accurate per-metric data is present, but visual hierarchy and chart descriptions are subdued. | Highlight period controls, workspace-derived summary figures, per-metric units, and accessible chart descriptions without combining measures or manufacturing statistics. |
| Responsive/accessibility | Mobile navigation is crowded; several visual colors are hardcoded; reduced motion support exists but interactions need a consistent focus and touch target treatment. | Reflow cards/forms at narrow widths, keep all destinations reachable, increase control hit areas, use theme-aware tokens and visible focus, and honor reduced-motion preferences. |

## Data and behavior invariants

- Existing tracker definitions, entries, account workspaces, guest data, IndexedDB transactions, outbox operations, Supabase sync, conflict handling, backups, and schema versions 1–3 remain owned by the current domain/repository layer.
- The simple setup surface is a progressive disclosure over the current configuration editor. Its target is explicitly labeled per check-in and remains distinct from goal-planning targets. Existing measure types are fixed in quick edit; changing a threshold is explicit, leaves saved entry values intact, and can change how historical entries qualify.
- Planned allocations remain separate from logged actual progress. V3 writes remain disabled in production until hosted migration verification is confirmed.
- Any summary uses existing deterministic schedule and evaluation functions; rest days and unlogged current dates are not counted as failures.
- Existing routes remain addressable, including Auth, History, Overview, Achievements, and Settings.
