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
- src/domain/trackers/progressionModel.ts
- src/domain/trackers/progression.ts
- src/services/supabase/progressionRepository.ts
- src/features/dashboard/AchievementsPage.tsx
- src/features/dashboard/ProgressionAchievementsPage.tsx
- src/features/dashboard/achievementCatalog.ts
- src/features/dashboard/LegacyAchievementsPage.tsx
- src/domain/trackers/schemaVersionGate.ts
- supabase/migrations/20261104002200_preserve_deleted_tracker_reward_context.sql
- supabase/migrations/20261104002300_add_perfect_month_and_comeback_achievements.sql
**Answer:**
The existing Achievements view keeps its legacy points calculated from local saved history. When progression is enabled for a build, Wins shows confirmed XP, level, milestones, and 14 achievement badges. The two repeatable badges added most recently are Perfect Month and The Comeback. Perfect Month requires every date in a completed workspace-timezone month to qualify as a Perfect Day and the month to contain no account-wide holiday. The Comeback requires a missed required opportunity immediately after a qualifying opportunity, followed by seven consecutive qualifying opportunities. Standard Mode pauses these sequences for holidays and unscheduled dates; Strict Mode requires activity on holidays and rest days. These badges do not grant XP, and reconstructed history does not unlock them. Offline rewards are labeled provisional until confirmed; they do not change the official level or unlock badges. A later correction can add a reversal to score history. For existing accounts, past activity may appear as one estimate labeled “XP reconstructed from past activity.” If there is no retained pre-cutover entry history, historical XP is unavailable. This estimate is not individual historical rewards and does not unlock achievements. Permanent deletion offers Keep My Wins, which preserves eligible rewards and their history, or Delete Tracker and Wins, which removes only rewards linked to that tracker. If rewards cannot be safely separated, nothing is deleted. The progression view stays disabled unless the build sets `VITE_ENABLE_PROGRESSION_UI=true`.

### ID: repeatable-progress-badges
**Category:** statistics
**Question:** What do Perfect Month and The Comeback badges require?
**Aliases:**
- How do I earn Perfect Month?
- How do I earn The Comeback badge?
**Keywords:** Perfect Month, The Comeback, achievement, holiday, streak, badge
**Suggestible:** true
**Sources:**
- src/domain/trackers/progressionModel.ts
- src/features/dashboard/achievementCatalog.ts
- supabase/migrations/20261104002300_add_perfect_month_and_comeback_achievements.sql
**Answer:**
Perfect Month is earned after a completed month when every date had at least one eligible tracker and every eligible tracker qualified for a Perfect Day, with no workspace holiday during that month. The Comeback is earned after a qualifying tracker opportunity is followed by a missed required opportunity, then seven consecutive qualifying eligible opportunities. A saved skip is not a missed trigger. Standard Mode treats holidays and rest days as neutral; Strict Mode requires qualifying activity on holidays and rest days. Both badges can be earned again for a different month or recovery episode. They add no XP, and unsupported history is not reconstructed.

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
