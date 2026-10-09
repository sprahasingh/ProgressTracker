import { z } from 'zod'

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
  minimum: z.number().finite().optional(),
  target: z.number().finite().optional(),
  stretch: z.number().finite().optional(),
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
  thresholds: thresholdSchema.optional(),
  checklistItems: z.array(z.object({ id, label: z.string().trim().min(1), position: z.number().int().nonnegative() })).optional(),
}).superRefine((metric, context) => {
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
  z.object({ kind: z.literal('comparison'), metricId: id, operator: z.enum(['equals', 'at-least', 'at-most']), value: z.union([z.boolean(), z.number().finite()]) }),
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

const ruleMetricsCheck = (rule: unknown, metrics: Map<string, z.infer<typeof metricSchema>>, context: z.RefinementCtx, path: (string | number)[] = []) => {
  if (typeof rule !== 'object' || rule === null) return
  const value = rule as Record<string, unknown>
  if (value.kind === 'threshold' || value.kind === 'comparison') {
    const metric = metrics.get(String(value.metricId))
    if (!metric) context.addIssue({ code: 'custom', path, message: 'Rule references an unknown metric.' })
    else if (value.kind === 'threshold') {
      if (!metric.thresholds || metric.thresholds[value.level as 'minimum' | 'target' | 'stretch'] === undefined) context.addIssue({ code: 'custom', path, message: 'Threshold rule references an undefined metric level.' })
    } else if (typeof value.value === 'boolean' ? metric.valueType !== 'boolean' : metric.valueType === 'boolean') {
      context.addIssue({ code: 'custom', path, message: 'Comparison value does not match metric type.' })
    }
  }
  if (Array.isArray(value.operands)) value.operands.forEach((operand, index) => ruleMetricsCheck(operand, metrics, context, [...path, 'operands', index]))
}

export const trackerDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
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
  metrics: z.array(metricSchema),
  qualificationRule: ruleSchema.optional(),
  customFields: z.array(customFieldSchema),
  milestones: z.array(z.object({ id, title: z.string().trim().min(1), description: z.string(), metricId: id.optional(), targetValue: z.number().finite().optional(), dueDate: calendarDate.optional(), position: z.number().int().nonnegative() })),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
}).superRefine((tracker, context) => {
  if (tracker.startDate && tracker.deadline && tracker.deadline < tracker.startDate) context.addIssue({ code: 'custom', path: ['deadline'], message: 'Deadline cannot precede start date.' })
  const metrics = new Map(tracker.metrics.map((metric) => [metric.id, metric]))
  if (metrics.size !== tracker.metrics.length) context.addIssue({ code: 'custom', path: ['metrics'], message: 'Metric IDs must be unique.' })
  const customIds = tracker.customFields.map((field) => field.id)
  if (!unique(customIds)) context.addIssue({ code: 'custom', path: ['customFields'], message: 'Custom field IDs must be unique.' })
  tracker.milestones.forEach((milestone, index) => {
    if (milestone.metricId && !metrics.has(milestone.metricId)) context.addIssue({ code: 'custom', path: ['milestones', index, 'metricId'], message: 'Milestone references an unknown metric.' })
  })
  if (tracker.qualificationRule) ruleMetricsCheck(tracker.qualificationRule, metrics, context, ['qualificationRule'])
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

export type TrackerDefinitionInput = z.input<typeof trackerDefinitionSchema>
export type TrackerEntryInput = z.input<typeof trackerEntrySchema>
