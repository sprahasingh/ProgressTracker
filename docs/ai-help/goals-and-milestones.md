# Goals, planning, and milestones

Planning targets are distinct from per-check-in thresholds. Daily recurring plans compare each scheduled date with a daily target. Cumulative deadline plans add eligible incremental entries toward one total and require a tracker deadline. Snapshot values are not summed. Each measure keeps its own unit and target. Allocation planning can distribute a cumulative target across scheduled dates.

Milestones are checkpoints linked optionally to a measure and value. They do not create extra progress entries. The goal view compares saved progress with the checkpoint using the measure's interpretation.

Source references: `src/domain/trackers/planning.ts`, `src/domain/trackers/allocationPreview.ts`, `src/features/trackers/GoalPlanningEditor.tsx`, `src/features/goals/GoalsPage.tsx`.
