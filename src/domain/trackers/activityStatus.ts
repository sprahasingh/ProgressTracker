import type { TrackerDefinition, TrackerEntry } from './types'
import { evaluateTrackerEntry, isTrackerScheduledOccurrence } from './planning'

export type ActivityStatus = 'completed' | 'partial' | 'missed' | 'holiday' | 'future' | 'unscheduled'

/** Shared date status used by calendars and summaries. Recorded entries are never altered. */
export function getTrackerActivityStatus(input: {
  tracker: TrackerDefinition
  entry?: TrackerEntry
  date: string
  today: string
  holidays?: ReadonlySet<string>
}): ActivityStatus {
  const { tracker, entry, date, today } = input
  if (input.holidays?.has(date)) return 'holiday'
  if (!isTrackerScheduledOccurrence(tracker, date)) return 'unscheduled'
  if (date > today) return 'future'
  if (entry?.deletedAt !== null && entry) return date < today ? 'missed' : 'future'
  if (entry?.outcome === 'recorded') {
    if (evaluateTrackerEntry(tracker, entry).qualified) return 'completed'
    const hasRecordedValue = Object.values(entry.values).some((value) => value !== null && value !== undefined)
    return hasRecordedValue ? 'partial' : date < today ? 'missed' : 'future'
  }
  return date < today ? 'missed' : 'future'
}
