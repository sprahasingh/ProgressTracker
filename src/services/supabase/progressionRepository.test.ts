import { describe, expect, it } from 'vitest'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calculateConsistencySummary } from './progressionRepository'

const tracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'consistency-tracker', name: 'Daily reading', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: '2026-09-01',
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }], qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
  customFields: [], milestones: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

function entry(id: string, date: string, outcome: StoredTrackerEntry['outcome'] = 'recorded'): StoredTrackerEntry {
  return { id, trackerId: tracker.id, date, outcome, values: { done: false }, note: '', createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, deletedAt: null }
}

describe('progression data contract calculations', () => {
  it('averages recorded eligible activity across the latest 30 closed days and excludes skips, today, and future dates', () => {
    const entries = Array.from({ length: 30 }, (_, index) => {
      const time = Date.parse('2026-09-13T00:00:00.000Z') + index * 86_400_000
      const date = new Date(time).toISOString().slice(0, 10)
      return entry(`saved-${index}`, date, index === 29 ? 'skipped' : 'recorded')
    })
    entries.push(entry('today', '2026-10-13'), entry('future', '2026-10-14'))
    const result = calculateConsistencySummary({ trackers: [tracker], entries, today: '2026-10-13', timeZone: 'UTC' })
    expect(result.eligibleDays).toBe(30)
    expect(result.score).toBe(97)
    expect(result.dailyAdherence[0]?.date).toBe('2026-10-12')
    expect(result.dailyAdherence.at(-1)?.date).toBe('2026-09-13')
  })

  it('returns an empty score when history is before the latest tracker definition change', () => {
    const recentlyEdited = { ...tracker, updatedAt: '2026-10-13T08:00:00.000Z' }
    const result = calculateConsistencySummary({ trackers: [recentlyEdited], entries: [entry('yesterday', '2026-10-12')], today: '2026-10-13', timeZone: 'UTC' })
    expect(result).toEqual({ score: null, eligibleDays: 0, dailyAdherence: [] })
  })

  it('returns an empty score when no active tracker is eligible', () => {
    const result = calculateConsistencySummary({ trackers: [{ ...tracker, status: 'archived' }], entries: [], today: '2026-10-13' })
    expect(result.score).toBeNull()
    expect(result.eligibleDays).toBe(0)
  })
})
