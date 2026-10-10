import type { CalendarDate } from './models'

export function assertCalendarDate(value: string): asserts value is CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid calendar date: ${value}`)

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(0)
  candidate.setUTCHours(0, 0, 0, 0)
  candidate.setUTCFullYear(year, month - 1, day)

  if (
    year < 1 ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`)
  }
}

export function assertDateRange(startDate: string, endDate: string): void {
  assertCalendarDate(startDate)
  assertCalendarDate(endDate)
  if (startDate > endDate) throw new Error('The start date must be on or before the end date.')
}

/** Calendar date for an instant in the workspace's configured IANA time zone. */
export function calendarDateInTimeZone(instant: Date | string, timeZone = 'UTC'): CalendarDate {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp.')
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  const result = `${values.year}-${values.month}-${values.day}`
  assertCalendarDate(result)
  return result as CalendarDate
}

/** Monday-based weekday index for a calendar date: Monday=0 … Sunday=6. */
export function mondayFirstWeekday(value: string): number {
  assertCalendarDate(value)
  const weekday = new Date(`${value}T00:00:00.000Z`).getUTCDay()
  return (weekday + 6) % 7
}
