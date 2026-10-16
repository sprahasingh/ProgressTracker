export type TrackerKind = 'habit' | 'goal' | 'challenge' | 'project'
export type TrackerStatus = 'active' | 'paused' | 'completed' | 'archived'

export type TrackerSchedule =
  | { kind: 'none' }
  | { kind: 'every-day' }
  | { kind: 'weekdays' }
  /** Weekday numbers use JavaScript's convention: Sunday is 0, Saturday is 6. */
  | { kind: 'selected-weekdays'; weekdays: number[] }
  | { kind: 'every-n-days'; interval: number }
  | { kind: 'times-per-week'; count: number; preferredWeekdays?: number[] }
  | { kind: 'times-per-month'; count: number }
  | { kind: 'specific-dates'; dates: string[] }
  | { kind: 'once'; date: string }

export type ThresholdConfiguration = {
  direction: 'increase' | 'decrease'
  minimum?: number
  target?: number
  stretch?: number
  streakQualification: 'minimum' | 'target' | 'any-recorded-value'
}

export type ChecklistItemDefinition = {
  id: string
  label: string
  position: number
}

export type TrackerMetricDefinition = {
  id: string
  name: string
  valueType: 'boolean' | 'quantity' | 'duration' | 'checklist'
  unit?: string
  /** v4 constraint for newly recorded numeric values and generated plan amounts. */
  precision?: { decimalPlaces: 0 | 1 | 2; increment: number }
  thresholds?: ThresholdConfiguration
  checklistItems?: ChecklistItemDefinition[]
  /** Retired measures stay in the definition so historical values keep their meaning. */
  retiredAt?: string
}

export function activeTrackerMetrics(metrics: readonly TrackerMetricDefinition[]): TrackerMetricDefinition[] {
  return metrics.filter((metric) => metric.retiredAt === undefined)
}

export type TrackerRule =
  | { kind: 'threshold'; metricId: string; level: 'minimum' | 'target' | 'stretch' }
  | { kind: 'comparison'; metricId: string; operator: 'equals' | 'greater-than' | 'at-least' | 'at-most'; value: boolean | number }
  | { kind: 'all' | 'any'; operands: TrackerRule[] }
  | { kind: 'at-least'; required: number; operands: TrackerRule[] }

export type TrackerStreakRuleMode = 'same-as-success' | 'custom'

export type CustomFieldType =
  | 'text'
  | 'long-text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'time'
  | 'duration'
  | 'single-select'
  | 'multi-select'
  | 'url'
  | 'rating'
  | 'quantity'

export type CustomFieldDefinition = {
  id: string
  name: string
  type: CustomFieldType
  required: boolean
  position: number
  unit?: string
  options?: string[]
  /** Retired fields remain available to interpret saved check-in values. */
  retiredAt?: string
}

export type TrackerMilestoneDefinition = {
  id: string
  title: string
  description: string
  /** Missing type preserves the original single-observation checkpoint behavior. */
  type?: TrackerMilestoneType
  metricId?: string
  targetValue?: number
  /** Snapshots keep a target's original measure semantics explicit across edits. */
  measureTypeSnapshot?: TrackerMetricDefinition['valueType']
  unitSnapshot?: string
  completionCondition?: 'true-day' | 'checklist-item-day' | 'checklist-complete-day'
  checklistItemId?: string
  checklistItemLabelSnapshot?: string
  checklistItemsSnapshot?: string[]
  dueDate?: string
  position: number
}

export type TrackerMilestoneType =
  | 'cumulative-quantity'
  | 'single-day-quantity'
  | 'successful-days'
  | 'streak-length'
  | 'challenge-day'
  | 'measure-completion-count'

export type GoalPlanningMode = 'daily-recurring' | 'cumulative-deadline'
export type TrackerSchedulingMode = 'calendar' | 'effective' | 'ongoing'
export type EffectiveDayCounting = 'planned-activity-days' | 'all-non-holiday-days'
export type TrackerScheduling = { mode: TrackerSchedulingMode; effectiveDays?: number; effectiveDayCounting?: EffectiveDayCounting; planningTimeZone?: string }
export type MetricProgressSemantics = 'incremental' | 'snapshot'
export type GoalPlanningConfiguration = {
  mode: GoalPlanningMode
  /** Missing semantics are treated as snapshots and are never summed. */
  progressSemantics: Record<string, MetricProgressSemantics>
  /** Per-scheduled-day targets. These are separate from metric thresholds. */
  dailyTargets: Record<string, number>
  /** Whole-period totals; only metrics explicitly marked incremental may use these. */
  cumulativeTargets: Record<string, number>
  /** IANA zone in which allocation calendar dates were planned (schema v3). */
  planningTimeZone?: string
  /** Confirmed cumulative per-metric allocations, keyed by metric ID then calendar date. */
  allocations?: Record<string, Record<string, number>>
  /** Only dates explicitly customized by the user. Generated plans are never persisted here. */
  manualAllocations?: Record<string, Record<string, number>>
}

/** The settings that determine how a saved date is interpreted. Metric definitions
 * are captured with the rules so thresholds and checklist meaning stay stable. */
export type TrackerEvaluationSnapshot = {
  schedule: TrackerSchedule
  startDate?: string | null
  deadline?: string | null
  scheduling?: TrackerScheduling | null
  metrics: TrackerMetricDefinition[]
  qualificationRule?: TrackerRule | null
  streakRuleMode?: TrackerStreakRuleMode | null
  streakRule?: TrackerRule | null
  strictMode?: boolean | null
}

/** A rule version is nested in its tracker record, so tracker ownership and the
 * tracker ID are inherited from the containing owner-scoped row. */
export type TrackerRuleVersion = {
  id: string
  effectiveFrom: string
  revision: number
  application: 'baseline' | 'apply-from-today' | 'recalculate-all-history'
  recordedAt: string
  evaluation: TrackerEvaluationSnapshot
}

export type TrackerDefinition = {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  id: string
  name: string
  description: string
  kind: TrackerKind
  status: TrackerStatus
  categoryId: string | null
  tags: string[]
  icon: string
  accent: string
  schedule: TrackerSchedule
  startDate?: string
  deadline?: string
  /** v6+ scheduling authority. Older versions infer calendar/ongoing from deadline presence. */
  scheduling?: TrackerScheduling
  metrics: TrackerMetricDefinition[]
  qualificationRule?: TrackerRule
  /** v8+ only. Missing mode preserves the tracker's original implicit streak behavior. */
  streakRuleMode?: TrackerStreakRuleMode
  /** Present only when streakRuleMode is custom. */
  streakRule?: TrackerRule
  customFields: CustomFieldDefinition[]
  milestones: TrackerMilestoneDefinition[]
  goalPlanning?: GoalPlanningConfiguration
  /** When true, each calendar date through the active period is a streak opportunity. */
  strictMode?: boolean
  /** v10: ordered inclusive start dates; the next version implicitly closes the previous one. */
  ruleVersions?: TrackerRuleVersion[]
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  deletedAt: string | null
}

export type TrackerValue = string | number | boolean | null | TrackerValue[] | { [key: string]: TrackerValue }

export type TrackerEntry = {
  id: string
  trackerId: string
  date: string
  outcome: 'recorded' | 'skipped'
  values: Record<string, TrackerValue>
  note: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}
