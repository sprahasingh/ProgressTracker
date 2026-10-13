import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { isTrackerInActivePeriod, isTrackerScheduledOccurrence, trackerActiveStartDate } from './planning'
import { qualifiesForStreak } from './progression'
import { calendarDateInTimeZone } from '../../db/calendarDate'

export type ConsistencyDay = {
  date: CalendarDate
  completed: number
  eligible: number
  adherence: number
}

export type ConsistencyResult = {
  score: number | null
  days: ConsistencyDay[]
}

const DAY_MS = 86_400_000

function shiftDate(date: CalendarDate, days: number): CalendarDate {
  const time = Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS
  return new Date(time).toISOString().slice(0, 10) as CalendarDate
}

/**
 * Calculates adherence over the most recent 30 completed dates with eligible
 * tracker work. Each eligible date has equal weight regardless of tracker
 * count. The open current date and dates without eligible work are excluded.
 */
export function calculateConsistency(input: {
  trackers: readonly StoredTrackerDefinition[]
  entries: readonly StoredTrackerEntry[]
  holidays?: ReadonlySet<string>
  today: CalendarDate
  timeZone?: string
  windowSize?: number
}): ConsistencyResult {
  const windowSize = input.windowSize ?? 30
  if (!Number.isSafeInteger(windowSize) || windowSize < 1) throw new RangeError('Consistency window size must be a positive integer.')

  const trackers = input.trackers.filter((tracker) => (tracker.status === 'active' || tracker.status === 'archived') && tracker.deletedAt === null)
  if (trackers.length === 0) return { score: null, days: [] }

  const entryByTrackerDate = new Map<string, StoredTrackerEntry>()
  for (const entry of input.entries) {
    if (entry.deletedAt === null) entryByTrackerDate.set(`${entry.trackerId}:${entry.date}`, entry)
  }

  const earliest = trackers.reduce((date, tracker) => {
    const start = trackerActiveStartDate(tracker, input.timeZone) as CalendarDate
    return start < date ? start : date
  }, input.today)
  const days: ConsistencyDay[] = []

  for (let date = shiftDate(input.today, -1); date >= earliest && days.length < windowSize; date = shiftDate(date, -1)) {
    let eligible = 0
    let completed = 0
    for (const tracker of trackers) {
      if (tracker.status === 'archived' && tracker.archivedAt) {
        try {
          if (date >= calendarDateInTimeZone(tracker.archivedAt, input.timeZone ?? 'UTC')) continue
        } catch {
          continue
        }
      }
      if (!isTrackerInActivePeriod(tracker, date, input.timeZone)) continue
      if (tracker.strictMode !== true && (input.holidays?.has(date) || !isTrackerScheduledOccurrence(tracker, date, input.timeZone))) continue
      eligible += 1
      const entry = entryByTrackerDate.get(`${tracker.id}:${date}`)
      if (entry && qualifiesForStreak(tracker, entry)) completed += 1
    }
    if (eligible > 0) days.push({ date, completed, eligible, adherence: completed / eligible })
  }

  if (days.length === 0) return { score: null, days }
  const score = Math.round(days.reduce((total, day) => total + day.adherence, 0) / days.length * 100)
  return { score, days }
}
