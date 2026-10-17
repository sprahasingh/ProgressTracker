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
- src/domain/trackers/ruleVersions.ts
- src/domain/trackers/analytics.test.ts
**Answer:**
For an active tracker with scheduled opportunities, the consistency percentage is the number of opportunities meeting the tracker’s Success Rule divided by the number of elapsed counted opportunities, rounded to a whole percent. A streak-only date does not increase success consistency. Standard Mode counts scheduled dates except holidays; Strict Mode counts every active date, including otherwise unscheduled dates and holidays. The current as-of date is left out when it has no entry yet. If there are no counted opportunities, the percentage is unavailable. Streak lengths use the separate Streak Rule.

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
- supabase/migrations/20261111000100_tracker_streak_rules_v8.sql
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
- supabase/migrations/20261105000900_perfect_day_success_qualification.sql
- supabase/migrations/20261106000100_strict_perfect_calendar_achievements.sql
- supabase/migrations/20261117000100_versioned_tracker_evaluation_rules_v10.sql
**Answer:**
The legacy Achievements view calculates its points from local saved history. When a build enables progression, Wins shows server-confirmed XP, level, reward history, and achievement badges. A check-in meeting the Success Rule effective for its date earns 10 XP, a Perfect Day earns 20 XP, streak milestones at 7, 14, 30, and 100 Streak Rule opportunities earn 35, 50, 100, and 200 XP, an eligible goal milestone earns 25 XP, and a completed goal earns 100 XP. For versioned trackers, milestone progress and progression resolve each date using its saved rule version; pre-v10 trackers retain their legacy definition until a rule-changing edit establishes history. Confirmed milestone XP still requires individually eligible check-ins after the progression cutover. Badges themselves add no XP. Perfect Day, Perfect Week, Perfect Month, and Perfect Year use the server-confirmed daily Success Rule effective on each date; the week requires all seven Monday-to-Sunday dates, the month every date in its actual length, and the year every date including leap day. Holidays and rest-only dates do not count as successful days, and each date needs at least one eligible successful tracker. The account time zone defines calendar dates. New period rules begin at a future complete-period cutover; older recorded awards remain historical and are not recreated under the new rules. The confirmed XP total comes from the server ledger; offline check-in estimates are provisional until synchronization confirms them. By default, Score History hides an award and its directly linked reversal when they fully cancel; choose Show reversed transactions to view the full history. This display setting does not change XP totals or levels. Level thresholds are 0, 100, 300, and 600 XP for levels 1 through 4, with each next level requiring 100 times the current level number in additional XP. Existing accounts may show one balance snapshot labeled “XP reconstructed from past activity”; it is not an itemized reward history and does not unlock achievements.

First Step, the streak badges, Consistency Star, and Dedicated are one-time badges. Dedicated’s migration preserves its existing award and reversal history. Perfect Day repeats once per distinct qualifying date; Perfect Week, Perfect Month, and Perfect Year repeat for each distinct fully qualified calendar period; The Comeback repeats for a distinct qualifying recovery episode; Milestone Maker repeats for each distinct configured goal milestone; and Goal Crusher repeats for each distinct confirmed goal completion. These awards use server-confirmed identities, so retries do not duplicate an occurrence. Period badges are reconciled after edits and corrections; revocations remain in history, and a later valid qualification can earn a fresh occurrence. Earlier recorded periods are not awarded retroactively under the new rules.

Consistency Star requires both at least 30 completed eligible opportunities and at least 80% adherence. Standard Mode treats holidays and unscheduled rest days as neutral for streaks; Strict Mode counts active-period dates as opportunities. Wins shows the server-computed eligible-day coverage and adherence separately, and does not infer either value from a client-side approximation. For Perfect Week, Month, and Year, every date must instead be a confirmed Perfect Day; neutral rest and holiday dates therefore fail that strict period. Their visible current-period progress counts only server-confirmed Perfect Days even if schedule history for other dates is incomplete; unverifiable dates are left uncounted and are not described as failures. Perfect Year shows the number of active confirmed Perfect Month awards, plus current-month Perfect Days separately. These display counts do not change the server's full-period badge eligibility checks. Comeback progress is descriptive rather than a percentage because qualification depends on a genuine missed required opportunity followed by seven consecutive qualifying opportunities on that tracker; neutral dates preserve the run and a saved skip does not start it.

A newly confirmed badge occurrence can trigger a celebration. Awards with the same source date are shown together in one accessible popup; other awards remain queued. The first occurrence receives a grand celebration; ordinary repeats are subtle; award counts 5, 10, 25, 50, and each additional 100 receive a grand milestone celebration. Existing history is marked seen on initial account load and is not replayed. Acknowledgement is saved when the popup is dismissed, and event identities suppress duplicate presentations across retries and navigation. Permanent deletion offers Keep My Wins, which preserves eligible rewards and their history, or Delete Tracker and Wins, which removes only rewards linked to that tracker. If rewards cannot be safely separated, deletion stops. The progression view stays disabled unless the build sets `VITE_ENABLE_PROGRESSION_UI=true`.

### ID: repeatable-progress-badges
**Category:** statistics
**Question:** What do Perfect Week, Month, Year, and The Comeback badges require?
**Aliases:**
- How do I earn Perfect Month?
- How do I earn Perfect Year?
- How do I earn The Comeback badge?
**Keywords:** Perfect Week, Perfect Month, Perfect Year, The Comeback, achievement, holiday, streak, badge
**Suggestible:** true
**Sources:**
- src/domain/trackers/progressionModel.ts
- src/features/dashboard/achievementCatalog.ts
- src/domain/trackers/progression.ts
- supabase/migrations/20261105000900_perfect_day_success_qualification.sql
- supabase/migrations/20261106000100_strict_perfect_calendar_achievements.sql
- supabase/migrations/20261104002300_add_perfect_month_and_comeback_achievements.sql
- supabase/migrations/20261105000300_repeatable_activity_achievements.sql
**Answer:**
Perfect Week requires all seven dates in a completed Monday-to-Sunday week; Perfect Month requires every date of its completed month; Perfect Year requires every date of its completed calendar year, including February 29 in a leap year. Each date must satisfy the server-confirmed Perfect Day success rule and have at least one eligible tracker with a positive target. Holidays, rest-only dates, skips, and missed required activity cannot count as successful dates. A tracker not scheduled on a date does not fail the date if another eligible tracker succeeds. These period badges can be earned again for different periods. Wins separately displays confirmed Perfect Day counts for the current week or month, and active Perfect Month awards toward the current year's 12 months. It can show confirmed partial counts when other dates cannot be verified; unknown dates remain uncounted and are not treated as failed. This display does not weaken the complete-period unlock requirements. The Comeback is earned after a qualifying tracker opportunity is followed by a genuinely missed required opportunity, then seven consecutive qualifying eligible opportunities. A saved skip does not trigger recovery, and neutral dates preserve the recovery run. These badges add no XP, and missing history is not reconstructed.

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
No. Analytics summarizes each measure separately, so values with different units are not added together. Comparable counts such as completed opportunities can be summed across trackers; the same calendar date can contribute once for each tracker. Measure values stay with their own tracker and unit.

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
