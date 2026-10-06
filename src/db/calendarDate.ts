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
