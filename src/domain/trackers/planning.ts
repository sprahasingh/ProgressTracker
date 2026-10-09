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

/** Returns whether this tracker definition's recurrence places an occurrence on a date. */
export function isTrackerScheduledOccurrence(tracker: TrackerDefinition, date: string): boolean {
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
