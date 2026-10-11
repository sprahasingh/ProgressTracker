# Measures and success rules

Each tracker has one or more measures. New measures are Yes/no or Quantity. Existing Duration and Checklist measures remain supported. A saved measure's type and historical meaning are immutable. To track a different value, add a new measure. A measure with check-in history can be retired: it leaves future check-in forms while its definition remains available to History and Analytics.

Quantity thresholds can have Minimum, Target, and Stretch levels for one check-in. They are separate from goal planning totals. Higher or lower can represent progress. Numeric values are nonnegative; an increasing success condition at zero is rejected because it would qualify every nonnegative value.

Success rules define whether a recorded check-in qualifies. A condition can compare a value or use a configured threshold. Nested All (AND), Any (OR), and At least N rules combine conditions. Rules affect qualification and streak summaries, not the saved value itself.

Source references: `src/domain/trackers/types.ts`, `src/domain/trackers/schema.ts`, `src/domain/trackers/progression.ts`, `src/domain/trackers/invariants.ts`, `src/db/localRepository.ts`, `supabase/migrations/20261018000100_tracker_metric_integrity.sql`.
