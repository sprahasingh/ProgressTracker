import { describe, expect, it } from 'vitest'
import { calculateActivityHeatmap } from './activityHeatmap'
import type { TrackerDefinition, TrackerEntry } from './types'

const tracker = (id: string, strictMode = false): TrackerDefinition => ({
  schemaVersion: 1, id, name: id, description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' }, strictMode, startDate: '2026-01-05',
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
  qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
  customFields: [], milestones: [], createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z', archivedAt: null, deletedAt: null,
})
const entry = (trackerId: string, date: string, done = true): TrackerEntry => ({ id: `${trackerId}-${date}`, trackerId, date, outcome: 'recorded', values: { done }, note: '', createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, deletedAt: null })

describe('activity heatmap aggregation', () => {
  it('uses Monday-aligned date order and marks scheduled misses separately from no opportunity', () => {
    const days = calculateActivityHeatmap({ trackers: [tracker('standard')], entries: [], startDate: '2026-01-05', endDate: '2026-01-11' })
    expect(days.map((day) => day.date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'])
    expect(days[0]).toMatchObject({ eligibleCount: 1, qualifiedCount: 0, percent: 0, level: 1 })
    expect(days[5]).toMatchObject({ eligibleCount: 0, percent: null, level: 0, restCount: 1 })
  })

  it('normalizes All Trackers by each tracker’s own Standard or Strict opportunity policy', () => {
    const strict = tracker('strict', true)
    const standard = tracker('standard')
    const days = calculateActivityHeatmap({
      trackers: [strict, standard], entries: [entry('strict', '2026-01-10')], startDate: '2026-01-10', endDate: '2026-01-10', holidays: new Set(['2026-01-10']),
    })
    expect(days[0]).toMatchObject({ eligibleCount: 1, qualifiedCount: 1, percent: 100, level: 6, holiday: true, restCount: 2 })
  })

  it('uses qualification rules and gives each documented intensity range a distinct level', () => {
    const strict = tracker('strict', true)
    const counts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const levels = counts.map((count) => {
      const entries = Array.from({ length: count }, (_, index) => entry(`t${index}`, '2026-01-05'))
      const trackers = Array.from({ length: 10 }, (_, index) => tracker(`t${index}`, true))
      return calculateActivityHeatmap({ trackers, entries, startDate: '2026-01-05', endDate: '2026-01-05' })[0]!.level
    })
    expect(levels).toEqual([1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 6])
    expect(strict.strictMode).toBe(true)
  })
})
