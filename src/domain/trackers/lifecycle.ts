import type { TrackerDefinition } from './types'

/** Active trackers outside the Bin are the only trackers in current activity. */
export function isActiveTracker(tracker: Pick<TrackerDefinition, 'status' | 'deletedAt'>): boolean {
  return tracker.status === 'active' && tracker.deletedAt === null
}

/** Archived trackers remain available to history, but not current activity. */
export function isArchivedTracker(tracker: Pick<TrackerDefinition, 'status' | 'deletedAt'>): boolean {
  return tracker.status === 'archived' && tracker.deletedAt === null
}

export function isTrackerInBin(tracker: Pick<TrackerDefinition, 'deletedAt'>): boolean {
  return tracker.deletedAt !== null
}

/** Historical reports include active and archived trackers, never Bin items. */
export function isVisibleInTrackerHistory(tracker: Pick<TrackerDefinition, 'status' | 'deletedAt'>): boolean {
  return tracker.deletedAt === null && (tracker.status === 'active' || tracker.status === 'archived')
}
