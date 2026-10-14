# Goals

### ID: daily-vs-cumulative-goal
**Category:** goals
**Question:** What is the difference between daily and cumulative goals?
**Aliases:**
- How does cumulative progress work?
- Does my goal target reset every day?
**Keywords:** daily plan, cumulative plan, target, allocations, progress
**Suggestible:** true
**Sources:**
- src/domain/trackers/planning.ts
- src/domain/trackers/allocationPreview.ts
- src/domain/trackers/goalPlanning.test.ts
- src/features/goals/GoalsPage.tsx
**Answer:**
A daily plan sets a target for each planned day. A cumulative plan sets a total amount to reach across its date range, with progress allocated across the plan. Which model applies depends on the saved goal plan.

### ID: milestones
**Category:** goals
**Question:** How are milestones calculated?
**Aliases:**
- When is a milestone reached?
- What does a linked milestone mean?
**Keywords:** goal, milestone, target, progress, linked measure
**Suggestible:** true
**Sources:**
- src/domain/trackers/planning.ts
- src/domain/trackers/allocationPreview.ts
- src/features/goals/GoalsPage.tsx
**Answer:**
A milestone is reached when the progress used by its linked goal plan meets the milestone target. The exact progress comes from that goal’s daily or cumulative plan and its eligible recorded values.

### ID: goal-deadline
**Category:** goals
**Question:** Can a goal have a deadline?
**Aliases:**
- How does a goal deadline work?
- What happens when a goal’s end date passes?
**Keywords:** goal, deadline, cumulative, active period, target
**Suggestible:** true
**Sources:**
- src/domain/trackers/planning.ts
- src/features/trackers/GoalPlanningEditor.tsx
- src/domain/trackers/goalPlanning.test.ts
**Answer:**
Yes. The deadline is a tracker setting shared by the goal form and advanced planning. A cumulative plan uses that same date to bound its planned range; progress and pacing use the scheduled dates through the deadline, and dates after it are not included in cumulative progress.

### ID: complete-goal
**Category:** goals
**Question:** When is a goal complete?
**Aliases:**
- How do I know I reached my goal target?
- Does reaching a milestone complete the goal?
**Keywords:** goal, completed, target, progress, milestone
**Suggestible:** true
**Sources:**
- src/features/goals/GoalsPage.tsx
- src/domain/trackers/planning.ts
- src/domain/trackers/goalPlanning.test.ts
**Answer:**
The goal plan reports its target as complete when no planned work remains. The Goals page also shows the tracker’s saved status, so the displayed status can depend on both the goal state and plan. A milestone is a checkpoint within a plan; reaching one does not by itself mean the overall target is complete.

### ID: goal-daily-missing
**Category:** goals
**Question:** How does a daily goal plan treat a missing date?
**Aliases:**
- Does a missed day count as meeting my daily target?
- What happens to a daily target when I do not check in?
**Keywords:** daily goal, missing, missed, target, schedule
**Suggestible:** true
**Sources:**
- src/domain/trackers/planning.ts
- src/domain/trackers/goalPlanning.test.ts
**Answer:**
A past scheduled date without a usable check-in is treated as missed in the daily plan. Today remains pending while it is still open, and rest days, holidays, and future dates are shown separately rather than as missed opportunities.

### ID: goal-cumulative-snapshot
**Category:** goals
**Question:** Do snapshot check-ins add together toward a cumulative goal?
**Aliases:**
- Are repeated snapshot values summed for a total goal?
- Which entries count toward cumulative progress?
**Keywords:** cumulative goal, snapshot, incremental, total progress
**Suggestible:** true
**Sources:**
- src/domain/trackers/planning.ts
- src/features/trackers/GoalPlanningEditor.tsx
- src/domain/trackers/goalPlanning.test.ts
**Answer:**
No. Cumulative progress sums entries configured as incremental. Snapshot values describe a level at a point in time and are not added together across dates.

### ID: goal-clearing-entry
**Category:** goals
**Question:** Does clearing a check-in change goal progress?
**Aliases:**
- Will a deleted entry reduce my goal total?
- Does removing a historical check-in recalculate the goal?
- Can clearing a check-in change my goal progress?
- Will my goal total go down if I clear an entry?
- Does removing a check-in update the Goals page?
**Keywords:** goal progress, clear check-in, delete entry, recalculate
**Suggestible:** true
**Sources:**
- src/domain/trackers/planning.ts
- src/db/localRepository.ts
- src/features/history/HistoryPage.tsx
**Answer:**
Goal progress is calculated from active saved entries, so clearing a check-in can change the displayed progress or pacing. The effect depends on the plan and whether that entry contributes a qualifying value.

### ID: goal-target-change
**Category:** goals
**Question:** What happens if I change a goal target?
**Aliases:**
- Does editing my target change saved check-ins?
- Will a new goal target recalculate my plan?
**Keywords:** goal target, edit plan, recalculation, saved progress
**Suggestible:** true
**Sources:**
- src/features/goals/GoalsPage.tsx
- src/features/trackers/GoalPlanningEditor.tsx
- src/domain/trackers/planning.ts
**Answer:**
The plan and its remaining pace are recalculated against the new target and existing saved progress. Changing the target does not rewrite the check-ins themselves.

### ID: goal-metric-unit
**Category:** goals
**Question:** Where does a goal’s unit come from?
**Aliases:**
- How does a goal know whether progress is pages or minutes?
- Can I choose a different unit for goal progress?
**Keywords:** goal, measure, unit, metric, quantity
**Suggestible:** true
**Sources:**
- src/features/goals/GoalsPage.tsx
- src/domain/trackers/planning.ts
- src/features/trackers/GoalPlanningEditor.tsx
**Answer:**
The goal uses the unit of its linked tracker measure. Choose or edit the measure’s unit in tracker configuration; the goal plan displays values in that unit rather than converting them.
