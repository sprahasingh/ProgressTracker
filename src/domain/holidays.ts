import type { AccountHoliday, CalendarDate, HolidayReason } from '../db/models'

const DAY_MS = 86_400_000
const reasons: readonly HolidayReason[] = ['travel', 'exam', 'personal', 'other']

export function assertHolidayDate(date: string): asserts date is CalendarDate {
  const time = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new RangeError(`Invalid holiday date: ${date}`)
}

/** Expands date-only ranges in UTC calendar arithmetic, independent of DST. */
export function expandHolidayRange(startDate: string, endDate: string): CalendarDate[] {
  assertHolidayDate(startDate)
  assertHolidayDate(endDate)
  if (endDate < startDate) throw new RangeError('The holiday end date must be on or after its start date.')
  const dates: CalendarDate[] = []
  for (let day = Date.parse(`${startDate}T00:00:00.000Z`); day <= Date.parse(`${endDate}T00:00:00.000Z`); day += DAY_MS) dates.push(new Date(day).toISOString().slice(0, 10) as CalendarDate)
  return dates
}

export function isHolidayReason(value: unknown): value is HolidayReason {
  return reasons.includes(value as HolidayReason)
}

export function liveHolidayDates(rows: readonly AccountHoliday[]): ReadonlySet<string> {
  return new Set(rows.filter((row) => row.deletedAt === null).map((row) => row.date))
}
