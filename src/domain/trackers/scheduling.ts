import type { TrackerDefinition, TrackerSchedule, TrackerScheduling, TrackerSchedulingMode } from './types'
import { isTrackerScheduledOccurrence, trackerActiveStartDate } from './planning'
import { trackerRuleVersionForDate } from './ruleVersions'

const DAY_MS = 86_400_000
const MAX_SEARCH_DAYS = 366_000
const parse = (value: string) => {
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new RangeError(`Invalid calendar date: ${value}`)
  return time
}
const text = (time: number) => new Date(time).toISOString().slice(0, 10)

type EffectiveSchedulingTracker = Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning' | 'scheduling' | 'deadline' | 'ruleVersions'>

function trackerForEffectiveDate(tracker: EffectiveSchedulingTracker, date: string): EffectiveSchedulingTracker {
  const version = trackerRuleVersionForDate(tracker, date)
  if (!version) return tracker
  return {
    ...tracker,
    ...version.evaluation,
    startDate: version.evaluation.startDate ?? undefined,
    deadline: version.evaluation.deadline ?? undefined,
    scheduling: version.evaluation.scheduling ?? undefined,
  }
}

type FiniteEffectiveDateSearch = {
  tracker: EffectiveSchedulingTracker
  startDate: string
  maxSearchDays?: number
  holidays?: ReadonlySet<string>
  timeZone?: string
}

/** Returns all eligible dates when every applicable rule version has a finite planned recurrence. */
export function finiteEffectiveDatesWithinSearch(input: FiniteEffectiveDateSearch): string[] | null {
  const limit = Math.min(input.maxSearchDays ?? MAX_SEARCH_DAYS, MAX_SEARCH_DAYS)
  const start = parse(input.startDate)
  const lastDate = text(start + (limit - 1) * DAY_MS)
  const transitions = [...new Set([
    input.startDate,
    ...(input.tracker.ruleVersions ?? [])
      .map((version) => version.effectiveFrom)
      .filter((date) => date > input.startDate && date <= lastDate),
  ])].sort()
  const eligibleDates: string[] = []

  for (let index = 0; index < transitions.length; index += 1) {
    const segmentStart = transitions[index]!
    const segmentEnd = transitions[index + 1] ? text(parse(transitions[index + 1]!) - DAY_MS) : lastDate
    const evaluation = trackerForEffectiveDate(input.tracker, segmentStart)
    const scheduling = evaluation.scheduling
    if (scheduling?.mode !== 'effective' || scheduling.effectiveDayCounting !== 'planned-activity-days') return null

    let dates: readonly string[]
    if (evaluation.schedule.kind === 'once') dates = [evaluation.schedule.date]
    else if (evaluation.schedule.kind === 'specific-dates') dates = evaluation.schedule.dates
    else return null

    for (const date of dates) {
      if (date < segmentStart || date > segmentEnd || date < input.startDate || date > lastDate) continue
      try { parse(date) } catch { continue }
      if (isEffectiveDateEligible(input.tracker, date, input.holidays, input.timeZone)) eligibleDates.push(date)
    }
  }

  return [...new Set(eligibleDates)].sort()
}

/** Legacy records retain their old behavior: a saved deadline is calendar-bound, otherwise ongoing. */
export function trackerScheduling(tracker: Pick<TrackerDefinition, 'scheduling' | 'deadline'>): TrackerScheduling {
  return tracker.scheduling ?? { mode: tracker.deadline ? 'calendar' : 'ongoing' }
}

export function schedulingMode(tracker: Pick<TrackerDefinition, 'scheduling' | 'deadline'>): TrackerSchedulingMode {
  return trackerScheduling(tracker).mode
}

/** Stable weekday labels for recurrence summaries; schedule math keeps JS Sunday=0 values. */
export function trackerScheduleLabel(schedule: TrackerSchedule): string {
  switch (schedule.kind) {
    case 'none': return 'No Recurrence'
    case 'every-day': return 'Daily'
    case 'weekdays': return 'Weekdays'
    case 'selected-weekdays': {
      if (schedule.weekdays.length === 2 && schedule.weekdays.includes(0) && schedule.weekdays.includes(6)) return 'Weekends'
      const names: Array<[number, string]> = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]
      return `Custom Days · ${names.filter(([day]) => schedule.weekdays.includes(day)).map(([, name]) => name).join(', ')}`
    }
    case 'times-per-week':
      if (schedule.count === 2 && schedule.preferredWeekdays?.length === 2 && schedule.preferredWeekdays.includes(0) && schedule.preferredWeekdays.includes(6)) return 'Weekends'
      return `${schedule.count} times a week`
    case 'times-per-month': return `${schedule.count} times a month`
    case 'every-n-days': return `Every ${schedule.interval} days`
    case 'specific-dates': return `${schedule.dates.length} selected dates`
    case 'once': return 'Once'
  }
}

export function isEffectiveDateEligible(
  tracker: EffectiveSchedulingTracker,
  date: string,
  holidays: ReadonlySet<string> = new Set(),
  timeZone?: string,
): boolean {
  const evaluation = trackerForEffectiveDate(tracker, date)
  if (date < trackerActiveStartDate(evaluation, timeZone) || holidays.has(date)) return false
  const method = evaluation.scheduling?.effectiveDayCounting ?? 'all-non-holiday-days'
  if (method === 'planned-activity-days' && evaluation.schedule.kind !== 'none') {
    // An effective schedule's saved deadline is only a cached boundary. Applying
    // it while finding a new holiday-adjusted deadline can make the target
    // unreachable forever after one excluded day.
    return isTrackerScheduledOccurrence({ ...evaluation, deadline: undefined }, date, timeZone, { ignoreDeadline: true })
  }
  return true
}

/** Finds the Nth eligible calendar date with a strict bound to reject impossible schedules. */
export function nthEffectiveDate(input: {
  tracker: EffectiveSchedulingTracker
  startDate: string
  effectiveDays: number
  holidays?: ReadonlySet<string>
  timeZone?: string
  maxSearchDays?: number
}): string {
  if (!Number.isInteger(input.effectiveDays) || input.effectiveDays < 1) throw new RangeError('Effective days must be a positive whole number.')
  const limit = Math.min(input.maxSearchDays ?? MAX_SEARCH_DAYS, MAX_SEARCH_DAYS)
  const tracker = { ...input.tracker, startDate: input.startDate }
  const finiteDates = finiteEffectiveDatesWithinSearch({ ...input, tracker })
  if (finiteDates) {
    if (finiteDates.length >= input.effectiveDays) return finiteDates[input.effectiveDays - 1]!
    throw new RangeError(`Could not find ${input.effectiveDays} eligible days within ${limit} calendar days. Change the recurrence or target.`)
  }
  let eligible = 0
  const start = parse(input.startDate)
  for (let offset = 0; offset < limit; offset += 1) {
    const date = text(start + offset * DAY_MS)
    if (isEffectiveDateEligible(tracker, date, input.holidays, input.timeZone)) {
      eligible += 1
      if (eligible === input.effectiveDays) return date
    }
  }
  throw new RangeError(`Could not find ${input.effectiveDays} eligible days within ${limit} calendar days. Change the recurrence or target.`)
}

export function effectiveDayNumber(input: {
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning' | 'scheduling' | 'deadline'>
  date: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): number | null {
  parse(input.date)
  const start = trackerActiveStartDate(input.tracker, input.timeZone)
  if (input.date < start || !isEffectiveDateEligible(input.tracker, input.date, input.holidays, input.timeZone)) return null
  return effectiveDaysElapsed(input)
}

export function effectiveDaysElapsed(input: {
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning' | 'scheduling' | 'deadline'>
  date: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): number {
  const dateNumber = parse(input.date)
  const start = trackerActiveStartDate(input.tracker, input.timeZone)
  if (input.date < start) return 0
  const tracker = { ...input.tracker, startDate: start }
  let count = 0
  const target = input.tracker.scheduling?.mode === 'effective' ? input.tracker.scheduling.effectiveDays ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
  for (let time = parse(start); time <= dateNumber; time += DAY_MS) {
    if (isEffectiveDateEligible(tracker, text(time), input.holidays, input.timeZone)) {
      count += 1
      if (count >= target) return target
    }
  }
  return count
}

export function effectiveDaysRemaining(input: {
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning' | 'scheduling' | 'deadline'>
  date: string
  targetEffectiveDays: number
  holidays?: ReadonlySet<string>
  timeZone?: string
}): number {
  const elapsed = effectiveDaysElapsed(input)
  return Math.max(0, input.targetEffectiveDays - elapsed)
}

export function nextEligibleDate(input: {
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning' | 'scheduling' | 'deadline'>
  afterDate: string
  holidays?: ReadonlySet<string>
  timeZone?: string
  maxSearchDays?: number
}): string | null {
  const start = parse(input.afterDate) + DAY_MS
  const tracker = { ...input.tracker, startDate: trackerActiveStartDate(input.tracker, input.timeZone) }
  for (let offset = 0; offset < Math.min(input.maxSearchDays ?? MAX_SEARCH_DAYS, MAX_SEARCH_DAYS); offset += 1) {
    const date = text(start + offset * DAY_MS)
    if (isEffectiveDateEligible(tracker, date, input.holidays, input.timeZone)) return date
  }
  return null
}

/** Derived deadlines are cached only in the legacy deadline field for existing planners. */
export function deriveSchedulingDeadline(input: {
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning' | 'deadline' | 'scheduling'>
  holidays?: ReadonlySet<string>
  timeZone?: string
}): string | undefined {
  const scheduling = trackerScheduling(input.tracker)
  if (scheduling.mode === 'ongoing') return undefined
  if (scheduling.mode === 'calendar') return input.tracker.deadline
  return nthEffectiveDate({
    tracker: input.tracker,
    startDate: trackerActiveStartDate(input.tracker, input.timeZone ?? scheduling.planningTimeZone),
    effectiveDays: scheduling.effectiveDays!,
    holidays: input.holidays,
    timeZone: input.timeZone ?? scheduling.planningTimeZone,
  })
}

export function calendarDayNumber(startDate: string, deadline: string, date: string): number {
  const start = parse(startDate); const end = parse(deadline); const current = parse(date)
  if (end < start || current < start) return 0
  return Math.min(Math.round((end - start) / DAY_MS) + 1, Math.round((current - start) / DAY_MS) + 1)
}

export function inclusiveCalendarDays(startDate: string, deadline: string): number {
  const start = parse(startDate); const end = parse(deadline)
  return end < start ? 0 : Math.round((end - start) / DAY_MS) + 1
}


/** Counts recurrence-matching non-holiday workdays in a date-only window. */
export function countScheduledActivityDays(input: {
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning' | 'deadline'>
  startDate: string
  endDate: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): number {
  if (input.endDate < input.startDate) return 0
  let count = 0
  const start = parse(input.startDate)
  const end = parse(input.endDate)
  const tracker = { ...input.tracker, startDate: input.startDate }
  for (let time = start; time <= end; time += DAY_MS) {
    const date = text(time)
    if (!input.holidays?.has(date) && isTrackerScheduledOccurrence(tracker, date, input.timeZone)) count += 1
  }
  return count
}
