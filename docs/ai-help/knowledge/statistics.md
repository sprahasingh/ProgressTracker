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
