import type { TrackerDefinition, TrackerScheduling, TrackerSchedulingMode } from './types'
import { isTrackerScheduledOccurrence, trackerActiveStartDate } from './planning'

const DAY_MS = 86_400_000
const MAX_SEARCH_DAYS = 366_000
const parse = (value: string) => {
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new RangeError(`Invalid calendar date: ${value}`)
  return time
}
const text = (time: number) => new Date(time).toISOString().slice(0, 10)

/** Legacy records retain their old behavior: a saved deadline is calendar-bound, otherwise ongoing. */
export function trackerScheduling(tracker: Pick<TrackerDefinition, 'scheduling' | 'deadline'>): TrackerScheduling {
  return tracker.scheduling ?? { mode: tracker.deadline ? 'calendar' : 'ongoing' }
}

export function schedulingMode(tracker: Pick<TrackerDefinition, 'scheduling' | 'deadline'>): TrackerSchedulingMode {
  return trackerScheduling(tracker).mode
}

export function isEffectiveDateEligible(
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning'>,
  date: string,
  holidays: ReadonlySet<string> = new Set(),
  timeZone?: string,
): boolean {
  parse(date)
  if (holidays.has(date)) return false
  const startDate = trackerActiveStartDate(tracker, timeZone)
  return isTrackerScheduledOccurrence({ ...tracker, startDate, deadline: undefined }, date, timeZone)
}

/** Finds the Nth eligible calendar date with a strict bound to reject impossible schedules. */
export function nthEffectiveDate(input: {
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning'>
  startDate: string
  effectiveDays: number
  holidays?: ReadonlySet<string>
  timeZone?: string
  maxSearchDays?: number
}): string {
  if (!Number.isInteger(input.effectiveDays) || input.effectiveDays < 1) throw new RangeError('Effective days must be a positive whole number.')
  const limit = Math.min(input.maxSearchDays ?? MAX_SEARCH_DAYS, MAX_SEARCH_DAYS)
  const tracker = { ...input.tracker, startDate: input.startDate }
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
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning'>
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
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning'>
  date: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): number {
  const dateNumber = parse(input.date)
  const start = trackerActiveStartDate(input.tracker, input.timeZone)
  if (input.date < start) return 0
  const tracker = { ...input.tracker, startDate: start }
  let count = 0
  for (let time = parse(start); time <= dateNumber; time += DAY_MS) {
    if (isEffectiveDateEligible(tracker, text(time), input.holidays, input.timeZone)) count += 1
  }
  return count
}

export function effectiveDaysRemaining(input: {
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning'>
  date: string
  targetEffectiveDays: number
  holidays?: ReadonlySet<string>
  timeZone?: string
}): number {
  const elapsed = effectiveDaysElapsed(input)
  return Math.max(0, input.targetEffectiveDays - elapsed)
}

export function nextEligibleDate(input: {
  tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning'>
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
