import { describe, expect, it } from 'vitest'
import { isActiveTracker, isArchivedTracker, isTrackerInBin, isVisibleInTrackerHistory } from './lifecycle'

describe('tracker lifecycle selectors', () => {
  it('keeps archived trackers historical without treating them as current', () => {
    const archived = { status: 'archived' as const, deletedAt: null }
    expect(isActiveTracker(archived)).toBe(false)
    expect(isArchivedTracker(archived)).toBe(true)
    expect(isVisibleInTrackerHistory(archived)).toBe(true)
    expect(isTrackerInBin(archived)).toBe(false)
  })

  it('excludes Bin and unsupported states from normal active and historical views', () => {
    const binned = { status: 'active' as const, deletedAt: '2026-10-01T00:00:00Z' }
    const paused = { status: 'paused' as const, deletedAt: null }
    expect(isActiveTracker(binned)).toBe(false)
    expect(isVisibleInTrackerHistory(binned)).toBe(false)
    expect(isTrackerInBin(binned)).toBe(true)
    expect(isActiveTracker(paused)).toBe(false)
    expect(isVisibleInTrackerHistory(paused)).toBe(false)
  })
})
