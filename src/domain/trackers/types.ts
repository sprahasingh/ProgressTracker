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
  thresholds?: ThresholdConfiguration
  checklistItems?: ChecklistItemDefinition[]
}

export type TrackerRule =
  | { kind: 'threshold'; metricId: string; level: 'minimum' | 'target' | 'stretch' }
  | { kind: 'comparison'; metricId: string; operator: 'equals' | 'at-least' | 'at-most'; value: boolean | number }
  | { kind: 'all' | 'any'; operands: TrackerRule[] }
  | { kind: 'at-least'; required: number; operands: TrackerRule[] }

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
}

export type TrackerMilestoneDefinition = {
  id: string
  title: string
  description: string
  metricId?: string
  targetValue?: number
  dueDate?: string
  position: number
}

export type TrackerDefinition = {
  schemaVersion: 1
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
  metrics: TrackerMetricDefinition[]
  qualificationRule?: TrackerRule
  customFields: CustomFieldDefinition[]
  milestones: TrackerMilestoneDefinition[]
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
