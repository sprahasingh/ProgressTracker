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
Yes. A goal can use a deadline to bound its planned date range, especially for cumulative targets. Progress and pacing are calculated within that plan period; dates after the tracker deadline are not included in its cumulative progress.

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
