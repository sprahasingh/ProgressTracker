import { getTrackerActivityStatus } from '../../domain/trackers/activityStatus'
import { selectMissingCheckIns } from '../../domain/trackers/missingCheckIns'
import type { TrackerDefinition } from '../../domain/trackers/types'
import type { CalendarDate, StoredTrackerEntry } from '../../db/models'
import { shiftCalendarDate } from '../shared/localDates'

export type ReminderCandidate = { date: CalendarDate; trackerIds: string[]; identity: string; kind: 'pending' | 'overdue' | 'motivation'; title: string; body: string; href: string }

export function dueLocalSlot(now: Date, timezone: string, times: readonly string[], windowMinutes = 30): string | null {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const current = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value)
  return times.find((value) => {
    const [hour, minute] = value.split(':').map(Number)
    const delta = current - (hour! * 60 + minute!)
    return delta >= 0 && delta < windowMinutes
  }) ?? null
}

export function isWithinQuietHours(now: Date, timezone: string, start: string | null | undefined, end: string | null | undefined): boolean {
  if (!start || !end) return false
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const current = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value)
  const toMinutes = (value: string) => { const [hour, minute] = value.split(':').map(Number); return hour! * 60 + minute! }
  const quietStart = toMinutes(start); const quietEnd = toMinutes(end)
  if (quietStart === quietEnd) return true
  return quietStart < quietEnd ? current >= quietStart && current < quietEnd : current >= quietStart || current < quietEnd
}

export function buildReminderCandidate(input: {
  trackers: readonly TrackerDefinition[]; entries: readonly StoredTrackerEntry[]; holidays: ReadonlySet<string>
  date: CalendarDate; today?: CalendarDate; timeZone?: string; kind: 'pending' | 'overdue'; includePartial?: boolean; slot: string
}): ReminderCandidate | null {
  const today = input.today ?? input.date
  const trackerIds = input.kind === 'overdue'
    ? [...new Set(selectMissingCheckIns({ trackers: input.trackers, entries: input.entries, holidays: input.holidays, dates: [input.date], today, timeZone: input.timeZone }).map(({ tracker }) => tracker.id))]
    : input.trackers.filter((tracker) => {
      const entry = input.entries.find((row) => row.trackerId === tracker.id && row.date === input.date)
      const activityStatus = getTrackerActivityStatus({ tracker, entry, date: input.date, today, holidays: input.holidays, timeZone: input.timeZone })
      return activityStatus === 'pending' || (input.includePartial && activityStatus === 'partial')
    }).map((tracker) => tracker.id)
  if (!trackerIds.length) return null
  const overdueTrackers = trackerIds.map((id) => input.trackers.find((tracker) => tracker.id === id)?.name ?? 'Tracker')
  const overdueDate = new Date(`${input.date}T12:00:00.000Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const title = input.kind === 'overdue' ? trackerIds.length === 1 ? 'Unrecorded check-in' : 'Unrecorded check-ins' : `${trackerIds.length} ${trackerIds.length === 1 ? 'activity is' : 'activities are'} waiting for your check-in`
  const body = input.kind === 'overdue' ? trackerIds.length === 1 ? `You haven't recorded your ${overdueTrackers[0]} check-in for ${overdueDate}.` : `No check-in was recorded for ${overdueDate}: ${overdueTrackers.join(', ')}.` : trackerIds.length === 1 ? 'Open Today to record your progress.' : 'Open Today to review your activities.'
  const params = new URLSearchParams({ date: input.date })
  return { date: input.date, trackerIds, kind: input.kind, title, body, identity: `${input.kind}-reminder:${input.date}:${input.slot}`, href: `${input.kind === 'overdue' ? '/history' : '/'}?${params}${input.kind === 'overdue' ? '#missing-checkins' : ''}` }
}

export function previousLocalDate(date: CalendarDate): CalendarDate { return shiftCalendarDate(date, -1) }
