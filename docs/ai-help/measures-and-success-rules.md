# Measures, check-in values, and success rules

A measure is one named value recorded as part of a tracker check-in. Measures let a tracker record more than a simple completed/not-completed state. They are the values used by thresholds, goal plans, milestones, history, and analytics.

## Choose a measure type

New measures can be **Yes/No** or **Quantity**.

- Choose **Yes/No** for a state with two answers, such as “Did I stretch?” or “Did I take a break?”. A true value can qualify according to the tracker’s rule; false is still a recorded answer, but does not satisfy a true condition.
- Choose **Quantity** for a nonnegative number, such as pages, minutes, repetitions, or dollars. Add a unit when it clarifies what the number represents. Precision controls the allowed increment and does not silently round saved targets.

Each tracker needs at least one active measure. It can have multiple measures, each with its own stable ID, name, type, unit, precision, and thresholds. For example, a study tracker could record “Minutes” as Quantity and “Reviewed notes” as Yes/No. Units stay independent per measure.

## Legacy measure formats

Some existing trackers may still contain **Duration** or **Checklist** measures. They remain readable and usable for existing definitions, but new measures cannot select those types.

Duration is a legacy nonnegative numeric value, commonly interpreted with a unit such as minutes. A legacy Checklist has named items with separate checked states. It is not a single Yes/No answer: the check-in retains each checked item, and supported threshold, milestone, and planning calculations use the checked-item count. For a new tracker, use separate Yes/No measures when each named item needs its own state, or Quantity when only a total count matters.

## Editing, type immutability, and retirement

After a measure is saved, its type cannot be changed. A saved measure with recorded values must retain the name, unit, type, and meaning needed to interpret that history. To track something different, add a new measure and keep the old one for its existing entries.

An unsaved measure can be removed. A saved measure with no references or history may be removed safely. A measure with history should be **retired**, not deleted: it disappears from future check-in forms while its definition and values remain available in History and Analytics. Retired measures cannot be reactivated. Keep at least one active measure for future check-ins. If rules, milestones, or goal plans refer to the measure, resolve those references before retiring or removing it.

## Thresholds versus goal targets

Quantity measures can define per-check-in achievement levels:

- **Minimum** is the first threshold that counts as some achievement.
- **Target** is the intended per-check-in result.
- **Stretch** is a higher achievement level.

These thresholds classify a single check-in. A planning target describes progress expected repeatedly or accumulated over a date range; it is configured separately. For example, a per-check-in Target of 20 pages is not automatically the same as a cumulative goal total of 500 pages.

When direction is **increase**, a value at or above a level reaches it. When direction is **decrease**, a value at or below the level reaches it. Numeric check-in values and thresholds are nonnegative. A zero increasing threshold can qualify every nonnegative value, so invalid always-qualifying configurations are rejected. Zero may still be meaningful for a decreasing target or as a planning boundary; do not assume every zero means “complete”.

## Success rules

A success rule answers: “Does this check-in qualify?” It does not change the stored value. Rules can compare a measure directly or test a configured threshold. Conditions can be combined with:

- **All (AND):** every condition must pass.
- **Any (OR):** at least one condition must pass.
- **At least N:** the selected number of child conditions must pass.

These groups can be nested. Boolean measures can be compared with Yes/No. Numeric and legacy Checklist values can be compared against supported thresholds or numbers. Conditions referencing a retired or removed measure must be resolved before the measure can leave the active configuration. A custom success rule should not be silently reset when a measure is removed.

Success qualification feeds streak and completion summaries. A recorded value may therefore appear in History even when it does not qualify for a streak. A scheduled day with no qualifying check-in is not the same as a rest day.

## Common choices and troubleshooting

- **“I only need to check whether I did it.”** Use Yes/No.
- **“I need to record how much.”** Use Quantity with a suitable unit and precision.
- **“Why can’t I convert an old measure?”** Its existing values were recorded using the saved type. Add a new measure for a different interpretation; retire the old one if it should no longer appear in new check-ins.
- **“Why is a check-in not counting toward my streak?”** Check the tracker’s success rule, the value recorded, whether the date is scheduled, the tracker’s active dates, and whether a holiday or strict mode changes the opportunity.
- **“Why can’t I retire this measure?”** Look for rule, milestone, or planning references, and confirm another active measure will remain.

Source references: `src/domain/trackers/types.ts`, `src/domain/trackers/schema.ts`, `src/domain/trackers/invariants.ts`, `src/domain/trackers/progression.ts`, `src/features/trackers/TrackerConfigurationEditor.tsx`, `src/features/trackers/trackerSetupSchema.ts`, `src/features/trackers/TrackerSetupPage.tsx`, `src/features/trackers/TrackerSetupPage.test.tsx`, `src/domain/trackers/schema.test.ts`, `src/db/localRepository.ts`, `supabase/migrations/20261018000100_tracker_metric_integrity.sql`.
