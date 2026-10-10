import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry } from './types'
import { calculateActivityHeatmap } from './activityHeatmap'
import { calculateTrackerAnalytics } from './analytics'
import { getTrackerActivityStatus } from './activityStatus'
import { isTrackerInActivePeriod } from './planning'
import { calculateStreak } from './progression'

const tracker: TrackerDefinition = {
  schemaVersion: 1, id: 'local-created', name: 'Local created', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' },
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
  qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
  customFields: [], milestones: [], createdAt: '2026-10-01T18:30:00.000Z', updatedAt: '2026-10-01T18:30:00.000Z', archivedAt: null, deletedAt: null,
}

const entry: TrackerEntry = {
  id: 'local-day-entry', trackerId: tracker.id, date: '2026-10-02', outcome: 'recorded', values: { done: true }, note: '',
  createdAt: '2026-10-02T03:00:00.000Z', updatedAt: '2026-10-02T03:00:00.000Z', deletedAt: null,
}

describe('workspace-local tracker active periods', () => {
  it('keeps calendar status, analytics, heatmap, and streak boundaries aligned', () => {
    const timeZone = 'Asia/Kolkata'
    expect(isTrackerInActivePeriod(tracker, '2026-10-01', timeZone)).toBe(false)
    expect(isTrackerInActivePeriod(tracker, '2026-10-02', timeZone)).toBe(true)
    expect(getTrackerActivityStatus({ tracker, date: '2026-10-01', today: '2026-10-02', timeZone })).toBe('unscheduled')
    expect(getTrackerActivityStatus({ tracker, entry, date: '2026-10-02', today: '2026-10-02', timeZone })).toBe('completed')
    expect(calculateTrackerAnalytics(tracker, [entry], '2026-10-01', '2026-10-02', new Set(), timeZone).scheduledCount).toBe(1)
    const heatmap = calculateActivityHeatmap({ trackers: [tracker], entries: [entry], startDate: '2026-10-01', endDate: '2026-10-02', timeZone })
    expect(heatmap.map(({ eligibleCount, qualifiedCount }) => ({ eligibleCount, qualifiedCount }))).toEqual([
      { eligibleCount: 0, qualifiedCount: 0 }, { eligibleCount: 1, qualifiedCount: 1 },
    ])
    expect(calculateStreak(tracker, [entry], '2026-10-02', new Set(), timeZone)).toMatchObject({ scheduledCount: 1, qualifyingCount: 1, current: 1 })
  })
})
