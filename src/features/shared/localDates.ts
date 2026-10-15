import { useEffect, useState } from 'react'
import { assertCalendarDate, calendarDateInTimeZone } from '../../db/calendarDate'
import type { CalendarDate } from '../../db/models'

export function localCalendarDate(date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): CalendarDate {
  return calendarDateInTimeZone(date, timeZone)
}

/** Keeps date driven screens current when an open tab crosses midnight in the workspace zone. */
export function useWorkspaceCalendarDate(timeZone: string): CalendarDate {
  const [today, setToday] = useState(() => localCalendarDate(new Date(), timeZone))
  useEffect(() => {
    const update = () => setToday((current) => {
      const next = localCalendarDate(new Date(), timeZone)
      return current === next ? current : next
    })
    update()
    const timer = window.setInterval(update, 30_000)
    return () => window.clearInterval(timer)
  }, [timeZone])
  return today
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
