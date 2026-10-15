# Schedules, activity status, and streaks

A schedule defines when a tracker is expected to have an opportunity. It affects Today, activity status, streaks, plan pacing, and Analytics consistency; it does not create or delete check-ins.

## Schedule options

New trackers default to **Daily**. Setup also offers **Weekdays**, **Weekends**, **Custom Days**, and **No Recurrence**. Custom Days accepts any non-empty combination of Monday through Sunday, including Saturday only or Sunday only. Its saved representation is `selected-weekdays`, using JavaScript weekday numbers (Sunday is 0 and Saturday is 6); the Weekends preset uses the existing preferred-weekdays schedule representation. No Recurrence is stored as `none` and never becomes an empty Custom Days selection. Older recurrence definitions remain intact when edited unless the user chooses a replacement.

In Standard Mode, No Recurrence creates no mandatory check-in dates, missed-day expectations, or Goal Auto planning dates. Users can still record flexible progress from the tracker library or Calendar. Strict Mode remains an independent streak policy that requires every active date. Daily, Weekdays, Weekends, and Custom Days determine expected activity dates; holidays pause those dates in Standard Mode.

The effective start date is the later of the configured start and the tracker’s creation date interpreted in the workspace time zone. A deadline bounds the active period. An occurrence outside that interval is not a scheduled opportunity.

## Scheduling duration

Trackers can use **Calendar Days**, **Effective Days**, or **Ongoing** scheduling. Calendar Days uses the chosen deadline and includes both the start and deadline dates; holidays and rest days do not move it. Effective Days uses a positive target count and projects the deadline onto the target-th date that is not explicitly marked as a holiday in the ProgressTracker calendar. Weekends, public holidays, festivals, and activity schedule settings do not change that count. A missed or skipped check-in still consumes an Effective Day. Ongoing has no fixed deadline. Existing trackers keep their established deadline behavior.

For Effective Days, a challenge pauses only on a manually marked holiday and resumes on the next non-holiday date. For Calendar Days, challenge numbering advances with each calendar date. These duration counts are separate from activity schedules, completed check-ins, and streaks. A cumulative Goal’s work target remains its quantity target; Effective Days only sets the planning window. Auto allocations use scheduled, non-holiday activity dates inside that window, while saved Manual allocations remain explicit and are reported when they conflict.

## Standard Mode and Strict Mode

In **Standard Mode**, only scheduled dates that are not holidays count as expected opportunities. Unscheduled rest days and holidays do not break a streak or lower consistency. In **Strict Mode**, each active calendar day is treated as an opportunity, including rest days and past holidays; a qualifying entry is required to preserve the streak.

Changing modes recalculates the tracker’s streak interpretation but does not delete recorded progress. Standard Mode is often appropriate for routines with planned rest days. Strict Mode is appropriate only when every active day should require a qualifying check-in.

## What counts as a streak day

A check-in must be recorded and meet the tracker’s success rule to qualify. For a Yes/No measure, the rule can require true. Quantity and legacy measures can use a configured qualification level or their supported recorded-value behavior. A value may be saved and visible in History even if it does not qualify for the streak.

A required day in the past without a qualifying entry breaks the current run. In Standard Mode, an unscheduled rest day and a holiday are neutral. A deliberately skipped required opportunity fails for streak and Perfect Day purposes, but it is not treated as a completed check-in. The current date remains pending while an outcome is unresolved; a known failure can make the day fail before it closes. Dates after the as-of date are future, not missed.

The tracker deadline limits opportunities. A paused, archived, or deleted tracker does not create new active opportunities, while its recorded history remains viewable. The longest streak is historical; the current streak reflects the present run through the as-of date. Each tracker has its own streak. The separate All Trackers streak counts consecutive dates when every required tracker qualifies; it is not the sum of individual streaks. A date with no required tracker is neutral, and pending dates do not prematurely break a confirmed run.

A Perfect Day requires at least one required tracker and qualifying completion for every required tracker. Perfect Week is repeatable for each completed Monday-based calendar week with all required opportunities qualifying and at least three required activity dates. Perfect Month is repeatable for each completed calendar month with all required opportunities qualifying and at least twelve required activity dates. Standard Mode holidays and rest days are neutral for those periods; Strict Mode dates remain required. Consistency Star uses the average of daily adherence across the latest 30 completed eligible dates, where each day is qualifying eligible trackers divided by eligible trackers. These period badges and consistency use different thresholds and are not interchangeable.

## Holidays and breaks

Holidays are date-only workspace records. In Standard Mode they remove that date from expected scheduled opportunities. In Strict Mode, an active past holiday remains a required calendar day for streak qualification. Holidays affect pacing and consistency calculations as well as streak continuity. They do not erase an entry stored on that date.

## Troubleshooting examples

- **A Sunday did not break my streak:** confirm Sunday is not scheduled and the tracker uses Standard Mode.
- **A rest day did break my streak:** Strict Mode treats active calendar days as opportunities; switch modes only if that matches the intended rule.
- **A recorded day did not extend the streak:** inspect the success rule and the values in that check-in; a recorded entry can be partial.
- **Today appears pending:** that is expected until today’s check-in is submitted. Past unfilled scheduled dates can become missed.
- **A schedule edit changed the consistency percentage:** the denominator is the set of opportunities under the current schedule and mode; saved check-ins remain intact.

Source references: `src/domain/trackers/planning.ts`, `src/domain/trackers/scheduling.ts`, `src/domain/trackers/challengeDay.ts`, `src/domain/trackers/progression.ts`, `src/domain/trackers/activityStatus.ts`, `src/domain/trackers/activityStatus.test.ts`, `src/domain/trackers/progression.test.ts`, `src/features/today/TodayPage.tsx`, `src/features/today/TodayPage.test.tsx`, `src/domain/holidays.ts`, `src/features/holidays/HolidaysPage.tsx`.
