# Statistics

### ID: completion-rate
**Category:** statistics
**Question:** How is completion rate calculated?
**Aliases:**
- How do you calculate my completion percentage?
- Why is my completion rate lower than expected?
- What is the denominator for completion rate?
**Keywords:** percentage, consistency, scheduled opportunities, qualifying entries, denominator, analytics
**Suggestible:** true
**Sources:**
- src/domain/trackers/analytics.ts
- src/domain/trackers/planning.ts
- src/domain/trackers/progression.ts
- src/domain/trackers/analytics.test.ts
**Answer:**
For an active tracker with scheduled opportunities, the consistency percentage is the number of qualifying opportunities divided by the number of counted opportunities, rounded to a whole percent. Standard Mode counts scheduled dates except holidays; Strict Mode counts every active date, including otherwise unscheduled dates and holidays. The current as-of date is left out when it has no entry yet. If there are no counted opportunities, the percentage is unavailable.

### ID: qualifying-checkin
**Category:** statistics
**Question:** What makes a check-in count as successful?
**Aliases:**
- What counts as a completed day?
- Why did my check-in not count toward progress?
**Keywords:** success rule, threshold, qualifying, recorded, outcome, measure
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/domain/trackers/planning.ts
- src/domain/trackers/types.ts
**Answer:**
A recorded check-in qualifies when its outcome and values meet the tracker’s configured success rules. A tracker can have multiple measures and rules, so recording something does not always mean the day qualifies. A skipped check-in is not a qualifying recorded result.

### ID: points-and-rewards
**Category:** statistics
**Question:** How do achievement points and streak rewards work?
**Aliases:**
- Do I lose reward points if my streak resets?
- What earns points in Achievements?
**Keywords:** achievements, points, reward, qualified check-in, milestone, longest streak
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/features/dashboard/AchievementsPage.tsx
**Answer:**
Each qualifying check-in earns points, and reaching a new longest-streak milestone earns additional points. A missed day can end the current streak, but it does not subtract points already earned. Achievements are calculated from the tracker’s saved history, so editing or clearing history can recalculate the totals.

### ID: completion-missed-dates
**Category:** statistics
**Question:** Do missed dates affect completion rate?
**Aliases:**
- Does a missed day lower my consistency percentage?
- Why did my completion rate decrease after an unchecked day?
**Keywords:** completion rate, missed opportunity, denominator, consistency
**Suggestible:** true
**Sources:**
- src/domain/trackers/analytics.ts
- src/domain/trackers/analytics.test.ts
**Answer:**
Counted opportunities contribute to the denominator, while qualifying entries contribute to the numerator. A missed counted opportunity therefore lowers the percentage. Standard Mode excludes holidays and unscheduled days; Strict Mode counts every active date.

### ID: completion-holidays-rest-days
**Category:** statistics
**Question:** Do holidays and rest days affect completion rate?
**Aliases:**
- Are holidays included in consistency statistics?
- Do unscheduled dates count in the percentage?
**Keywords:** completion rate, holidays, rest days, Standard Mode, Strict Mode
**Suggestible:** true
**Sources:**
- src/domain/trackers/analytics.ts
- src/domain/trackers/analytics.test.ts
- src/domain/trackers/planning.ts
**Answer:**
In Standard Mode, holidays and unscheduled rest days are excluded from counted opportunities. Strict Mode counts every active date, including holidays and dates outside the regular schedule. A saved qualifying check-in on a holiday can count in either mode.

### ID: completion-no-opportunities
**Category:** statistics
**Question:** Why is a tracker’s completion rate unavailable?
**Aliases:**
- Why is there no percentage for this tracker?
- What if my tracker has no counted dates yet?
**Keywords:** completion rate, no opportunities, active period, schedule
**Suggestible:** true
**Sources:**
- src/domain/trackers/analytics.ts
- src/domain/trackers/planning.ts
**Answer:**
The percentage is unavailable when there are no counted opportunities in the selected period. This can happen before a tracker’s active period or when its schedule and mode produce no opportunities in that range.

### ID: analytics-metric-units
**Category:** statistics
**Question:** Does Analytics combine different measure units into one total?
**Aliases:**
- Are pages and minutes added together in Analytics?
- How does Insights summarize multiple kinds of values?
**Keywords:** Analytics, Insights, measures, units, observations
**Suggestible:** true
**Sources:**
- src/domain/trackers/analytics.ts
- src/features/analytics/AnalyticsPage.tsx
**Answer:**
No. Analytics summarizes each measure separately, so values with different units are not added together. Comparable counts such as completed opportunities can be combined, while measure values stay with their own tracker and unit.

### ID: completion-holiday-entry
**Category:** statistics
**Question:** Does a check-in on a holiday count toward completion rate?
**Aliases:**
- If I log on a holiday, does my percentage go up?
- Does holiday progress count in consistency statistics?
**Keywords:** completion rate, holiday, qualifying check-in, Strict Mode, Standard Mode
**Suggestible:** true
**Sources:**
- src/domain/trackers/analytics.ts
- src/domain/trackers/analytics.test.ts
**Answer:**
It depends on the tracker’s mode. Standard Mode excludes holidays from counted opportunities, so a holiday entry does not affect that rate. Strict Mode counts every active date, including holidays, and a qualifying saved entry contributes to the rate.
