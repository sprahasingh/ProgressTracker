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
- src/features/dashboard/BadgeCelebrationDialog.tsx
- src/features/dashboard/ProgressionAchievementsPage.test.tsx
- src/features/dashboard/BadgeCelebrationDialog.test.tsx
- supabase/tests/progression_achievements.test.sql
- src/features/dashboard/LegacyAchievementsPage.tsx
- src/domain/trackers/schemaVersionGate.ts
- supabase/migrations/20261104002200_preserve_deleted_tracker_reward_context.sql
- supabase/migrations/20261104002300_add_perfect_month_and_comeback_achievements.sql
- supabase/migrations/20261105000200_make_dedicated_one_time.sql
- supabase/migrations/20261105000300_repeatable_activity_achievements.sql
- supabase/migrations/20261105000700_require_full_consistency_window.sql
- supabase/migrations/20261105000800_publish_consistency_qualification_details.sql
**Answer:**
The legacy Achievements view calculates its points from local saved history. When a build enables progression, Wins shows server-confirmed XP, level, reward history, and 14 achievement badges. A qualifying check-in earns 10 XP, a Perfect Day earns 20 XP, streak milestones at 7, 14, 30, and 100 qualifying opportunities earn 35, 50, 100, and 200 XP, a goal milestone earns 25 XP, and a completed goal earns 100 XP. Badges themselves add no XP. The confirmed XP total comes from the server ledger; offline check-in estimates are provisional until synchronization confirms them. Level thresholds are 0, 100, 300, and 600 XP for levels 1 through 4, with each next level requiring 100 times the current level number in additional XP. Existing accounts may show one balance snapshot labeled “XP reconstructed from past activity”; it is not an itemized reward history and does not unlock achievements.

First Step, the streak badges, Consistency Star, and Dedicated are one-time badges. Dedicated’s migration preserves its existing award and reversal history. Perfect Day repeats once per distinct qualifying date; Perfect Week repeats for a distinct completed qualifying week; Perfect Month repeats for a distinct completed qualifying month; The Comeback repeats for a distinct qualifying recovery episode; Milestone Maker repeats for each distinct configured goal milestone; and Goal Crusher repeats for each distinct confirmed goal completion. These awards use server-confirmed reward identities, so retries do not duplicate an occurrence and pre-cutover history is not retroactively awarded. When a source reward is reversed, its linked badge occurrence is revoked while both events remain in history; a later qualifying generation can earn it again.

Consistency Star requires both at least 30 completed eligible opportunities and at least 80% adherence. Standard Mode treats holidays and unscheduled rest days as neutral; Strict Mode counts active-period dates as opportunities. Wins shows the server-computed eligible-day coverage and adherence separately, and does not infer either value from a client-side approximation. The server also supplies current incomplete Perfect Week progress toward three qualifying dates and Perfect Month progress toward 12 qualifying dates when schedule history is supported. It reports failed or unavailable periods explicitly. Comeback progress is descriptive rather than a percentage because qualification depends on a genuine missed required opportunity followed by seven consecutive qualifying opportunities on that tracker; neutral dates preserve the run and a saved skip does not start it.

A newly confirmed badge occurrence can trigger one celebration, presented in sequence. The first occurrence receives a grand celebration; ordinary repeats are subtle; award counts 5, 10, 25, 50, and each additional 100 receive a grand milestone celebration. Existing history is marked seen on initial account load and is not replayed. Acknowledgement is saved when the dialog is dismissed, and the event identity suppresses duplicate presentations across retries and navigation. Permanent deletion offers Keep My Wins, which preserves eligible rewards and their history, or Delete Tracker and Wins, which removes only rewards linked to that tracker. If rewards cannot be safely separated, deletion stops. The progression view stays disabled unless the build sets `VITE_ENABLE_PROGRESSION_UI=true`.

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
- supabase/migrations/20261105000300_repeatable_activity_achievements.sql
**Answer:**
Perfect Month is earned after a completed month when every required opportunity qualifies, across at least 12 distinct dates with required activity. Standard Mode holidays and rest days are neutral; Strict Mode still requires qualifying activity on them. The Comeback is earned after a qualifying tracker opportunity is followed by a genuinely missed required opportunity, then seven consecutive qualifying eligible opportunities. A saved skip does not trigger recovery, and neutral dates preserve the recovery run. Both badges can be earned again for a different month or recovery episode. Wins shows current incomplete week and month progress when the server can verify the schedule history. Comeback eligibility is shown as a description because it depends on several linked conditions. These badges add no XP, and unsupported history is not reconstructed.

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
