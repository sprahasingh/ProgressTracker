# Calendar

### ID: calendar-content
**Category:** calendar
**Question:** What does the calendar show?
**Aliases:**
- What do the calendar colors mean?
- Can I see progress by date?
**Keywords:** calendar, activity, status, heatmap, date
**Suggestible:** true
**Sources:**
- src/features/calendar/CalendarPage.tsx
- src/domain/trackers/activityHeatmap.ts
- src/domain/trackers/entryPresentation.ts
**Answer:**
The calendar lets you navigate dates and review tracker activity for the selected period. Its date indicators summarize scheduled opportunities and saved progress; open a date to review or update the entries available for that day. Selected-day details keep the tracker outcome separate from saved measure values. For example, a Yes/No value appears with its saved measure name and **Done** or **Not Done**, while the activity status can independently read **Completed** or **No progress**. Checklist totals use the item definition effective on that date when it reliably matches the saved value. Use the information button beside Status guide for the difference between saved outcomes and derived statuses, and how holidays, tracker periods, All Trackers, and streak qualification affect the summary.

### ID: calendar-activity-statuses
**Category:** calendar
**Question:** What do the Calendar activity statuses mean?
**Aliases:**
- What is the difference between pending, missed, and no progress?
- What do the status labels in Calendar mean?
**Keywords:** Calendar, status, pending, missed, completed, historical
**Suggestible:** true
**Sources:**
- src/domain/trackers/activityStatus.ts
- src/features/calendar/CalendarPage.tsx
- src/domain/trackers/entryPresentation.ts
- supabase/migrations/20261124000100_holiday_checkin_treatment.sql
**Answer:**
Completed means a saved recorded check-in met the configured completion rule, but completion does not always mean it qualifies for a streak. Partial and No progress are saved outcomes; Skipped is an intentional saved outcome. Pending, Missed, Upcoming, Rest day, Outside period, Historical entry, Holiday, Tracker inactive, and No active trackers are derived from saved data and date, schedule, mode, or tracker context. Standard Mode holidays are neutral when kept as holidays; **Count as Normal Check-in** shows the saved result under normal rules. Strict Mode still requires activity on an active date. A status is separate from the saved measure name and value. Missing check-ins retain their Pending, Missed, or Upcoming meaning, and mixed tracker statuses remain available in selected-day details.

### ID: calendar-inspect-past-date
**Category:** calendar
**Question:** How do I inspect tracker activity on a past date?
**Aliases:**
- Can I open a previous day in Calendar?
- Where can I see what happened on a particular date?
**Keywords:** Calendar, past date, select date, activity
**Suggestible:** true
**Sources:**
- src/features/calendar/CalendarPage.tsx
- src/features/calendar/CalendarPage.test.tsx
- src/domain/trackers/entryPresentation.ts
**Answer:**
Open Calendar, navigate to the month, and select the date. The selected-day panel shows each tracker’s derived outcome separately from its recorded values. Saved measure names are retained; Yes/No values read **Done** or **Not Done**, including false answers. Checklist values show “N of M checked” when the date-effective definition is reliable, and otherwise show the checked count without a guessed total. For an eligible date, choose Add check-in or Edit check-in to open the shared editor with that date selected; ineligible dates explain why editing is unavailable.

### ID: calendar-rest-day
**Category:** calendar
**Question:** How do rest days appear in Calendar?
**Aliases:**
- Does Calendar show unscheduled tracker days?
- What status does an off day have?
**Keywords:** Calendar, rest day, unscheduled, tracker schedule
**Suggestible:** true
**Sources:**
- src/domain/trackers/activityStatus.ts
- src/features/calendar/CalendarPage.tsx
**Answer:**
In Standard Mode, an in-period date excluded by the active tracker’s schedule is a Rest day. Strict Mode makes every in-period date an opportunity, including schedule rest days. Dates before the effective start or after the deadline are Outside period, not Rest days. Saved check-ins remain visible on rest days and outside the active period.

### ID: calendar-zero-activity
**Category:** calendar
**Question:** Does a recorded zero count as activity in Calendar?
**Aliases:**
- Is zero different from no check-in on the calendar?
- Why is my zero entry not marked completed?
**Keywords:** Calendar, zero, quantity, recorded, success rule
**Suggestible:** true
**Sources:**
- src/domain/trackers/activityStatus.ts
- src/domain/trackers/progression.ts
**Answer:**
A saved zero is a recorded value, so it is different from an empty date. Whether the day is Completed depends on the tracker’s success rule; zero may be recorded without qualifying, and the Calendar can show No progress.

### ID: calendar-holiday-entry
**Category:** calendar
**Question:** Does a saved check-in stay visible on a holiday?
**Aliases:**
- Does marking a holiday hide progress already recorded?
- Can a holiday date still show my check-in?
**Keywords:** Calendar, holiday, saved check-in, retain, workspace
**Suggestible:** true
**Sources:**
- src/domain/trackers/activityStatus.ts
- src/features/calendar/CalendarPage.tsx
**Answer:**
Yes. Selected-day details and History retain saved check-ins. For Standard Mode, **Keep as Holiday** shows holiday activity while preserving the exemption; **Count as Normal Check-in** shows the normal saved outcome and still keeps the holiday details available. Strict Mode still requires activity, so a missing past check-in can be Missed on a holiday.

### ID: heatmap-normalized
**Category:** calendar
**Question:** What does the Insights heatmap measure?
**Aliases:**
- How are the heatmap colors calculated?
- Does one heatmap shade mean one check-in?
**Keywords:** heatmap, eligible opportunities, qualifying check-ins, percent, Insights
**Suggestible:** true
**Sources:**
- src/domain/trackers/activityHeatmap.ts
- src/features/dashboard/DashboardPage.tsx
**Answer:**
For each date, the heatmap compares check-ins meeting each tracker’s Streak Rule with eligible opportunities and colors the result by that day’s percentage. It describes streak qualification, not success rate. In an all-tracker view, it combines opportunity counts across active trackers while applying each tracker’s Standard or Strict Mode rules.

### ID: calendar-versus-history
**Category:** calendar
**Question:** Why does Calendar show dates that I do not see in History?
**Aliases:**
- What is the difference between Calendar and History?
- Why is an empty date on Calendar missing from my History list?
**Keywords:** Calendar, History, activity status, saved check-ins, missing
**Suggestible:** true
**Sources:**
- src/features/calendar/CalendarPage.tsx
- src/features/history/HistoryPage.tsx
**Answer:**
Calendar summarizes tracker status across selected dates, including pending, missed, holiday, and rest days. History lists saved check-ins and holidays in its selected range, with a separate recent missing-opportunity review; an empty calendar date is not necessarily a saved history entry.
