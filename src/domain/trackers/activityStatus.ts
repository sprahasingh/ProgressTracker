import type { TrackerDefinition, TrackerEntry } from './types'
import { evaluateTrackerEntry, isTrackerInActivePeriod, isTrackerScheduledOccurrence } from './planning'

export type ActivityStatus = 'pending' | 'completed' | 'partial' | 'no-progress' | 'historical' | 'missed' | 'skipped' | 'holiday' | 'unscheduled'

/** Shared words and marks for activity status across calendars and day summaries. */
export const ACTIVITY_STATUS_PRESENTATION: Record<ActivityStatus, { label: string; colorToken: string }> = {
  pending: { label: 'Pending', colorToken: '--status-pending' },
  completed: { label: 'Completed', colorToken: '--status-completed' },
  partial: { label: 'Partially completed', colorToken: '--status-partial' },
  'no-progress': { label: 'No progress', colorToken: '--status-pending' },
  historical: { label: 'Historical · outside tracker period', colorToken: '--status-pending' },
  missed: { label: 'Missed', colorToken: '--status-missed' },
  skipped: { label: 'Skipped', colorToken: '--status-neutral' },
  holiday: { label: 'Holiday', colorToken: '--status-holiday' },
  unscheduled: { label: 'Rest day', colorToken: '--status-rest' },
}

/**
 * Precedence: Standard Mode holidays mask scheduled status; deleted entries are
 * treated as absent; a deliberately skipped opportunity is distinct from a derived miss;
 * entries outside the inclusive tracker period remain historical; valid
 * recorded entries are evaluated; inactive or unscheduled
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
  const strict = tracker.strictMode === true
  if (input.holidays?.has(date) && !strict) return 'holiday'
  if (!isTrackerInActivePeriod(tracker, date, input.timeZone)) {
    return entry && entry.deletedAt === null ? 'historical' : 'unscheduled'
  }
  if (entry && entry.deletedAt !== null) {
    if (tracker.status !== 'active' || (!strict && !isTrackerScheduledOccurrence(tracker, date, input.timeZone))) return 'unscheduled'
    return date < today ? 'missed' : 'pending'
  }
  if (entry?.outcome === 'recorded') {
    if (evaluateTrackerEntry(tracker, entry).qualified) return 'completed'
    return hasPositiveProgress(tracker, entry) ? 'partial' : 'no-progress'
  }
  const requiredOpportunity = strict || isTrackerScheduledOccurrence(tracker, date, input.timeZone)
  if (!requiredOpportunity) return 'unscheduled'
  if (entry?.outcome === 'skipped') return 'skipped'
  if (tracker.status !== 'active' || tracker.deletedAt !== null) return 'unscheduled'
  return date < today ? 'missed' : 'pending'
}

/** A saved value counts as progress only when it records a positive/affirmative action. */
function hasPositiveProgress(tracker: TrackerDefinition, entry: TrackerEntry): boolean {
  return tracker.metrics.some((metric) => {
    if (metric.retiredAt) return false
    const value = entry.values[metric.id]
    if (metric.valueType === 'boolean') return value === true
    if (metric.valueType === 'quantity' || metric.valueType === 'duration') return typeof value === 'number' && Number.isFinite(value) && value > 0
    if (metric.valueType === 'checklist') {
      if (Array.isArray(value)) return value.some((item) => item === true)
      return typeof value === 'object' && value !== null && Object.values(value).some((item) => item === true)
    }
    return false
  })
}
