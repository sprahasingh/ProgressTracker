# Goals, planning, and milestones

Use planning targets to describe progress over time. They are separate from a measure’s per-check-in Minimum, Target, and Stretch thresholds. Planning belongs to the tracker and keeps each measure’s unit and target separate.

## Find and configure a goal plan

Create or edit a tracker in **Trackers**. In its setup form, open **Planning targets** under the advanced settings, choose a planning mode, then enter targets for the eligible measures. The **Goals** page shows saved plans and their progress. The setup form preserves both daily and cumulative target maps when switching modes; changing the mode does not delete check-ins.

## Daily recurring plan

A daily recurring plan sets a target for each scheduled opportunity. For example, “read 10 pages on each scheduled weekday” is checked one day at a time. Its consistency percentage is the number of met opportunities divided by elapsed opportunities. Rest days and holidays are neutral, and an unsubmitted current day stays pending. A skipped day is tracked separately from a recorded value.

Daily plans support numeric or Checklist measures. A legacy Checklist target counts checked items and cannot exceed the number of items. Boolean measures do not have numeric planning targets. A daily target is not a threshold that decides whether the tracker’s overall success rule qualifies; configure those separately.

## Cumulative deadline plan

A cumulative plan sets one total to reach by the tracker deadline, such as “complete 100 pages by the end of the month”. The deadline is required. The plan distributes expected progress across scheduled dates and shows actual progress, expected progress, remaining work, required daily pace, and a pace state such as ahead, on track, behind, overdue, or no scheduled days.

Cumulative planning can sum only measures explicitly configured as **Incremental**, where each entry adds new progress. A **Snapshot** is already a total, so adding snapshots across dates would count the same work repeatedly. A measure with an existing cumulative target cannot be changed to Snapshot until that target is resolved. Legacy Checklist entries contribute the count checked on each eligible entry and the cumulative total may span repeated scheduled days.

Rest days and holidays do not add scheduled pace opportunities. Recorded incremental progress on a rest date still represents real progress and can count toward the total. Today remains available for the plan until today’s entry is submitted; after a recorded or skipped entry, pace and allocation calculations use remaining eligible dates. Expected progress uses saved planned amounts for elapsed dates where they are available and an even scheduled-date split as the fallback. When future dates have explicit Manual allocations, required Auto pace subtracts those fixed amounts from the remaining work and divides the balance across the remaining Auto dates.

If there are no scheduled dates in the plan window, the plan reports that state instead of inventing a daily pace. A deadline before the effective start date is invalid. The effective start respects both the chosen start and the tracker’s creation date in the workspace time zone.

## Allocation planning

The allocation view can preview how a cumulative total could be spread across remaining scheduled dates. Auto amounts recalculate from saved progress, the target, and eligible dates. Only dates the user explicitly edits are saved as Manual overrides; recalculation does not promote other dates. Individual overrides can be reset to Auto, or all future Manual allocations can be reset after confirmation. Resets update the saved plan without changing check-ins or historical planned values. If Manual allocations exceed the remaining work, the plan reports the over-allocation instead of generating negative Auto amounts. The calculated pace is a suggestion for planning; it is not itself a check-in, a saved entry, or a change to the goal total. Review the preview and the saved target separately. The total is measured in the selected measure’s unit.

## Milestones

A milestone is a named checkpoint associated with a tracker and, when configured, a measure and value. It marks progress toward an outcome; it does not create another check-in or add separate progress. Boolean observations can be interpreted as 0/1, numeric observations use their nonnegative value, and a valid legacy Checklist observation uses the number of checked items. The comparison follows the configured milestone interpretation.

If a milestone refers to a measure, resolve that dependency before removing or retiring the measure. Retired measure definitions remain available for historical display, but they should not remain a dependency of an active plan that needs future inputs.

## Examples and common mistakes

- **Repeated practice:** “Exercise 20 minutes on each scheduled day” is a daily recurring target.
- **Finish a deliverable:** “Write 12,000 words by a deadline” is cumulative only if each entry records newly written words (incremental), not a running lifetime total (snapshot).
- **Checkpoint:** “Draft complete at 5,000 words” can be a milestone on the relevant measure; it is not another daily target.
- A per-check-in Target does not automatically become a daily or cumulative planning target.
- Missing a daily target can lower plan consistency without deleting the recorded value.
- If a cumulative plan appears behind, check the progress semantics, selected measure, schedule, active dates, deadline, holidays, and whether today’s entry has already closed the current opportunity.

Source references: `src/domain/trackers/planning.ts`, `src/domain/trackers/allocationPreview.ts`, `src/domain/trackers/goalPlanning.test.ts`, `src/domain/trackers/planning.test.ts`, `src/features/trackers/GoalPlanningEditor.tsx`, `src/features/trackers/GoalPlanningEditor.test.tsx`, `src/features/goals/GoalsPage.tsx`, `src/features/goals/GoalsPage.test.tsx`.
