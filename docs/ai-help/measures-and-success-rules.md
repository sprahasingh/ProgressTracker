# Measures, check-in values, and success rules

A measure is one named value recorded as part of a tracker check-in. Measures let a tracker record more than a simple completed/not-completed state. They are the values used by thresholds, goal plans, milestones, history, and analytics.

## Choose a measure type

Every measure, including the primary measure, can use any of the same four types: **Yes/No**, **Quantity**, **Duration**, or **Checklist**.

- Choose **Yes/No** for a state with two answers, such as “Did I stretch?” or “Did I take a break?”. A true value can qualify according to the tracker’s rule; false is still a recorded answer, but does not satisfy a true condition.
- Choose **Quantity** for a nonnegative number, such as pages, minutes, repetitions, or dollars. Add a unit when it clarifies what the number represents. Precision controls the allowed increment and does not silently round saved targets.
- Choose **Duration** for a nonnegative time amount when the input should be presented and interpreted as elapsed time.
- Choose **Checklist** when a check-in should retain the checked state of several named items. Supported rules compare the number of checked items.

Each tracker needs at least one active measure. It can have multiple measures, each with its own stable ID, name, type, unit, precision, and thresholds. For example, a study tracker could record “Minutes” as Quantity and “Reviewed notes” as Yes/No. Units stay independent per measure.

Duration stores a nonnegative time amount, commonly interpreted with a unit such as minutes. A Checklist measure, including an existing legacy Checklist definition, is a checkbox list with named items and separate checked states; it is not a single Yes/No answer. Existing saved check-ins retain each item and its state, and supported rule comparisons use the checked-item count.

## Editing, type immutability, and retirement

Measure 1 and subsequent measures use the same type options. A measure with recorded values keeps its type, name, unit, and meaning so saved check-ins remain readable. If a measure has no recorded values, its type can still be changed. To track something different after recording history, add a new measure and retire the old one.

An unsaved measure can be removed. A saved measure with no references or history may be removed safely. A measure with history should be **retired**, not deleted: it disappears from future check-in forms while its definition and values remain available in History and Analytics. Retired measures cannot be reactivated. Keep at least one active measure for future check-ins. If rules, milestones, or goal plans refer to the measure, resolve those references before retiring or removing it.

## Thresholds versus goal targets

Quantity measures can define per-check-in achievement levels:

- **Minimum** is the first threshold that counts as some achievement.
- **Target** is the intended per-check-in result.
- **Stretch** is a higher achievement level.

These thresholds classify a single check-in. A planning target describes progress expected repeatedly or accumulated over a date range; it is configured separately. For example, a per-check-in Target of 20 pages is not automatically the same as a cumulative goal total of 500 pages.

When direction is **increase**, a value at or above a level reaches it. When direction is **decrease**, a value at or below the level reaches it. Numeric check-in values and thresholds are nonnegative. A zero increasing threshold can qualify every nonnegative value, so invalid always-qualifying configurations are rejected. Zero may still be meaningful for a decreasing target or as a planning boundary; do not assume every zero means “complete”.

## Success rules

A **Success Rule** answers: “Does this check-in count as a success?” It does not change the stored value. Rules can compare any configured measure directly or test a configured threshold. Boolean values use Yes/No comparisons; numeric values use numeric comparisons; Checklist values use checked-item counts. Conditions can be combined with:

- **All (AND):** every condition must pass.
- **Any (OR):** at least one condition must pass.
- **At least N:** the selected number of child conditions must pass.

These groups can be nested. Conditions referencing a retired or removed measure must be resolved before the measure can leave the active configuration. A custom success rule should not be silently reset when a measure is removed.

The **Streak Rule** independently decides whether a recorded check-in advances streak continuity. Choose **Same as Success Rule** to have it follow Success Rule changes, or **Custom Streak Rule** to define a separate condition. Existing v1–v7 trackers keep their original streak behavior until explicitly changed. A day can qualify for the streak without being successful, or be successful without advancing the streak. Only Success Rule qualification earns normal daily success XP. Streak bonuses require an eligible streak milestone. Schedules, Strict Mode, holidays, and rest days still determine which dates are opportunities.

## Common choices and troubleshooting

- **“I only need to check whether I did it.”** Use Yes/No.
- **“I need to record how much.”** Use Quantity with a suitable unit and precision.
- **“Why can’t I convert an old measure?”** Its existing values were recorded using the saved type. Add a new measure for a different interpretation; retire the old one if it should no longer appear in new check-ins.
- **“Why is a check-in not counting toward my streak?”** Check the Streak Rule, the value recorded, whether the date is scheduled, the tracker’s active dates, and whether a holiday or Strict Mode changes the opportunity.
- **“Why can’t I retire this measure?”** Look for rule, milestone, or planning references, and confirm another active measure will remain.

Source references: `src/domain/trackers/types.ts`, `src/domain/trackers/schema.ts`, `src/domain/trackers/invariants.ts`, `src/domain/trackers/progression.ts`, `src/features/trackers/TrackerConfigurationEditor.tsx`, `src/features/trackers/trackerSetupSchema.ts`, `src/features/trackers/TrackerSetupPage.tsx`, `src/features/trackers/TrackerSetupPage.test.tsx`, `src/domain/trackers/schema.test.ts`, `src/db/localRepository.ts`, `supabase/migrations/20261018000100_tracker_metric_integrity.sql`.
