import type { TrackerDefinition, TrackerEntry } from './types'
import { evaluateTrackerEntry, isTrackerInActivePeriod, isTrackerScheduledOccurrence } from './planning'
import { trackerDefinitionForDate, trackerStrictModeForDate } from './ruleVersions'

export type ActivityStatus = 'pending' | 'upcoming' | 'completed' | 'partial' | 'no-progress' | 'historical' | 'outside-period' | 'missed' | 'skipped' | 'holiday' | 'rest-day' | 'inactive' | 'no-trackers' | 'unscheduled'

/** Shared words and marks for activity status across calendars and day summaries. */
export const ACTIVITY_STATUS_PRESENTATION: Record<ActivityStatus, { label: string; colorToken: string }> = {
  pending: { label: 'Pending', colorToken: '--status-pending' },
  upcoming: { label: 'Upcoming', colorToken: '--status-upcoming' },
  completed: { label: 'Completed', colorToken: '--status-completed' },
  partial: { label: 'Partial', colorToken: '--status-partial' },
  'no-progress': { label: 'No progress', colorToken: '--status-neutral' },
  historical: { label: 'Historical entry', colorToken: '--status-neutral' },
  'outside-period': { label: 'Outside period', colorToken: '--status-outside' },
  missed: { label: 'Missed', colorToken: '--status-missed' },
  skipped: { label: 'Skipped', colorToken: '--status-neutral' },
  holiday: { label: 'Holiday', colorToken: '--status-holiday' },
  'rest-day': { label: 'Rest day', colorToken: '--status-rest' },
  /** Legacy planning presentation alias; activity selectors return rest-day. */
  unscheduled: { label: 'Rest day', colorToken: '--status-rest' },
  inactive: { label: 'Tracker inactive', colorToken: '--status-neutral' },
  'no-trackers': { label: 'No active trackers', colorToken: '--status-neutral' },
}

/**
 * Entry outcomes take precedence over schedule context so recorded and skipped
 * activity remains visible on rest days and holidays. Period context is distinct
 * from a true rest day. Missing opportunities are classified by workspace-local
 * date: today is pending, future is upcoming, and elapsed dates are missed.
 */
export function getTrackerActivityStatus(input: {
  tracker: TrackerDefinition
  entry?: TrackerEntry
  date: string
  today: string
  holidays?: ReadonlySet<string>
  trackerHolidays?: ReadonlySet<string>
  timeZone?: string
}): ActivityStatus {
  const { tracker, entry, date, today } = input
  const strict = trackerStrictModeForDate(tracker, date)
  if (!isTrackerInActivePeriod(tracker, date, input.timeZone)) {
    return entry && entry.deletedAt === null ? 'historical' : 'outside-period'
  }
  if (tracker.status === 'archived' && tracker.archivedAt && date > tracker.archivedAt.slice(0, 10)) {
    return entry && entry.deletedAt === null ? 'historical' : 'inactive'
  }
  const holiday = !strict && Boolean(input.holidays?.has(date) || input.trackerHolidays?.has(date))
  if (entry && entry.deletedAt !== null) {
    if (!strict && holiday) return 'holiday'
    if (tracker.status !== 'active') return 'inactive'
    if (!strict && !isTrackerScheduledOccurrence(tracker, date, input.timeZone)) return 'rest-day'
    return date < today ? 'missed' : date === today ? 'pending' : 'upcoming'
  }
  if (entry?.outcome === 'recorded') {
    if (holiday && entry.holidayTreatment === 'keep-holiday') return 'holiday'
    if (holiday && entry.holidayTreatment === 'count-normal') {
      if (evaluateTrackerEntry(tracker, entry).qualified) return 'completed'
      return hasPositiveProgress(tracker, entry) ? 'partial' : 'no-progress'
    }
    if (holiday && !hasPositiveProgress(tracker, entry)) return 'holiday'
    if (evaluateTrackerEntry(tracker, entry).qualified) return 'completed'
    return hasPositiveProgress(tracker, entry) ? 'partial' : 'no-progress'
  }
  if (entry?.outcome === 'skipped') return holiday && entry.holidayTreatment !== 'count-normal' ? 'holiday' : 'skipped'
  if (holiday && !strict) return 'holiday'
  if (tracker.status !== 'active' || tracker.deletedAt !== null) return 'inactive'
  const requiredOpportunity = strict || isTrackerScheduledOccurrence(tracker, date, input.timeZone)
  if (!requiredOpportunity) return 'rest-day'
  return date < today ? 'missed' : date === today ? 'pending' : 'upcoming'
}

/** A saved value counts as progress only when it records a positive/affirmative action. */
export function hasPositiveProgress(tracker: TrackerDefinition, entry: TrackerEntry): boolean {
  // The entry is classified using the same date-effective measure definitions
  // that evaluate its success rule. Current definitions may have retired the
  // measure (or added a replacement) since this entry was recorded.
  tracker = trackerDefinitionForDate(tracker, entry.date)
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
