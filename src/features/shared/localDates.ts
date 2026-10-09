import { assertCalendarDate } from '../../db/calendarDate'
import type { CalendarDate } from '../../db/models'

export function localCalendarDate(date = new Date()): CalendarDate {
  const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  assertCalendarDate(value)
  return value
}

export function shiftCalendarDate(value: CalendarDate, days: number): CalendarDate {
  assertCalendarDate(value)
  const time = Date.parse(`${value}T00:00:00.000Z`) + days * 86_400_000
  const shifted = new Date(time).toISOString().slice(0, 10)
  assertCalendarDate(shifted)
  return shifted
}

export function calendarDateLabel(value: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, options)
}
