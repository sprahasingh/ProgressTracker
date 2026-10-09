import type { TrackerDefinition, TrackerEntry, TrackerMetricDefinition, TrackerRule, TrackerValue } from './types'

export type GoalMode = 'daily-recurring' | 'cumulative-deadline'
export type AchievementLevel = 'none' | 'minimum' | 'target' | 'stretch'
export type DayState = 'rest' | 'future' | 'planned' | 'completed' | 'missed' | 'overdue' | 'early-completion'

export type PlanningInput = {
  tracker: TrackerDefinition
  metricId: string
  mode: GoalMode
  startDate: string
  deadline: string
  asOfDate: string
  totalWork: number
  completedWork: number
  dailyCapacity?: number
  restDays?: number[]
  completedDates?: string[]
}

export type PlannedDay = { date: string; state: DayState; plannedWork: number; completed: boolean }
export type WorkPlan = {
  mode: GoalMode
  status: 'active' | 'completed' | 'overdue' | 'not-started'
  totalWork: number
  completedWork: number
  remainingWork: number
  dailyWorkload: number
  days: PlannedDay[]
  completionDate: string | null
  overdueByDays: number
}

export type GoalPlanDayState = 'rest' | 'holiday' | 'future' | 'pending' | 'met' | 'below-target' | 'missed' | 'skipped'
export type GoalPlanDay = { date: string; state: GoalPlanDayState; value: number | null }
export type DailyRecurringMetricPlan = {
  metricId: string
  target: number
  direction: 'increase' | 'decrease'
  days: GoalPlanDay[]
  metCount: number
  elapsedOpportunities: number
  scheduledDaysRemaining: number
  consistencyPercent: number | null
}
export type CumulativeMetricPlan = {
  metricId: string
  totalTarget: number
  actualProgress: number
  expectedProgress: number
  remainingWork: number
  requiredDailyPace: number | null
  scheduledDaysRemaining: number
  scheduledDaysTotal: number
  status: 'not-started' | 'active' | 'completed' | 'overdue' | 'no-scheduled-days'
  paceStatus: 'not-started' | 'ahead' | 'on-track' | 'behind' | 'overdue' | 'no-scheduled-days'
}

function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  for (let time = parseDate(startDate); time <= parseDate(endDate); time += DAY_MS) dates.push(dateText(time))
  return dates
}

export function latestEntriesByDate(tracker: TrackerDefinition, entries: readonly TrackerEntry[]): Map<string, TrackerEntry> {
  const latest = new Map<string, TrackerEntry>()
  for (const entry of entries) {
    if (entry.trackerId !== tracker.id) continue
    const current = latest.get(entry.date)
    if (!current || entry.updatedAt > current.updatedAt || (entry.updatedAt === current.updatedAt && entry.id > current.id)) latest.set(entry.date, entry)
  }
  return new Map([...latest].filter(([, entry]) => entry.deletedAt === null))
}

function numericMetricValue(metric: TrackerMetricDefinition, value: TrackerValue | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (metric.valueType === 'checklist' && typeof value === 'object' && value !== null) {
    return Object.values(value).filter((item) => item === true).length
  }
  return null
}

/** Calculates a per-scheduled-day target without changing check-in threshold semantics. */
export function calculateDailyRecurringMetricPlan(input: {
  tracker: TrackerDefinition
  entries: readonly TrackerEntry[]
  metricId: string
  target: number
  asOfDate: string
  startDate: string
  holidays?: ReadonlySet<string>
}): DailyRecurringMetricPlan {
  const metric = input.tracker.metrics.find((item) => item.id === input.metricId)
  if (!metric || metric.valueType === 'boolean') throw new RangeError('Daily planning requires a numeric or checklist metric.')
  if (!Number.isFinite(input.target) || input.target < 0 || input.target > Number.MAX_SAFE_INTEGER) throw new RangeError('Planning target must be a finite nonnegative number.')
  if (metric.valueType === 'checklist' && (!Number.isInteger(input.target) || input.target > (metric.checklistItems?.length ?? 0))) throw new RangeError('Daily checklist target must be a whole count within the checklist size.')
  const asOf = parseDate(input.asOfDate)
  const direction = metric.thresholds?.direction ?? 'increase'
  const tracker = { ...input.tracker, startDate: input.startDate }
  const horizon = dateText(asOf + 14 * DAY_MS)
  const endDate = tracker.status === 'active'
    ? tracker.deadline && tracker.deadline < horizon ? tracker.deadline : horizon
    : input.asOfDate
  if (endDate < input.startDate) return { metricId: metric.id, target: input.target, direction, days: [], metCount: 0, elapsedOpportunities: 0, scheduledDaysRemaining: 0, consistencyPercent: null }
  const latest = latestEntriesByDate(tracker, input.entries)
  const days = dateRange(input.startDate, endDate).map((date): GoalPlanDay => {
    if (input.holidays?.has(date)) return { date, state: 'holiday', value: null }
    if (!isTrackerScheduledOccurrence(tracker, date)) return { date, state: 'rest', value: null }
    const dateTime = parseDate(date)
    const entry = latest.get(date)
    if (dateTime > asOf) return { date, state: 'future', value: null }
    if (!entry) return { date, state: date === input.asOfDate ? 'pending' : 'missed', value: null }
    if (entry.outcome === 'skipped') return { date, state: 'skipped', value: null }
    const value = numericMetricValue(metric, entry.values[metric.id])
    if (value === null) return { date, state: 'missed', value: null }
    const met = direction === 'increase' ? value >= input.target : value <= input.target
    return { date, state: met ? 'met' : 'below-target', value }
  })
  const elapsedOpportunities = days.filter((day) => day.state !== 'rest' && day.state !== 'holiday' && day.state !== 'future' && day.state !== 'pending').length
  const scheduledDaysRemaining = days.filter((day) => day.state === 'future' || day.state === 'pending').length
  const metCount = days.filter((day) => day.state === 'met').length
  return {
    metricId: metric.id, target: input.target, direction, days, metCount, elapsedOpportunities, scheduledDaysRemaining,
    consistencyPercent: elapsedOpportunities === 0 ? null : Math.round(metCount / elapsedOpportunities * 100),
  }
}

/** Calculates one cumulative, explicitly incremental metric. Snapshots must never be passed here. */
export function calculateCumulativeMetricPlan(input: {
  tracker: TrackerDefinition
  entries: readonly TrackerEntry[]
  metricId: string
  totalTarget: number
  asOfDate: string
  startDate: string
  progressSemantics: 'incremental' | 'snapshot'
  holidays?: ReadonlySet<string>
}): CumulativeMetricPlan {
  const metric = input.tracker.metrics.find((item) => item.id === input.metricId)
  if (!metric || metric.valueType === 'boolean') throw new RangeError('Cumulative planning requires a numeric or checklist metric.')
  if (input.progressSemantics !== 'incremental') throw new RangeError('Cumulative planning can only sum explicitly incremental entries.')
  if (!Number.isFinite(input.totalTarget) || input.totalTarget < 0 || input.totalTarget > Number.MAX_SAFE_INTEGER) throw new RangeError('Cumulative target must be a finite nonnegative number.')
  if (metric.valueType === 'checklist' && !Number.isInteger(input.totalTarget)) throw new RangeError('Cumulative checklist target must be a whole item count.')
  if (!input.tracker.deadline) throw new RangeError('Cumulative planning requires a deadline.')
  const start = parseDate(input.startDate)
  const deadline = parseDate(input.tracker.deadline)
  const asOf = parseDate(input.asOfDate)
  if (deadline < start) throw new RangeError('Deadline cannot precede start date.')
  const tracker = { ...input.tracker, startDate: input.startDate }
  const latest = latestEntriesByDate(tracker, input.entries)
  const scheduledDates = dateRange(input.startDate, input.tracker.deadline).filter((date) => isTrackerScheduledOccurrence(tracker, date) && !input.holidays?.has(date))
  const progressValues: number[] = []
  for (const [date, entry] of latest) {
    const timestamp = parseDate(date)
    if (timestamp < start || timestamp > asOf || entry.outcome !== 'recorded') continue
    const value = numericMetricValue(metric, entry.values[metric.id])
    // Incremental progress on a rest date remains real progress; the schedule controls pace only.
    if (value !== null) progressValues.push(value)
  }
  const actualProgress = sumDecimalValues(progressValues)
  const scheduledDaysTotal = scheduledDates.length
  const elapsedScheduledDays = scheduledDates.filter((date) => parseDate(date) <= asOf).length
  // Today stays available until its tracker entry is submitted. Once a recorded
  // or skipped entry exists, pace and allocation suggestions use future dates only.
  const todayClosed = latest.has(input.asOfDate)
  const scheduledDaysRemaining = scheduledDates.filter((date) =>
    parseDate(date) > asOf || (parseDate(date) === asOf && !todayClosed),
  ).length
  const remainingWork = Math.max(0, input.totalTarget - actualProgress)
  const expectedProgress = scheduledDaysTotal === 0 ? 0 : input.totalTarget * elapsedScheduledDays / scheduledDaysTotal
  let status: CumulativeMetricPlan['status']
  if (asOf < start) status = 'not-started'
  else if (remainingWork === 0) status = 'completed'
  else if (scheduledDaysTotal === 0) status = 'no-scheduled-days'
  else if (asOf > deadline || scheduledDaysRemaining === 0) status = 'overdue'
  else status = 'active'
  const paceStatus: CumulativeMetricPlan['paceStatus'] = status === 'not-started' ? 'not-started'
    : status === 'completed' ? 'ahead'
      : status === 'overdue' ? 'overdue'
        : status === 'no-scheduled-days' ? 'no-scheduled-days'
          : actualProgress >= expectedProgress ? actualProgress > expectedProgress ? 'ahead' : 'on-track' : 'behind'
  return {
    metricId: metric.id, totalTarget: input.totalTarget, actualProgress, expectedProgress, remainingWork,
    requiredDailyPace: remainingWork === 0 ? 0 : scheduledDaysRemaining > 0 ? remainingWork / scheduledDaysRemaining : null,
    scheduledDaysRemaining, scheduledDaysTotal, status, paceStatus,
  }
}

/** Add the shortest decimal forms of stored numeric values before converting once to Number.
 * This avoids a 0.1 + 0.2 display/calculation artifact without rounding saved history. */
function sumDecimalValues(values: readonly number[]): number {
  if (values.length === 0) return 0
  const parsed = values.map((value) => {
    const [coefficient = '0', exponentText] = value.toString().toLowerCase().split('e')
    const exponent = Number(exponentText ?? 0)
    const negative = coefficient.startsWith('-')
    const unsigned = negative ? coefficient.slice(1) : coefficient
    const [whole = '0', fraction = ''] = unsigned.split('.')
    const digits = BigInt(`${whole}${fraction}` || '0') * (negative ? -1n : 1n)
    const scale = fraction.length - exponent
    return scale < 0 ? { integer: digits * 10n ** BigInt(-scale), scale: 0 } : { integer: digits, scale }
  })
  const scale = Math.max(...parsed.map((part) => part.scale))
  const total = parsed.reduce((sum, part) => sum + part.integer * 10n ** BigInt(scale - part.scale), 0n)
  return Number(total) / 10 ** scale
}

/** Returns whether this tracker definition's recurrence places an occurrence on a date. */
export function isTrackerScheduledOccurrence(tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'deadline' | 'createdAt'>, date: string): boolean {
  const time = parseDate(date)
  if (tracker.startDate && date < tracker.startDate) return false
  if (tracker.deadline && date > tracker.deadline) return false
  const weekday = new Date(time).getUTCDay()
  const schedule = tracker.schedule
  switch (schedule.kind) {
    case 'none': return false
    case 'every-day': return true
    case 'weekdays': return weekday > 0 && weekday < 6
    case 'selected-weekdays': return schedule.weekdays.includes(weekday)
    case 'every-n-days': {
      const anchor = tracker.startDate ?? tracker.createdAt.slice(0, 10)
      const elapsed = daysBetween(anchor, date)
      return elapsed >= 0 && elapsed % schedule.interval === 0
    }
    case 'times-per-week': {
      if (schedule.preferredWeekdays) return schedule.preferredWeekdays.includes(weekday)
      return Math.floor((weekday + 1) * schedule.count / 7) > Math.floor(weekday * schedule.count / 7)
    }
    case 'times-per-month': {
      const day = Number(date.slice(8, 10))
      const monthDays = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate()
      return Math.floor(day * schedule.count / monthDays) > Math.floor((day - 1) * schedule.count / monthDays)
    }
    case 'specific-dates': return schedule.dates.includes(date)
    case 'once': return schedule.date === date
  }
}

/** Returns whether an active tracker has a planned occurrence on this calendar date. */
export function isScheduledDate(tracker: TrackerDefinition, date: string): boolean {
  if (tracker.status !== 'active' || tracker.deletedAt !== null) return false
  return isTrackerScheduledOccurrence(tracker, date)
}

const DAY_MS = 86_400_000
const parseDate = (value: string): number => {
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new RangeError(`Invalid calendar date: ${value}`)
  return time
}
const dateText = (time: number): string => new Date(time).toISOString().slice(0, 10)
const daysBetween = (from: string, to: string): number => Math.round((parseDate(to) - parseDate(from)) / DAY_MS)
const listed = (values: readonly string[] | undefined, date: string): boolean => values?.includes(date) ?? false

export function isRestDay(tracker: TrackerDefinition, date: string, restDays: readonly number[] = []): boolean {
  const weekday = new Date(parseDate(date)).getUTCDay()
  if (restDays.includes(weekday)) return true
  const schedule = tracker.schedule
  if (schedule.kind === 'none') return true
  if (schedule.kind === 'weekdays') return weekday === 0 || weekday === 6
  if (schedule.kind === 'selected-weekdays') return !schedule.weekdays.includes(weekday)
  if (schedule.kind === 'times-per-week' && schedule.preferredWeekdays?.length) return !schedule.preferredWeekdays.includes(weekday)
  if (schedule.kind === 'specific-dates') return !schedule.dates.includes(date)
  if (schedule.kind === 'once') return schedule.date !== date
  return false
}

function eligibleDates(tracker: TrackerDefinition, startDate: string, endDate: string, restDays: readonly number[]): string[] {
  const dates: string[] = []
  for (let time = parseDate(startDate); time <= parseDate(endDate); time += DAY_MS) {
    const date = dateText(time)
    if (!isRestDay(tracker, date, restDays)) dates.push(date)
  }
  // N-day and quota schedules represent cadence, not a list of explicitly scheduled dates.
  if (tracker.schedule.kind === 'times-per-week') {
    const quota = tracker.schedule.count
    for (let weekStart = 0; weekStart < dates.length; weekStart += 7) {
      const week = dates.slice(weekStart, weekStart + 7)
      for (let i = quota; i < week.length; i++) dates[weekStart + i] = ''
    }
    return dates.filter(Boolean)
  }
  if (tracker.schedule.kind === 'times-per-month') {
    const quota = tracker.schedule.count
    return dates.filter((date) => {
      const day = Number(date.slice(8, 10))
      return day % Math.ceil(31 / quota) === 1 || day === 1
    })
  }
  if (tracker.schedule.kind === 'every-n-days') {
    const interval = tracker.schedule.interval
    const first = parseDate(startDate)
    return dates.filter((date) => Math.round((parseDate(date) - first) / DAY_MS) % interval === 0)
  }
  return dates
}

/** Distributes remaining work evenly over remaining eligible days; recompute as progress changes. */
export function createWorkPlan(input: PlanningInput): WorkPlan {
  const start = parseDate(input.startDate)
  const deadline = parseDate(input.deadline)
  const asOf = parseDate(input.asOfDate)
  if (deadline < start) throw new RangeError('Deadline cannot precede start date.')
  if (!Number.isFinite(input.totalWork) || input.totalWork < 0 || !Number.isFinite(input.completedWork) || input.completedWork < 0) throw new RangeError('Work values must be finite and nonnegative.')
  if (input.completedWork > input.totalWork) throw new RangeError('Completed work cannot exceed total work.')
  if (input.dailyCapacity !== undefined && (!Number.isFinite(input.dailyCapacity) || input.dailyCapacity <= 0)) throw new RangeError('Daily capacity must be finite and greater than zero.')
  const metric = input.tracker.metrics.find((item) => item.id === input.metricId)
  if (!metric) throw new RangeError(`Unknown metric: ${input.metricId}`)

  const remaining = input.totalWork - input.completedWork
  const calendar = eligibleDates(input.tracker, input.startDate, input.deadline, input.restDays ?? [])
  const remainingDates = calendar.filter((date) => parseDate(date) >= asOf && !listed(input.completedDates, date))
  const dailyWorkload = remainingDates.length ? Math.ceil((remaining / remainingDates.length) * 100) / 100 : 0
  const calculatedCompletionDate = remaining === 0 ? (input.completedDates?.slice().sort().at(-1) ?? input.asOfDate) :
    remainingDates.length && input.dailyCapacity ? dateText(parseDate(remainingDates[0]!) + Math.ceil(remaining / input.dailyCapacity) * DAY_MS) : null

  const allDates: string[] = []
  for (let time = start; time <= deadline; time += DAY_MS) allDates.push(dateText(time))
  const eligibleSet = new Set(calendar)
  const days = allDates.map((date): PlannedDay => {
    const time = parseDate(date)
    const completed = listed(input.completedDates, date)
    const scheduled = eligibleSet.has(date)
    let state: DayState
    if (completed && time > asOf) state = 'early-completion'
    else if (completed) state = 'completed'
    else if (!scheduled) state = 'rest'
    else if (time > asOf) state = 'planned'
    else if (time < asOf && input.mode === 'cumulative-deadline' && asOf > deadline) state = 'overdue'
    else if (time < asOf) state = 'missed'
    else state = remaining === 0 ? 'early-completion' : 'planned'
    return { date, state, plannedWork: state === 'planned' ? dailyWorkload : 0, completed }
  })

  let status: WorkPlan['status'] = asOf < start ? 'not-started' : remaining === 0 ? 'completed' : asOf > deadline || remainingDates.length === 0 ? 'overdue' : 'active'
  if (input.mode === 'daily-recurring' && asOf > deadline && remaining > 0) status = 'overdue'
  const overdueByDays = status === 'overdue' ? Math.max(0, daysBetween(input.deadline, input.asOfDate)) : 0
  return { mode: input.mode, status, totalWork: input.totalWork, completedWork: input.completedWork, remainingWork: remaining, dailyWorkload, days, completionDate: calculatedCompletionDate, overdueByDays }
}

function metricNumber(metric: TrackerMetricDefinition, value: TrackerValue | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (metric.valueType !== 'checklist') return undefined
  if (Array.isArray(value)) return value.filter((item) => item === true).length
  if (typeof value === 'object' && value !== null) return Object.values(value).filter((item) => item === true).length
  return undefined
}

export function classifyAchievement(metric: TrackerMetricDefinition, value: TrackerValue | undefined): AchievementLevel {
  if (value === undefined || value === null) return 'none'
  if (metric.valueType === 'boolean') return value === true ? 'target' : 'none'
  const progress = metricNumber(metric, value)
  if (progress === undefined) return 'none'
  const thresholds = metric.thresholds
  if (!thresholds) return progress > 0 ? 'target' : 'none'
  const meets = (threshold: number | undefined) => threshold !== undefined && (thresholds.direction === 'increase' ? progress >= threshold : progress <= threshold)
  if (meets(thresholds.stretch)) return 'stretch'
  if (meets(thresholds.target)) return 'target'
  if (meets(thresholds.minimum)) return 'minimum'
  return 'none'
}

export type RuleEvaluation = { qualified: boolean; achievedMetricIds: string[]; failedMetricIds: string[] }

export function evaluateQualificationRule(rule: TrackerRule, metrics: readonly TrackerMetricDefinition[], values: Record<string, TrackerValue>): RuleEvaluation {
  const byId = new Map(metrics.map((metric) => [metric.id, metric]))
  const achieved = new Set<string>()
  const failed = new Set<string>()
  const evaluate = (node: TrackerRule): boolean => {
    if (node.kind === 'all') return node.operands.every(evaluate)
    if (node.kind === 'any') return node.operands.some(evaluate)
    if (node.kind === 'at-least') return node.operands.filter(evaluate).length >= node.required
    if (node.kind !== 'threshold' && node.kind !== 'comparison') return false
    const metricId = node.metricId
    const metric = byId.get(metricId)
    const value = values[metricId]
    let result = false
    if (metric && node.kind === 'threshold') {
      const target = metric.thresholds?.[node.level]
      const progress = metricNumber(metric, value)
      if (progress !== undefined && target !== undefined) result = metric.thresholds?.direction === 'decrease' ? progress <= target : progress >= target
    } else if (metric && node.kind === 'comparison') {
      if (node.operator === 'equals') result = value === node.value
      else {
        const progress = metricNumber(metric, value)
        if (progress !== undefined && typeof node.value === 'number') result = node.operator === 'at-least' ? progress >= node.value : progress <= node.value
      }
    }
    ;(result ? achieved : failed).add(metricId)
    return result
  }
  const qualified = evaluate(rule)
  return { qualified, achievedMetricIds: [...achieved].sort(), failedMetricIds: [...failed].filter((id) => !achieved.has(id)).sort() }
}

export function evaluateTrackerEntry(tracker: TrackerDefinition, entry: TrackerEntry): RuleEvaluation {
  if (entry.trackerId !== tracker.id) throw new RangeError('Entry belongs to a different tracker.')
  if (entry.outcome === 'skipped') return { qualified: false, achievedMetricIds: [], failedMetricIds: tracker.metrics.map((metric) => metric.id).sort() }
  if (!tracker.qualificationRule) {
    const metric = tracker.metrics[0]
    const qualified = metric ? classifyAchievement(metric, entry.values[metric.id]) !== 'none' : false
    return metric ? { qualified, achievedMetricIds: qualified ? [metric.id] : [], failedMetricIds: qualified ? [] : [metric.id] } : { qualified: false, achievedMetricIds: [], failedMetricIds: [] }
  }
  return evaluateQualificationRule(tracker.qualificationRule, tracker.metrics, entry.values)
}
