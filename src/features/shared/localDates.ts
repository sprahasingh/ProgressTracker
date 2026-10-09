import { assertCalendarDate } from '../../db/calendarDate'
import type { CalendarDate } from '../../db/models'

export function localCalendarDate(date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  const value = `${values.year}-${values.month}-${values.day}`
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
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' })
}
