import { z } from 'zod'
import { isGoalAutoPlanningDate, trackerActiveStartDate } from './planning'

const id = z.string().min(1)
const calendarDate = z.iso.date()
const weekday = z.number().int().min(0).max(6)
const unique = <T extends string | number>(values: T[]) => new Set(values).size === values.length

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('every-day') }),
  z.object({ kind: z.literal('weekdays') }),
  z.object({ kind: z.literal('selected-weekdays'), weekdays: z.array(weekday).min(1).max(7).refine(unique) }),
  z.object({ kind: z.literal('every-n-days'), interval: z.number().int().positive() }),
  z.object({ kind: z.literal('times-per-week'), count: z.number().int().min(1).max(7), preferredWeekdays: z.array(weekday).max(7).refine(unique).optional() }),
  z.object({ kind: z.literal('times-per-month'), count: z.number().int().min(1).max(31) }),
  z.object({ kind: z.literal('specific-dates'), dates: z.array(calendarDate).min(1).refine(unique) }),
  z.object({ kind: z.literal('once'), date: calendarDate }),
])

const thresholdSchema = z.object({
  direction: z.enum(['increase', 'decrease']),
  minimum: z.number().finite().min(0, 'Target must be zero or greater.').optional(),
  target: z.number().finite().min(0, 'Target must be zero or greater.').optional(),
  stretch: z.number().finite().min(0, 'Target must be zero or greater.').optional(),
  streakQualification: z.enum(['minimum', 'target', 'any-recorded-value']),
}).superRefine((value, context) => {
  const levels = [value.minimum, value.target, value.stretch].filter((n): n is number => n !== undefined)
  for (let i = 1; i < levels.length; i++) {
    const previous = levels[i - 1]!
    const current = levels[i]!
    const ordered = value.direction === 'increase' ? previous <= current : previous >= current
    if (!ordered) context.addIssue({ code: 'custom', message: 'Threshold levels must follow the configured direction.' })
  }
  if (value.streakQualification === 'minimum' && value.minimum === undefined) context.addIssue({ code: 'custom', path: ['minimum'], message: 'Minimum qualification requires a minimum threshold.' })
  if (value.streakQualification === 'target' && value.target === undefined) context.addIssue({ code: 'custom', path: ['target'], message: 'Target qualification requires a target threshold.' })
})

const metricSchema = z.object({
  id,
  name: z.string().trim().min(1),
  valueType: z.enum(['boolean', 'quantity', 'duration', 'checklist']),
  unit: z.string().optional(),
  precision: z.object({ decimalPlaces: z.union([z.literal(0), z.literal(1), z.literal(2)]), increment: z.number().finite().positive() }).optional(),
  thresholds: thresholdSchema.optional(),
  checklistItems: z.array(z.object({ id, label: z.string().trim().min(1), position: z.number().int().nonnegative() })).optional(),
  retiredAt: z.iso.datetime().optional(),
}).superRefine((metric, context) => {
  if (metric.precision) {
    if (!['quantity', 'duration'].includes(metric.valueType)) context.addIssue({ code: 'custom', path: ['precision'], message: 'Numeric precision applies only to quantity and duration measures.' })
    const factor = 10 ** metric.precision.decimalPlaces
    if (Math.abs(metric.precision.increment * factor - Math.round(metric.precision.increment * factor)) > 1e-8) context.addIssue({ code: 'custom', path: ['precision', 'increment'], message: 'The allowed increment must fit the selected decimal places.' })
    for (const [level, threshold] of Object.entries(metric.thresholds ?? {})) {
      if (typeof threshold === 'number' && !isAllowedIncrement(threshold, metric.precision.increment)) context.addIssue({ code: 'custom', path: ['thresholds', level], message: `Threshold must use increments of ${metric.precision.increment}.` })
    }
  }
  if (metric.valueType === 'checklist' && !metric.checklistItems?.length) context.addIssue({ code: 'custom', path: ['checklistItems'], message: 'Checklist metrics require at least one item.' })
  if (metric.valueType !== 'checklist' && metric.checklistItems !== undefined) context.addIssue({ code: 'custom', path: ['checklistItems'], message: 'Only checklist metrics may define checklist items.' })
  if (metric.valueType === 'boolean' && metric.thresholds) context.addIssue({ code: 'custom', path: ['thresholds'], message: 'Boolean metrics cannot define numeric thresholds.' })
  if (metric.valueType === 'checklist' && metric.thresholds) {
    if (metric.thresholds.direction !== 'increase') context.addIssue({ code: 'custom', path: ['thresholds', 'direction'], message: 'Checklist completion thresholds must increase.' })
    for (const level of ['minimum', 'target', 'stretch'] as const) {
      const threshold = metric.thresholds[level]
      if (threshold !== undefined && threshold > (metric.checklistItems?.length ?? 0)) context.addIssue({ code: 'custom', path: ['thresholds', level], message: 'Checklist thresholds cannot exceed the number of checklist items.' })
    }
  }
})

const ruleSchema: z.ZodType<unknown> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('threshold'), metricId: id, level: z.enum(['minimum', 'target', 'stretch']) }),
  z.object({ kind: z.literal('comparison'), metricId: id, operator: z.enum(['equals', 'at-least', 'at-most']), value: z.union([z.boolean(), z.number().finite().min(0, 'Target must be zero or greater.')]) }),
  z.object({ kind: z.enum(['all', 'any']), operands: z.array(ruleSchema).min(2) }),
  z.object({ kind: z.literal('at-least'), required: z.number().int().positive(), operands: z.array(ruleSchema).min(1) }).superRefine((rule, context) => {
    if (rule.required > rule.operands.length) context.addIssue({ code: 'custom', path: ['required'], message: 'Required count cannot exceed the number of operands.' })
  }),
]))

const customFieldSchema = z.object({
  id,
  name: z.string().trim().min(1),
  type: z.enum(['text', 'long-text', 'integer', 'decimal', 'boolean', 'date', 'time', 'duration', 'single-select', 'multi-select', 'url', 'rating', 'quantity']),
  required: z.boolean(),
  position: z.number().int().nonnegative(),
  unit: z.string().optional(),
  options: z.array(z.string().trim().min(1)).optional(),
}).superRefine((field, context) => {
  const select = field.type === 'single-select' || field.type === 'multi-select'
  if (select && !field.options?.length) context.addIssue({ code: 'custom', path: ['options'], message: 'Select fields require at least one option.' })
  if (!select && field.options !== undefined) context.addIssue({ code: 'custom', path: ['options'], message: 'Options are only valid for select fields.' })
  if (field.options && !unique(field.options)) context.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique.' })
})

const planningTarget = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER)
const positivePlanningTarget = z.number().finite().gt(0, 'Goal targets must be greater than zero.').max(Number.MAX_SAFE_INTEGER)
const goalPlanningSchema = z.object({
  mode: z.enum(['daily-recurring', 'cumulative-deadline']),
  progressSemantics: z.record(z.string(), z.enum(['incremental', 'snapshot'])),
  dailyTargets: z.record(z.string(), positivePlanningTarget),
  cumulativeTargets: z.record(z.string(), positivePlanningTarget),
  planningTimeZone: z.string().min(1).optional(),
  allocations: z.record(z.string(), z.record(z.iso.date(), planningTarget)).optional(),
  manualAllocations: z.record(z.string(), z.record(z.iso.date(), planningTarget)).optional(),
})
const trackerSchedulingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('calendar') }),
  z.object({ mode: z.literal('effective'), effectiveDays: z.number().int().positive().max(100_000), effectiveDayCounting: z.enum(['planned-activity-days', 'all-non-holiday-days']).optional(), planningTimeZone: z.string().min(1).optional() }),
  z.object({ mode: z.literal('ongoing') }),
])

function isIanaTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}

const ruleMetricsCheck = (rule: unknown, metrics: Map<string, z.infer<typeof metricSchema>>, context: z.RefinementCtx, path: (string | number)[] = []) => {
  if (typeof rule !== 'object' || rule === null) return
  const value = rule as Record<string, unknown>
  if (value.kind === 'threshold' || value.kind === 'comparison') {
    const metric = metrics.get(String(value.metricId))
    if (!metric) context.addIssue({ code: 'custom', path, message: 'Rule references an unknown metric.' })
    else if (value.kind === 'threshold') {
      if (!metric.thresholds || metric.thresholds[value.level as 'minimum' | 'target' | 'stretch'] === undefined) context.addIssue({ code: 'custom', path, message: 'Threshold rule references an undefined metric level.' })
      else if (metric.valueType !== 'boolean' && metric.thresholds.direction === 'increase' && metric.thresholds[value.level as 'minimum' | 'target' | 'stretch'] === 0) context.addIssue({ code: 'custom', path, message: 'A zero threshold qualifies every nonnegative value. Choose a positive threshold or change the success condition.' })
    } else if (typeof value.value === 'boolean' ? metric.valueType !== 'boolean' : metric.valueType === 'boolean') {
      context.addIssue({ code: 'custom', path, message: 'Comparison value does not match metric type.' })
    } else if (metric.valueType === 'boolean' && value.operator !== 'equals') {
      context.addIssue({ code: 'custom', path: [...path, 'operator'], message: 'Boolean comparisons support Equals only.' })
    } else if (metric.valueType !== 'boolean' && value.operator === 'at-least' && value.value === 0) {
      context.addIssue({ code: 'custom', path, message: 'A comparison of at least zero always qualifies. Choose a positive value or a different condition.' })
    } else if (metric.valueType === 'checklist' && (typeof value.value !== 'number' || !Number.isInteger(value.value) || value.value > (metric.checklistItems?.length ?? 0))) {
      context.addIssue({ code: 'custom', path: [...path, 'value'], message: 'Checklist comparisons use a whole checked-item count within the checklist size.' })
    } else if (metric.precision && typeof value.value === 'number' && !isAllowedIncrement(value.value, metric.precision.increment)) {
      context.addIssue({ code: 'custom', path: [...path, 'value'], message: `Comparison value must use increments of ${metric.precision.increment}.` })
    }
  }
  if (Array.isArray(value.operands)) value.operands.forEach((operand, index) => ruleMetricsCheck(operand, metrics, context, [...path, 'operands', index]))
}

export const trackerDefinitionSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
  id,
  name: z.string().trim().min(1),
  description: z.string(),
  kind: z.enum(['habit', 'goal', 'challenge', 'project']),
  status: z.enum(['active', 'paused', 'completed', 'archived']),
  categoryId: id.nullable(),
  tags: z.array(z.string().trim().min(1)).refine(unique),
  icon: z.string(),
  accent: z.string(),
  schedule: scheduleSchema,
  startDate: calendarDate.optional(),
  deadline: calendarDate.optional(),
  scheduling: trackerSchedulingSchema.optional(),
  metrics: z.array(metricSchema),
  qualificationRule: ruleSchema.optional(),
  streakRuleMode: z.enum(['same-as-success', 'custom']).optional(),
  streakRule: ruleSchema.optional(),
  customFields: z.array(customFieldSchema),
  milestones: z.array(z.object({ id, title: z.string().trim().min(1), description: z.string(), metricId: id.optional(), targetValue: z.number().finite().min(0).optional(), dueDate: calendarDate.optional(), position: z.number().int().nonnegative() })),
  goalPlanning: goalPlanningSchema.optional(),
  strictMode: z.boolean().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
}).superRefine((tracker, context) => {
  if (tracker.schemaVersion === 1 && tracker.goalPlanning) context.addIssue({ code: 'custom', path: ['goalPlanning'], message: 'Planning configuration requires tracker schema version 2.' })
  if ((tracker.schemaVersion === 2 || tracker.schemaVersion === 3) && (tracker.kind !== 'goal' || !tracker.goalPlanning)) context.addIssue({ code: 'custom', path: ['goalPlanning'], message: `Schema version ${tracker.schemaVersion} is reserved for goals with planning configuration.` })
  if (tracker.schemaVersion < 3 && (tracker.goalPlanning?.planningTimeZone !== undefined || tracker.goalPlanning?.allocations !== undefined || tracker.goalPlanning?.manualAllocations !== undefined)) context.addIssue({ code: 'custom', path: ['goalPlanning'], message: 'Persistent allocations require tracker schema version 3.' })
  if (tracker.schemaVersion < 4 && tracker.metrics.some((metric) => metric.precision !== undefined)) context.addIssue({ code: 'custom', path: ['metrics'], message: 'Saved numeric precision settings require tracker schema version 4.' })
  if (tracker.schemaVersion === 3 && (!tracker.goalPlanning?.planningTimeZone || !tracker.goalPlanning.allocations)) context.addIssue({ code: 'custom', path: ['goalPlanning'], message: 'Schema version 3 requires a planning time zone and allocation map.' })
  if ([3, 4, 5, 6, 7, 8].includes(tracker.schemaVersion) && tracker.goalPlanning?.planningTimeZone && !isIanaTimeZone(tracker.goalPlanning.planningTimeZone)) context.addIssue({ code: 'custom', path: ['goalPlanning', 'planningTimeZone'], message: 'Planning time zone must be a valid IANA time zone.' })
  if ([6, 7, 8].includes(tracker.schemaVersion) && tracker.scheduling?.mode === 'effective' && tracker.scheduling.planningTimeZone && !isIanaTimeZone(tracker.scheduling.planningTimeZone)) context.addIssue({ code: 'custom', path: ['scheduling', 'planningTimeZone'], message: 'Scheduling time zone must be a valid IANA time zone.' })
  if (tracker.schemaVersion === 5 && (tracker.kind !== 'goal' || tracker.goalPlanning?.mode !== 'cumulative-deadline' || !tracker.goalPlanning.planningTimeZone || !tracker.goalPlanning.allocations || !tracker.goalPlanning.manualAllocations)) context.addIssue({ code: 'custom', path: ['goalPlanning'], message: 'Schema version 5 requires a timezone-aware cumulative goal with separate manual allocations.' })
  if ([6, 7, 8].includes(tracker.schemaVersion) && !tracker.scheduling) context.addIssue({ code: 'custom', path: ['scheduling'], message: 'Schema v6 and newer require an explicit scheduling mode.' })
  if (tracker.schemaVersion < 6 && tracker.scheduling !== undefined) context.addIssue({ code: 'custom', path: ['scheduling'], message: 'Explicit scheduling modes require tracker schema version 6.' })
  if ([6, 7, 8].includes(tracker.schemaVersion) && tracker.scheduling?.mode === 'calendar' && !tracker.deadline) context.addIssue({ code: 'custom', path: ['deadline'], message: 'Calendar scheduling requires a deadline.' })
  if ([6, 7, 8].includes(tracker.schemaVersion) && tracker.scheduling?.mode === 'effective' && (!tracker.scheduling.effectiveDays || !tracker.deadline)) context.addIssue({ code: 'custom', path: ['scheduling'], message: 'Effective scheduling requires a positive day target and a calculated deadline.' })
  if ([6, 7, 8].includes(tracker.schemaVersion) && tracker.scheduling?.mode === 'ongoing' && tracker.deadline) context.addIssue({ code: 'custom', path: ['deadline'], message: 'Ongoing scheduling cannot have a deadline.' })
  if ([7, 8].includes(tracker.schemaVersion) && tracker.scheduling?.mode === 'effective' && !tracker.scheduling.effectiveDayCounting) context.addIssue({ code: 'custom', path: ['scheduling', 'effectiveDayCounting'], message: 'Schema version 7 and newer Effective Days require an explicit counting method.' })
  if (tracker.scheduling && tracker.scheduling.mode !== 'effective' && 'effectiveDayCounting' in tracker.scheduling && tracker.scheduling.effectiveDayCounting !== undefined) context.addIssue({ code: 'custom', path: ['scheduling', 'effectiveDayCounting'], message: 'Effective day counting applies only to Effective Days scheduling.' })
  if (tracker.schemaVersion < 5 && tracker.goalPlanning?.manualAllocations !== undefined) context.addIssue({ code: 'custom', path: ['goalPlanning', 'manualAllocations'], message: 'Separate manual allocations require tracker schema version 5.' })
  if (tracker.schemaVersion < 8 && (tracker.streakRuleMode !== undefined || tracker.streakRule !== undefined)) context.addIssue({ code: 'custom', path: ['streakRuleMode'], message: 'Separate streak rules require tracker schema version 8.' })
  if (tracker.schemaVersion === 8 && tracker.streakRuleMode === undefined) context.addIssue({ code: 'custom', path: ['streakRuleMode'], message: 'Schema version 8 requires an explicit streak rule mode.' })
  if (tracker.streakRuleMode === 'custom' && tracker.streakRule === undefined) context.addIssue({ code: 'custom', path: ['streakRule'], message: 'Add at least one valid streak condition.' })
  if (tracker.streakRuleMode === 'same-as-success' && tracker.streakRule !== undefined) context.addIssue({ code: 'custom', path: ['streakRule'], message: 'Same as Success Rule uses the saved success rule directly.' })
  if (tracker.startDate && tracker.deadline && tracker.deadline < tracker.startDate) context.addIssue({ code: 'custom', path: ['deadline'], message: 'Deadline cannot precede start date.' })
  const metrics = new Map(tracker.metrics.map((metric) => [metric.id, metric]))
  if (tracker.streakRuleMode === 'custom' && tracker.streakRule !== undefined) ruleMetricsCheck(tracker.streakRule, metrics, context, ['streakRule'])
  if (metrics.size !== tracker.metrics.length) context.addIssue({ code: 'custom', path: ['metrics'], message: 'Metric IDs must be unique.' })
  const normalizedNames = new Map<string, number>()
  tracker.metrics.forEach((metric, index) => {
    const key = metric.name.trim().toLowerCase()
    const first = normalizedNames.get(key)
    if (first !== undefined) context.addIssue({ code: 'custom', path: ['metrics', index, 'name'], message: `This name duplicates “${tracker.metrics[first]!.name}”. Choose a different measure name.` })
    else normalizedNames.set(key, index)
  })
  const customIds = tracker.customFields.map((field) => field.id)
  if (!unique(customIds)) context.addIssue({ code: 'custom', path: ['customFields'], message: 'Custom field IDs must be unique.' })
  tracker.milestones.forEach((milestone, index) => {
    if (milestone.metricId) {
      const metric = metrics.get(milestone.metricId)
      if (!metric) context.addIssue({ code: 'custom', path: ['milestones', index, 'metricId'], message: 'Milestone references an unknown metric.' })
      else if (milestone.targetValue !== undefined && metric.valueType === 'boolean' && ![0, 1].includes(milestone.targetValue)) context.addIssue({ code: 'custom', path: ['milestones', index, 'targetValue'], message: 'Boolean milestones use checkpoint 1 (true) or 0 (false).' })
      else if (milestone.targetValue !== undefined && metric.valueType === 'checklist' && (!Number.isInteger(milestone.targetValue) || milestone.targetValue > (metric.checklistItems?.length ?? 0))) context.addIssue({ code: 'custom', path: ['milestones', index, 'targetValue'], message: 'Checklist milestones use a whole checked-item count within the checklist size.' })
    }
  })
  if (tracker.goalPlanning) {
    const plan = tracker.goalPlanning
    if (plan.mode === 'cumulative-deadline' && !tracker.deadline) context.addIssue({ code: 'custom', path: ['deadline'], message: 'Cumulative goals require a deadline.' })
    for (const [field, targets] of [['dailyTargets', plan.dailyTargets], ['cumulativeTargets', plan.cumulativeTargets]] as const) {
      for (const [metricId, target] of Object.entries(targets)) {
        const metric = metrics.get(metricId)
        if (!metric) {
          context.addIssue({ code: 'custom', path: ['goalPlanning', field, metricId], message: 'Planning target references an unknown metric.' })
          continue
        }
        if (metric.valueType === 'boolean') {
          context.addIssue({ code: 'custom', path: ['goalPlanning', field, metricId], message: 'Boolean metrics cannot have numeric planning targets.' })
          continue
        }
        if (metric.valueType === 'checklist') {
          if (!Number.isInteger(target)) context.addIssue({ code: 'custom', path: ['goalPlanning', field, metricId], message: 'Checklist targets must be whole item counts.' })
          if (field === 'dailyTargets' && target > (metric.checklistItems?.length ?? 0)) context.addIssue({ code: 'custom', path: ['goalPlanning', field, metricId], message: 'Daily checklist targets cannot exceed the number of items.' })
        }
        if (metric.precision && !isAllowedIncrement(target, metric.precision.increment)) context.addIssue({ code: 'custom', path: ['goalPlanning', field, metricId], message: `Planning target must use increments of ${metric.precision.increment}.` })
        if (field === 'cumulativeTargets' && plan.progressSemantics[metricId] !== 'incremental') {
          context.addIssue({ code: 'custom', path: ['goalPlanning', 'progressSemantics', metricId], message: 'Cumulative targets require explicit incremental-progress semantics.' })
        }
      }
    }
    for (const [metricId] of Object.entries(plan.progressSemantics)) {
      const metric = metrics.get(metricId)
      if (!metric) context.addIssue({ code: 'custom', path: ['goalPlanning', 'progressSemantics', metricId], message: 'Progress semantics reference an unknown metric.' })
      else if (metric.valueType === 'boolean') context.addIssue({ code: 'custom', path: ['goalPlanning', 'progressSemantics', metricId], message: 'Boolean metrics do not support numeric progress semantics.' })
    }
    for (const [allocationField, allocationMap] of [['allocations', plan.allocations], ['manualAllocations', plan.manualAllocations]] as const) {
      if (allocationMap) for (const [metricId, datedAmounts] of Object.entries(allocationMap)) {
        const metric = metrics.get(metricId)
        if (!metric) {
          context.addIssue({ code: 'custom', path: ['goalPlanning', allocationField, metricId], message: 'Allocation references an unknown metric.' })
          continue
        }
        if (metric.valueType === 'boolean' || plan.progressSemantics[metricId] !== 'incremental' || plan.cumulativeTargets[metricId] === undefined) {
          context.addIssue({ code: 'custom', path: ['goalPlanning', allocationField, metricId], message: 'Allocations require an incremental metric with a cumulative target.' })
          continue
        }
        for (const [date, amount] of Object.entries(datedAmounts)) {
          if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) context.addIssue({ code: 'custom', path: ['goalPlanning', allocationField, metricId, date], message: 'Allocation must be a finite nonnegative amount.' })
          if (metric.precision && !isAllowedIncrement(amount, metric.precision.increment)) context.addIssue({ code: 'custom', path: ['goalPlanning', allocationField, metricId, date], message: `Allocation must use increments of ${metric.precision.increment}.` })
          if (metric.valueType === 'checklist' && (!Number.isInteger(amount) || amount > (metric.checklistItems?.length ?? 0))) context.addIssue({ code: 'custom', path: ['goalPlanning', allocationField, metricId, date], message: 'Checklist allocations must be whole item counts within the checklist size.' })
          const effectiveStartDate = trackerActiveStartDate(tracker, plan.planningTimeZone)
          const historicalAllocation = date < effectiveStartDate
          const scheduled = allocationField === 'manualAllocations' || historicalAllocation || (tracker.deadline && date <= tracker.deadline && isGoalAutoPlanningDate({ ...tracker, startDate: effectiveStartDate } as import('./types').TrackerDefinition, date, new Set(), plan.planningTimeZone))
          if (!scheduled) context.addIssue({ code: 'custom', path: ['goalPlanning', allocationField, metricId, date], message: 'Allocations must use scheduled dates on or before the goal deadline. Saved allocations before a later start date remain preserved as history.' })
        }
      }
    }
  }
  if (tracker.qualificationRule) ruleMetricsCheck(tracker.qualificationRule, metrics, context, ['qualificationRule'])
  if (tracker.schemaVersion === 4 && !tracker.metrics.some((metric) => metric.precision !== undefined)) context.addIssue({ code: 'custom', path: ['schemaVersion'], message: 'Schema version 4 requires at least one numeric precision setting.' })
  })

export const trackerEntrySchema = z.object({
  id,
  trackerId: id,
  date: calendarDate,
  outcome: z.enum(['recorded', 'skipped']),
  values: z.record(z.string(), z.json()),
  note: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
})

function isAllowedIncrement(value: number, increment: number): boolean {
  const units = value / increment
  return Math.abs(units - Math.round(units)) <= Math.max(1, Math.abs(units)) * Number.EPSILON * 8
}

/** Validate typed values against a tracker's metric and custom-field definitions. */
export function validateTrackerEntryValues(tracker: {
  metrics: Array<{ id: string; valueType: string; checklistItems?: Array<{ id: string }>; precision?: { decimalPlaces: 0 | 1 | 2; increment: number }; retiredAt?: string }>
  customFields: Array<{ id: string; type: string; required: boolean; options?: string[] }>
}, values: Record<string, unknown>, options: { enforcePrecision?: boolean; existingValues?: Record<string, unknown> } = {}): string | undefined {
  const allowed = new Set<string>()
  for (const metric of tracker.metrics) {
    allowed.add(metric.id)
    const value = values[metric.id]
    if (value === undefined || value === null) continue
    const unchangedExistingValue = options.existingValues !== undefined && Object.hasOwn(options.existingValues, metric.id)
      && options.existingValues[metric.id] === value
    if (metric.retiredAt && !unchangedExistingValue) return 'Retired measures cannot be used in new check-ins.'
    if (metric.valueType === 'boolean' && typeof value !== 'boolean') return 'Boolean measures need a yes or no value.'
    if ((metric.valueType === 'quantity' || metric.valueType === 'duration') && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return 'Numeric measures must be finite, nonnegative numbers.'
    if (options.enforcePrecision !== false && !unchangedExistingValue && metric.precision && typeof value === 'number' && !isAllowedIncrement(value, metric.precision.increment)) return `Use increments of ${metric.precision.increment} for this measure.`
    if (metric.valueType === 'checklist') {
      if (typeof value !== 'object' || Array.isArray(value)) return 'Checklist progress is invalid.'
      const checks = value as Record<string, unknown>
      if (Object.keys(checks).some((key) => !metric.checklistItems?.some((item) => item.id === key)) || Object.values(checks).some((checked) => typeof checked !== 'boolean')) return 'Checklist progress is invalid.'
    }
  }
  for (const field of tracker.customFields) {
    const key = `field:${field.id}`
    allowed.add(key)
    const value = values[key]
    if ((value === undefined || value === null || value === '') && field.required) return `${field.id} is required.`
    if (value === undefined || value === null || value === '') continue
    const numeric = field.type === 'integer' || field.type === 'decimal' || field.type === 'duration' || field.type === 'rating' || field.type === 'quantity'
    if (numeric && (typeof value !== 'number' || !Number.isFinite(value))) return `${field.id} must be a valid number.`
    if (field.type === 'integer' && !Number.isInteger(value)) return `${field.id} must be a whole number.`
    if ((field.type === 'boolean' && typeof value !== 'boolean') || (['text', 'long-text', 'date', 'time', 'single-select', 'url'].includes(field.type) && typeof value !== 'string') || (field.type === 'multi-select' && (!Array.isArray(value) || value.some((option) => typeof option !== 'string')))) return `${field.id} has an invalid value.`
    if (field.options && (typeof value === 'string' && !field.options.includes(value) || Array.isArray(value) && value.some((option) => !field.options?.includes(String(option))))) return `${field.id} has an invalid option.`
  }
  if (Object.keys(values).some((key) => !allowed.has(key))) return 'This entry contains a value that is not configured for the tracker.'
}

export type TrackerDefinitionInput = z.input<typeof trackerDefinitionSchema>
export type TrackerEntryInput = z.input<typeof trackerEntrySchema>
