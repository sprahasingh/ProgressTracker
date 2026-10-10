import type { TrackerDefinition, TrackerEntry } from './types'
import { evaluateTrackerEntry, isTrackerScheduledOccurrence } from './planning'

export type ActivityStatus = 'pending' | 'completed' | 'partial' | 'missed' | 'holiday' | 'unscheduled'

/** Shared words and marks for activity status across calendars and day summaries. */
export const ACTIVITY_STATUS_PRESENTATION: Record<ActivityStatus, { label: string; colorToken: string }> = {
  pending: { label: 'Pending', colorToken: '--status-pending' },
  completed: { label: 'Completed', colorToken: '--status-completed' },
  partial: { label: 'Partially completed', colorToken: '--status-partial' },
  missed: { label: 'Missed', colorToken: '--status-missed' },
  holiday: { label: 'Holiday', colorToken: '--status-holiday' },
  unscheduled: { label: 'Rest day', colorToken: '--status-rest' },
}

/**
 * Precedence: an explicit holiday masks scheduled status; deleted entries are
 * treated as absent; a deliberately skipped scheduled opportunity is missed;
 * valid recorded entries are evaluated; inactive or unscheduled
 * dates are neutral; other active opportunities are pending today/future and
 * missed in the past. Recorded history remains visible if its tracker is now
 * paused or archived.
 */
export function getTrackerActivityStatus(input: {
  tracker: TrackerDefinition
  entry?: TrackerEntry
  date: string
  today: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): ActivityStatus {
  const { tracker, entry, date, today } = input
  if (input.holidays?.has(date)) return 'holiday'
  if (entry && entry.deletedAt !== null) {
    if (tracker.status !== 'active' || !isTrackerScheduledOccurrence(tracker, date, input.timeZone)) return 'unscheduled'
    return date < today ? 'missed' : 'pending'
  }
  if (entry?.outcome === 'recorded') {
    if (evaluateTrackerEntry(tracker, entry).qualified) return 'completed'
    return date === today ? 'pending' : 'partial'
  }
  if (!isTrackerScheduledOccurrence(tracker, date, input.timeZone)) return 'unscheduled'
  if (entry?.outcome === 'skipped') return date > today ? 'pending' : 'missed'
  if (tracker.status !== 'active' || tracker.deletedAt !== null) return 'unscheduled'
  return date < today ? 'missed' : 'pending'
}
