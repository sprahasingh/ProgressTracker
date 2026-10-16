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
- src/domain/trackers/ruleVersions.ts
- src/domain/trackers/progression.test.ts
- supabase/migrations/20261111000100_tracker_streak_rules_v8.sql
**Answer:**
Your current streak is the run of recent tracking opportunities whose entries meet the Streak Rule effective on each date. Your longest streak is the best qualifying run in the tracker’s history. A missed required opportunity can end the current run, while the longest record remains. Which dates count depends on the tracker’s schedule, Strict Mode, and holidays. Success rates and normal daily success XP use the separate Success Rule effective on each date. A versioned rule change does not reset continuity across the date boundary.

### ID: all-trackers-streak
**Category:** streaks
**Question:** How does the All Trackers streak work?
**Aliases:**
- Is the All Trackers streak the sum of my tracker streaks?
- What is an account-wide Perfect Day streak?
**Keywords:** All Trackers, account streak, Perfect Day, shared streak
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/features/dashboard/DashboardPage.tsx
- src/domain/trackers/progression.test.ts
**Answer:**
It counts consecutive dates when at least one tracker has a required opportunity and every required tracker meets its own Streak Rule. It is separate from each tracker’s own streak. Standard Mode holidays and rest days are neutral; Strict Mode requires active-period dates. A known failed opportunity ends the run, while a neutral or still-pending date does not add a day or prematurely break the confirmed run.

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
- supabase/migrations/20261111000100_tracker_streak_rules_v8.sql
**Answer:**
Your current streak describes your ongoing qualifying run. Your longest streak is the best qualifying run found in the tracker’s history, so a current streak ending does not erase that record.

### ID: streak-skipped
**Category:** streaks
**Question:** Does marking a check-in as skipped count toward a streak?
**Aliases:**
- Is an intentionally missed entry a completed day?
- Does “Marked missed intentionally” qualify for a streak?
**Keywords:** skipped, marked missed, streak, qualifying entry
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/domain/trackers/progression.test.ts
- src/features/history/HistoryPage.tsx
**Answer:**
No. A Skipped entry is a saved intentional outcome, not a derived Missed date or a recorded No progress check-in. It does not qualify for a streak on a required opportunity. Standard Mode rest days and holidays are excluded from the streak; Strict Mode requires qualifying activity on every in-period date.

### ID: streak-zero-quantity
**Category:** streaks
**Question:** Does recording zero keep a streak alive?
**Aliases:**
- Can a zero quantity value qualify for a streak?
- Why did my zero entry not count toward my streak?
**Keywords:** zero, quantity, streak qualification, success rule
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/domain/trackers/progression.test.ts
**Answer:**
A numeric zero does not qualify when a custom Streak Rule uses **Any positive value (> 0)**; any value above zero does. For a Checklist, at least one checked item qualifies. Blank or missing values do not qualify, and negative numeric values are not valid recorded progress. Other Streak Rules may treat zero differently. New v8 trackers can use the Success Rule or a separate custom rule; older trackers retain their original behavior until explicitly changed. Check the rule and schedule if the result is unexpected.
