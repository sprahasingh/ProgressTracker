# Goals, planning, and milestones

Use planning targets to describe progress over time. They are separate from a measure’s per-check-in Minimum, Target, and Stretch thresholds. Planning belongs to the tracker and keeps each measure’s unit and target separate.

## Find and configure a goal plan

Create or edit a tracker in **Trackers**. In its setup form, open **Planning targets** under the advanced settings, choose a planning mode, then enter targets for the eligible measures. The **Goals** page shows saved plans and their progress. The setup form preserves both daily and cumulative target maps when switching modes; changing the mode does not delete check-ins.

## Daily recurring plan

A daily recurring plan sets a target for each scheduled opportunity. For example, “read 10 pages on each scheduled weekday” is checked one day at a time. Its consistency percentage is the number of met opportunities divided by elapsed opportunities. Rest days and holidays are neutral, and an unsubmitted current day stays pending. A skipped day is tracked separately from a recorded value.

Daily plans support numeric or Checklist measures. A legacy Checklist target counts checked items and cannot exceed the number of items. Boolean measures do not have numeric planning targets. A daily target is not a threshold that decides whether the tracker’s overall success rule qualifies; configure those separately.

## Cumulative deadline plan

A cumulative plan sets one total to reach by the tracker deadline, such as “complete 100 pages by the end of the month”. The deadline is required. The plan distributes expected progress across scheduled dates and shows actual progress, expected progress, remaining work, required daily pace, and a pace state such as ahead, on track, behind, overdue, or no scheduled days.

Tracker duration is configured separately from the cumulative quantity. Calendar Days keeps the chosen deadline fixed. Effective Days projects the deadline from the target number of eligible dates, excluding holidays and scheduled rest days; Auto planning uses those same eligible dates. Changing holidays can therefore move an Effective Days deadline and redistribute future Auto work. The quantity target (for example, 20 chapters) does not change. Explicit Manual allocations remain saved as Manual and are never silently moved or deleted when the window changes.

Cumulative planning can sum only measures explicitly configured as **Incremental**, where each entry adds new progress. A **Snapshot** is already a total, so adding snapshots across dates would count the same work repeatedly. A measure with an existing cumulative target cannot be changed to Snapshot until that target is resolved. Legacy Checklist entries contribute the count checked on each eligible entry and the cumulative total may span repeated scheduled days.

Rest days and holidays do not add scheduled pace opportunities. Recorded incremental progress on a rest date still represents real progress and can count toward the total. Today remains available for the plan until today’s entry is submitted; after a recorded or skipped entry, pace and allocation calculations use remaining eligible dates. Expected progress uses saved planned amounts for elapsed dates where they are available and an even scheduled-date split as the fallback. When future dates have explicit Manual allocations, required Auto pace subtracts those fixed amounts from the remaining work and divides the balance across the remaining Auto dates.

If there are no scheduled dates in the plan window, the plan reports that state instead of inventing a daily pace. A deadline before the effective start date is invalid. The effective start respects both the chosen start and the tracker’s creation date in the workspace time zone.

## Allocation planning

The allocation view can preview how a cumulative total could be spread across remaining scheduled dates. Auto amounts recalculate from saved progress, the target, and eligible dates. Manual status comes only from an explicit saved per-date `manualAllocations` key; recalculation and pagination do not promote Auto dates. Legacy `allocations` cannot show which past values were user-edited, so the UI requires an explicit choice before preserving eligible legacy values as Manual. If older or imported Manual keys no longer match the user's intent, an individual date can be reset to Auto or future overrides can be reset after confirmation; nothing is removed until the change is saved. Past Manual values and check-ins remain preserved.

Historical rows separate recorded progress from plan data. A scheduled past date with a persisted amount shows that amount; a scheduled past date without one says **No saved plan**. An unscheduled date says **Not scheduled**, even if it has a recorded value. Recorded incremental work on an unscheduled date still contributes to actual progress when it is inside the goal period. Entries before the effective goal start are excluded from the plan and shown separately as outside the current period; an explicit start date before tracker creation is valid and can include backdated entries.

If Manual allocations exceed the remaining work, the plan reports the over-allocation instead of generating negative Auto amounts. The calculated pace is a suggestion for planning; it is not itself a check-in, a saved entry, or a change to the goal total. Review the preview and the saved target separately. The total is measured in the selected measure’s unit.

## Milestones

A milestone is a small goal inside a tracker. Each typed milestone states what it measures, which target counts, and how progress is calculated. Progress is derived from the tracker's saved check-ins and is recalculated when historical entries change; milestones do not create extra check-ins.

Milestone types are:

- **Total quantity recorded:** sums nonnegative values for one Quantity or Duration measure over the active tracker period. The measure's unit is shown, and zero is a valid recorded value.
- **Quantity in a single day:** shows the best recorded day for one numeric measure. Values from different dates are never added together. For a measure configured to decrease, reaching the target means recording that value or less.
- **Successful activity days:** counts distinct eligible dates that pass the tracker's Success Rule. Rest days and holidays are neutral.
- **Longest streak:** shows the longest streak ever achieved using the tracker's separate Streak Rule. The current streak is shown separately; a later missed day does not remove the best streak.
- **Challenge day reached:** follows the challenge's fixed Calendar Days or Effective Days numbering. Effective Days follow the configured planned-activity or all-non-holiday counting method. This is time progression, not successful activity.
- **Measure completion count:** counts dates matching a Yes/No or Checklist condition, such as a Yes day, one selected checklist item, or the full saved checklist.

The editor only offers types supported by the tracker and its measures. It shows a type-specific target label and a live sentence preview. Progress cards show the unit or day meaning, a capped progress bar, completion state, and the date the threshold was first reached when it can be derived. A measure that changes incompatibly, a missing measure, or a changed checklist is flagged for review; it is not silently replaced.

Older milestones without a saved type keep their original best-single-observation comparison. Their saved meaning is shown explicitly until the user chooses a conversion. A typed milestone saves its stable measure ID and relevant type, unit, or checklist snapshots; its progress and threshold date remain derived from current authoritative entries. Existing goal-milestone rewards continue to use the same reward policy and stable award identity, so edits can reverse and re-reach a milestone without duplicate awards. Ordinary milestones do not add a new reward amount.

Displayed milestone progress describes saved tracker history under the current milestone rules. Confirmed XP is reconciled separately: milestone rewards require individually eligible check-ins after the progression cutover. A milestone may therefore show completed from earlier history without a confirmed reward. Removing or invalidating a rewarded milestone makes its old reward ineligible and records a linked reversal; restoring eligibility can create a new award generation.

If a milestone refers to a measure, resolve that dependency before removing or retiring the measure. Retired measure definitions remain available for historical display, but they should not remain a dependency of an active plan that needs future inputs.

## Examples and common mistakes

- **Repeated practice:** “Exercise 20 minutes on each scheduled day” is a daily recurring target.
- **Finish a deliverable:** “Write 12,000 words by a deadline” is cumulative only if each entry records newly written words (incremental), not a running lifetime total (snapshot).
- **Checkpoint:** “Draft complete at 5,000 words” can be a total-quantity milestone on the relevant measure; it is not another daily target.
- A per-check-in Target does not automatically become a daily or cumulative planning target.
- Missing a daily target can lower plan consistency without deleting the recorded value.
- If a cumulative plan appears behind, check the progress semantics, selected measure, schedule, active dates, deadline, holidays, and whether today’s entry has already closed the current opportunity.

Source references: `src/domain/trackers/milestones.ts`, `src/domain/trackers/types.ts`, `src/domain/trackers/schema.ts`, `src/domain/trackers/progression.ts`, `src/domain/trackers/planning.ts`, `src/features/trackers/TrackerConfigurationEditor.tsx`, `src/features/trackers/MilestoneProgressList.tsx`, `src/features/trackers/TrackerSetupPage.tsx`, `src/features/goals/GoalsPage.tsx`, `src/features/history/HistoryPage.tsx`, `src/features/calendar/CalendarPage.tsx`, `src/services/supabase/syncEngine.ts`, `supabase/migrations/20261113000100_tracker_typed_milestones_v9.sql`.
