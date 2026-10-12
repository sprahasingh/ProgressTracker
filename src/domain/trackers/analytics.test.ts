import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry } from './types'
import { calculateTrackerAnalytics } from './analytics'

const tracker: TrackerDefinition = {
  schemaVersion: 1, id: 'analytics-goal', name: 'Run and read', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'selected-weekdays', weekdays: [1, 2, 3, 4, 5] },
  metrics: [
    { id: 'distance', name: 'Distance', valueType: 'quantity', unit: 'km', thresholds: { direction: 'increase', target: 5, streakQualification: 'target' } },
    { id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', target: 20, streakQualification: 'target' } },
  ], qualificationRule: { kind: 'all', operands: [
    { kind: 'threshold', metricId: 'distance', level: 'target' }, { kind: 'threshold', metricId: 'pages', level: 'target' },
  ] }, customFields: [], milestones: [], createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

function entry(date: string, values: TrackerEntry['values'], updatedAt = `${date}T10:00:00.000Z`, overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return { id: `entry-${date}-${updatedAt}`, trackerId: tracker.id, date, outcome: 'recorded', values, note: '', createdAt: `${date}T09:00:00.000Z`, updatedAt, deletedAt: null, ...overrides }
}

describe('tracker analytics', () => {
  it('keeps unlike metric units independent and counts only scheduled opportunities', () => {
    const result = calculateTrackerAnalytics(tracker, [
      entry('2026-10-05', { distance: 5, pages: 20 }),
      entry('2026-10-06', { distance: 3, pages: 30 }),
      entry('2026-10-07', {}, undefined, { outcome: 'skipped' }),
    ], '2026-10-05', '2026-10-09')

    expect(result).toMatchObject({ entryCount: 3, recordedCount: 2, skippedCount: 1, qualifiedCount: 1, scheduledCount: 4, scheduledQualifiedCount: 1, consistencyPercent: 25 })
    expect(result.metrics.map(({ metric, averageValue }) => [metric.unit, averageValue])).toEqual([['km', 4], ['pages', 25]])
    expect(result.metrics[0]?.observations.map((item) => item.value)).toEqual([5, 3])
    const loggedToday = calculateTrackerAnalytics(tracker, [entry('2026-10-09', { distance: 1, pages: 2 })], '2026-10-09', '2026-10-09')
    expect(loggedToday).toMatchObject({ scheduledCount: 1, scheduledQualifiedCount: 0, consistencyPercent: 0 })
  })

  it('uses the latest date revision and excludes tombstones from check-ins and metric trends', () => {
    const result = calculateTrackerAnalytics(tracker, [
      entry('2026-10-05', { distance: 100, pages: 100 }),
      entry('2026-10-05', { distance: 2, pages: 10 }, '2026-10-05T11:00:00.000Z'),
      entry('2026-10-06', { distance: 9, pages: 90 }, '2026-10-06T10:00:00.000Z', { deletedAt: '2026-10-06T12:00:00.000Z' }),
    ], '2026-10-05', '2026-10-06')

    expect(result.entryCount).toBe(1)
    expect(result.metrics.map((metric) => metric.latestValue)).toEqual([2, 10])
  })

  it('continues reporting retired measures with their original labels and historical values', () => {
    const retiredTracker = {
      ...tracker,
      metrics: tracker.metrics.map((metric, index) => index === 0 ? { ...metric, retiredAt: '2026-10-08T00:00:00.000Z' } : metric),
    }
    const result = calculateTrackerAnalytics(retiredTracker, [entry('2026-10-05', { distance: 5, pages: 20 })], '2026-10-05', '2026-10-09')
    expect(result.metrics[0]).toMatchObject({ metric: { id: 'distance', name: 'Distance', unit: 'km', retiredAt: expect.any(String) }, latestValue: 5 })
    expect(result.metrics[0]?.observations).toEqual([{ date: '2026-10-05', value: 5 }])
  })

  it('counts all elapsed calendar days for Strict Mode while leaving an unlogged today open', () => {
    const strict = { ...tracker, strictMode: true }
    const result = calculateTrackerAnalytics(strict, [entry('2026-10-05', { distance: 5, pages: 20 })], '2026-10-05', '2026-10-10', new Set(['2026-10-07']))
    expect(result).toMatchObject({ scheduledCount: 5, scheduledQualifiedCount: 1, consistencyPercent: 20, qualifiedCount: 1 })
    const holidayProgress = calculateTrackerAnalytics(strict, [entry('2026-10-07', { distance: 5, pages: 20 })], '2026-10-07', '2026-10-07', new Set(['2026-10-07']))
    expect(holidayProgress).toMatchObject({ scheduledCount: 1, scheduledQualifiedCount: 1, consistencyPercent: 100, qualifiedCount: 0 })
  })

  it('preserves but excludes entries outside the current tracker period from Insights totals and trends', () => {
    const bounded = { ...tracker, startDate: '2026-10-06', deadline: '2026-10-07' }
    const result = calculateTrackerAnalytics(bounded, [
      entry('2026-10-05', { distance: 100, pages: 100 }),
      entry('2026-10-06', { distance: 5, pages: 20 }),
      entry('2026-10-08', { distance: 200, pages: 200 }),
    ], '2026-10-05', '2026-10-08')

    expect(result).toMatchObject({ entryCount: 1, historicalCount: 2, recordedCount: 1, qualifiedCount: 1 })
    expect(result.metrics.map(({ observationCount, latestValue }) => [observationCount, latestValue])).toEqual([[1, 5], [1, 20]])
  })
})
