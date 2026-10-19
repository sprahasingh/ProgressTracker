import type { ActivityStatus } from './activityStatus'

/** Combines per-tracker outcomes for the calendar's All Trackers indicator. */
export function getDailyActivityStatus(statuses: readonly ActivityStatus[], holiday = false): ActivityStatus {
  if (holiday) return 'holiday'

  const completed = statuses.filter((status) => status === 'completed').length
  const partial = statuses.includes('partial')
  const noProgress = statuses.includes('no-progress')

  // A mixed recorded day is partial: zero on one tracker cannot erase progress
  // on another, and completion means every recorded tracker qualified.
  if (statuses.includes('missed')) return 'missed'
  if (partial || (completed > 0 && noProgress)) return 'partial'

  if (statuses.includes('skipped')) return 'skipped'
  if (statuses.includes('pending')) return 'pending'
  if (statuses.includes('upcoming')) return 'upcoming'
  if (noProgress) return 'no-progress'
  if (completed > 0) return 'completed'
  if (statuses.includes('historical')) return 'historical'
  if (statuses.includes('outside-period')) return 'outside-period'
  if (statuses.includes('inactive')) return 'inactive'
  if (statuses.length === 0 || statuses.every((status) => status === 'no-trackers')) return 'no-trackers'
  return 'rest-day'
}
