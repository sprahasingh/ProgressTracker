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
**Answer:**
The calendar lets you navigate dates and review tracker activity for the selected period. Its activity indicators summarize saved progress; open a date to review or update the entries available for that day.

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
**Answer:**
Completed means a recorded entry met the success rule; Partially completed or No progress means it did not. Pending is an open current or future opportunity, Missed is an elapsed opportunity without a qualifying result, Historical is outside the tracker’s current period, Rest day is unscheduled, and Holiday is a workspace break.

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
**Answer:**
Open Calendar, navigate to the month, and select the date. The selected-day panel shows statuses and saved values by tracker; use its History link to review an entry or its check-in action when available.

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
An unscheduled day is shown as a Rest day for that tracker. The combined calendar can include different trackers with different schedules, so a date may be a rest day for one tracker and an opportunity for another.

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
Yes. The date keeps its Holiday status, while saved check-ins remain available in the selected-day details and History. A holiday changes opportunity status; it does not clear the entry.

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
For each date, the heatmap compares qualifying check-ins with eligible opportunities and colors the result by that day’s percentage. In an all-tracker view, it combines opportunity counts across active trackers while applying each tracker’s Standard or Strict Mode rules.

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
