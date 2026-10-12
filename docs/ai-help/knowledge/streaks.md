# Streaks

### ID: standard-vs-strict
**Category:** streaks
**Question:** What is the difference between Standard Mode and Strict Mode?
**Aliases:**
- Does Strict Mode count rest days?
- Which days become opportunities in Strict Mode?
**Keywords:** Standard Mode, Strict Mode, schedule, daily, opportunity, holidays
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/domain/trackers/analytics.ts
- src/features/trackers/TrackerConfigurationEditor.tsx
**Answer:**
Standard Mode counts the tracker’s scheduled dates as opportunities and pauses over unscheduled days and holidays. Strict Mode counts every date in the active period, including unscheduled dates and holidays. A saved qualifying check-in on a holiday can still count in either mode.

### ID: streak-statistics
**Category:** streaks
**Question:** How do streak statistics work?
**Aliases:**
- How are streaks calculated?
- What counts toward my current streak?
- Why did my streak reset?
**Keywords:** current streak, longest streak, qualifying check-in, schedule, strict mode, rest day, holiday
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/domain/trackers/planning.ts
- src/domain/trackers/progression.test.ts
**Answer:**
Your current streak is the run of recent tracking opportunities you have met. Your longest streak is the best qualifying run in the tracker’s history. A missed required opportunity can end the current run, while the longest record remains. Which dates count depends on the tracker’s schedule, Strict Mode, and holidays.

### ID: rest-days-streaks
**Category:** streaks
**Question:** How do rest days affect streaks?
**Aliases:**
- Do unscheduled days break a streak?
- Does my schedule pause my streak?
**Keywords:** schedule, unscheduled, opportunity, strict mode, rest day
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/domain/trackers/planning.ts
**Answer:**
In Standard Mode, only scheduled check-in dates are opportunities, so unscheduled rest days do not break a streak. Strict Mode treats every active date as an opportunity, including dates outside the regular schedule. Tracker start and deadline dates still bound the active period.

### ID: streak-longest
**Category:** streaks
**Question:** What is the difference between my current streak and longest streak?
**Aliases:**
- Does losing my streak erase my record?
- Why is my longest streak higher than my current streak?
**Keywords:** current streak, longest streak, record, history
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/domain/trackers/progression.test.ts
**Answer:**
Your current streak describes your ongoing qualifying run. Your longest streak is the best qualifying run found in the tracker’s history, so a current streak ending does not erase that record.
