# Measures, check-in values, and success rules

A measure is one named value recorded as part of a tracker check-in. Measures let a tracker record more than a simple completed/not-completed state. They are the values used by thresholds, goal plans, milestones, history, and analytics.

## Choose a measure type

Every measure, including the primary measure, can use any of the same four types: **Yes/No**, **Quantity**, **Duration**, or **Checklist**.

- Choose **Yes/No** for a state with two answers, such as “Did I stretch?” or “Did I take a break?”. A true value can qualify according to the tracker’s rule; false is still a recorded answer, but does not satisfy a true condition.
- Choose **Quantity** for a nonnegative number, such as pages, minutes, repetitions, or dollars. Add a unit when it clarifies what the number represents. Precision controls the allowed increment and does not silently round saved targets.
- Choose **Duration** for a nonnegative time amount when the input should be presented and interpreted as elapsed time.
- Choose **Checklist** when a check-in should retain the checked state of several named items. Supported rules compare the number of checked items.

Each tracker needs at least one active measure. It can have multiple measures, each with its own stable ID, name, type, unit, precision, and thresholds. For example, a study tracker could record “Minutes” as Quantity and “Reviewed notes” as Yes/No. Units stay independent per measure.

When creating a tracker, the primary measure starts with a type-specific name: **Status** for Yes/No, **Progress** for Quantity, **Time Spent** for Duration, and **Items** for Checklist. These are editable defaults, not special status fields. If you change the primary measure type before saving, its default name follows the new type unless you have edited the name; a manually edited name is preserved. A secondary measure added to a saved tracker starts as **Measure 2**, **Measure 3**, and so on, and uses Quantity until you choose another type. Its name can be changed before it has history. Measure names are saved with the tracker definition; older and migrated trackers keep their saved names. Once a measure has history, its name is locked so old values retain their meaning.

Duration stores a nonnegative time amount, commonly interpreted with a unit such as minutes. A Checklist measure, including an existing legacy Checklist definition, is a checkbox list with named items and separate checked states; it is not a single Yes/No answer. Existing saved check-ins retain each item and its state, and supported rule comparisons use the checked-item count. Calendar and Insights show saved measure names with recorded values; Yes/No values read **Done** or **Not Done**, while tracker activity status (such as **Completed** or **No progress**) is shown separately. Calendar and Insights show a checklist count as “N of M checked” only when the date-effective item definition is available and matches the saved value; otherwise they show the checked count without guessing a total. History uses the saved name and shows the checklist count as items done.

## Editing, type immutability, and retirement

Measure 1 and subsequent measures use the same type options. Once a measure is saved, its type is immutable, even if no check-in is currently visible on this device. This keeps its stable ID consistent with the cloud and with any historical values. To track something different, add a new measure and retire or remove the old one when its references and history allow it.

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

The **Streak Rule** independently decides whether a recorded check-in advances streak continuity. Choose **Same as Success Rule** to have it follow the Success Rule effective on each date, or **Custom Streak Rule** to define a separate condition. **Any positive value (> 0)** counts a Quantity or Duration above zero, or a Checklist with at least one checked item; zero, blank, missing, and negative numeric values do not qualify. Existing v1–v7 trackers keep their original streak behavior until explicitly changed. A day can qualify for the streak without being successful, or be successful without advancing the streak. Only Success Rule qualification earns normal daily success XP. Streak bonuses require an eligible streak milestone. Schedules, Strict Mode, holidays, and rest days still determine which dates are opportunities.

## Changing rules on an existing tracker

When an edit changes evaluation-affecting settings—such as a Success Rule, Streak Rule, schedule, Strict Mode, active start date, deadline, or a measure used by a rule—the editor asks how to apply the change. **Apply from today** is the default: earlier dates keep their saved rule version, today uses the new rules for the full workspace-local day, and later backdated check-ins use the rule version for their own date. **Recalculate all history** applies the new rules across the tracker’s applicable history. Cancel, Escape, or closing the choice returns to editing without saving any pending fields.

Changing a rule never rewrites saved check-in dates, values, notes, or entry identities. Calendar, History, Insights, milestones, streaks, and server progression resolve saved dates against the same version history. XP and achievement outcomes can change after synchronization, subject to the existing progression cutover and reward rules. Cosmetic edits such as a tracker name or description do not show the rule-application choice. A rule change saved offline is calculated locally and synchronizes with the signed-in account when a connection is available; confirmed rewards refresh after synchronization.

## Common choices and troubleshooting

- **“I only need to check whether I did it.”** Use Yes/No.
- **“I need to record how much.”** Use Quantity with a suitable unit and precision.
- **“Why can’t I convert an old measure?”** Its existing values were recorded using the saved type. Add a new measure for a different interpretation; retire the old one if it should no longer appear in new check-ins.
- **“Why is a check-in not counting toward my streak?”** Check the Streak Rule, the value recorded, whether the date is scheduled, the tracker’s active dates, and whether a holiday or Strict Mode changes the opportunity.
- **“Why can’t I retire this measure?”** Look for rule, milestone, or planning references, and confirm another active measure will remain.

Source references: `src/domain/trackers/types.ts`, `src/domain/trackers/schema.ts`, `src/domain/trackers/invariants.ts`, `src/domain/trackers/progression.ts`, `src/features/trackers/TrackerConfigurationEditor.tsx`, `src/features/trackers/trackerSetupSchema.ts`, `src/features/trackers/TrackerSetupPage.tsx`, `src/features/trackers/TrackerSetupPage.test.tsx`, `src/domain/trackers/schema.test.ts`, `src/db/localRepository.ts`, `supabase/migrations/20261018000100_tracker_metric_integrity.sql`.
