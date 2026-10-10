import { assertCalendarDate, calendarDateInTimeZone } from '../../db/calendarDate'
import type { CalendarDate } from '../../db/models'

export function localCalendarDate(date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): CalendarDate {
  return calendarDateInTimeZone(date, timeZone)
}

export function shiftCalendarDate(value: CalendarDate, days: number): CalendarDate {
  assertCalendarDate(value)
  const time = Date.parse(`${value}T00:00:00.000Z`) + days * 86_400_000
  const shifted = new Date(time).toISOString().slice(0, 10)
  assertCalendarDate(shifted)
  return shifted
}

export function calendarDateLabel(value: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' })
}
