import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry } from './types'
import { trackerEntryMetricLabels } from './entryPresentation'

const date = '2026-10-18'

function makeTracker(metrics: TrackerDefinition['metrics'], snapshotMetrics = metrics): TrackerDefinition {
  return {
    schemaVersion: 10, id: 'presentation-tracker', name: 'Routine', description: '', kind: 'habit', status: 'active', categoryId: null,
    tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics, qualificationRule: undefined, customFields: [], milestones: [],
    createdAt: `${date}T00:00:00.000Z`, updatedAt: `${date}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    ruleVersions: [{ id: 'version-1', effectiveFrom: '2026-01-01', revision: 1, application: 'baseline', recordedAt: `${date}T00:00:00.000Z`, evaluation: { schedule: { kind: 'every-day' }, metrics: snapshotMetrics } }],
  }
}

function makeEntry(values: TrackerEntry['values']): TrackerEntry {
  return { id: 'entry-1', trackerId: 'presentation-tracker', date, outcome: 'recorded', values, note: '', createdAt: `${date}T09:00:00.000Z`, updatedAt: `${date}T09:00:00.000Z`, deletedAt: null }
}

describe('tracker entry metric presentation', () => {
  it('labels recorded Boolean values with their saved names and omits missing values', () => {
    const tracker = makeTracker([
      { id: 'primary', name: 'Completed', valueType: 'boolean' },
      { id: 'secondary', name: 'Workout', valueType: 'boolean' },
    ])
    expect(trackerEntryMetricLabels(tracker, makeEntry({ primary: true, secondary: false }))).toEqual(['Completed: Done', 'Workout: Not Done'])
    expect(trackerEntryMetricLabels(tracker, makeEntry({}))).toEqual([])
  })

  it.each([
    [{ a: false, b: false, c: false, d: false }, 'Items: 0 of 4 checked'],
    [{ a: true, b: false, c: true, d: false }, 'Items: 2 of 4 checked'],
    [{ a: true, b: true, c: true, d: true }, 'Items: 4 of 4 checked'],
  ])('shows checklist progress with a snapshot-backed total', (value, expected) => {
    const items = ['a', 'b', 'c', 'd'].map((id, position) => ({ id, label: id, position }))
    const tracker = makeTracker([{ id: 'steps', name: 'Items', valueType: 'checklist', checklistItems: items }])
    expect(trackerEntryMetricLabels(tracker, makeEntry({ steps: value }))).toEqual([expected])
  })

  it('uses the date-effective checklist definition and omits totals when no snapshot proves them', () => {
    const oldMetric = { id: 'steps', name: 'Old steps', valueType: 'checklist' as const, checklistItems: [{ id: 'a', label: 'A', position: 0 }, { id: 'b', label: 'B', position: 1 }] }
    const currentMetric = { ...oldMetric, name: 'Current steps', checklistItems: [...oldMetric.checklistItems, { id: 'c', label: 'C', position: 2 }, { id: 'd', label: 'D', position: 3 }] }
    const entry = makeEntry({ steps: { a: true, b: false } })
    expect(trackerEntryMetricLabels(makeTracker([currentMetric], [oldMetric]), entry)).toEqual(['Old steps: 1 of 2 checked'])
    expect(trackerEntryMetricLabels({ ...makeTracker([currentMetric]), ruleVersions: undefined }, entry)).toEqual(['Current steps: 1 done'])
  })
})
