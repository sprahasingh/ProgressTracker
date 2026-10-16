import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { isTrackerInActivePeriod, isTrackerScheduledOccurrence } from './planning'
import { trackerStrictModeForDate } from './ruleVersions'

export type MissingCheckIn = { date: CalendarDate; tracker: StoredTrackerDefinition }

/** Derive recent unresolved opportunities without creating synthetic entry rows. */
export function selectMissingCheckIns(input: {
  trackers: readonly StoredTrackerDefinition[]
  entries: readonly StoredTrackerEntry[]
  holidays: ReadonlySet<string>
  dates: readonly CalendarDate[]
  today: CalendarDate
  timeZone?: string
}): MissingCheckIn[] {
  const liveEntries = new Set(input.entries.filter((entry) => entry.deletedAt === null).map((entry) => `${entry.trackerId}:${entry.date}`))
  const missing: MissingCheckIn[] = []
  for (const date of input.dates) {
    if (date >= input.today) continue
    for (const tracker of input.trackers) {
      if (tracker.status !== 'active' || tracker.deletedAt !== null || !isTrackerInActivePeriod(tracker, date, input.timeZone)) continue
      if (liveEntries.has(`${tracker.id}:${date}`)) continue
      if (trackerStrictModeForDate(tracker, date)) {
        missing.push({ date, tracker })
        continue
      }
      if (!input.holidays.has(date) && isTrackerScheduledOccurrence(tracker, date, input.timeZone)) missing.push({ date, tracker })
    }
  }
  return missing.sort((a, b) => b.date.localeCompare(a.date) || a.tracker.name.localeCompare(b.tracker.name))
}
