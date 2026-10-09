import { describe, expect, it } from 'vitest'
import { categoryToTracker, dailyEntryToTrackerEntry } from './legacyAdapters'
import { trackerDefinitionSchema, trackerEntrySchema } from './schema'
import type { TrackerDefinition } from './types'

const tracker: TrackerDefinition = {
  schemaVersion: 1, id: 'project-1', name: 'Write a book', description: '', kind: 'project', status: 'active', categoryId: null,
  tags: ['creative'], icon: 'book', accent: 'green', schedule: { kind: 'times-per-week', count: 4 },
  startDate: '2026-01-01', deadline: '2026-12-31',
  metrics: [
    { id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', minimum: 2, target: 5, stretch: 10, streakQualification: 'minimum' } },
    { id: 'minutes', name: 'Writing time', valueType: 'duration', unit: 'minutes' },
  ],
  qualificationRule: { kind: 'any', operands: [
    { kind: 'threshold', metricId: 'pages', level: 'minimum' },
    { kind: 'at-least', required: 1, operands: [{ kind: 'comparison', metricId: 'minutes', operator: 'at-least', value: 20 }] },
  ] },
  customFields: [{ id: 'mood', name: 'Mood', type: 'single-select', required: false, position: 0, options: ['focused', 'tired'] }],
  milestones: [{ id: 'draft', title: 'Finish the draft', description: '', metricId: 'pages', targetValue: 100, dueDate: '2026-08-01', position: 0 }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

describe('generic tracker schemas', () => {
  it('accepts composed project trackers with multiple metrics, rules, and custom fields', () => {
    expect(trackerDefinitionSchema.safeParse(tracker).success).toBe(true)
  })

  it('rejects malformed schedules and rules that reference unknown metrics', () => {
    expect(trackerDefinitionSchema.safeParse({ ...tracker, schedule: { kind: 'selected-weekdays', weekdays: [0, 7] } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...tracker, qualificationRule: { kind: 'threshold', metricId: 'missing', level: 'minimum' } }).success).toBe(false)
  })

  it('checks increasing and decreasing threshold order', () => {
    expect(trackerDefinitionSchema.safeParse({ ...tracker, metrics: [{ id: 'x', name: 'X', valueType: 'quantity', thresholds: { direction: 'increase', minimum: 5, target: 2, streakQualification: 'minimum' } }] }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...tracker, metrics: [{ id: 'x', name: 'X', valueType: 'quantity', thresholds: { direction: 'decrease', minimum: 10, target: 5, stretch: 2, streakQualification: 'target' } }], qualificationRule: undefined, milestones: [] }).success).toBe(true)
  })

  it('requires options for select custom fields and disallows them for other fields', () => {
    expect(trackerDefinitionSchema.safeParse({ ...tracker, customFields: [{ id: 'x', name: 'x', type: 'multi-select', required: false, position: 0 }] }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...tracker, customFields: [{ id: 'x', name: 'x', type: 'text', required: false, position: 0, options: ['a'] }] }).success).toBe(false)
  })

  it('limits checklist thresholds to the available item count', () => {
    const metric = { id: 'checklist', name: 'Steps', valueType: 'checklist', checklistItems: [{ id: 'step1', label: 'Step 1', position: 0 }], thresholds: { direction: 'increase', target: 1, streakQualification: 'target' } }
    expect(trackerDefinitionSchema.safeParse({ ...tracker, metrics: [metric], qualificationRule: { kind: 'threshold', metricId: 'checklist', level: 'target' }, milestones: [] }).success).toBe(true)
    expect(trackerDefinitionSchema.safeParse({ ...tracker, metrics: [{ ...metric, thresholds: { ...metric.thresholds, target: 2 } }], qualificationRule: undefined }).success).toBe(false)
  })

  it('validates generic entry values', () => {
    expect(trackerEntrySchema.safeParse({ id: 'e1', trackerId: tracker.id, date: '2026-10-09', outcome: 'recorded', values: { pages: 5 }, note: '', createdAt: tracker.createdAt, updatedAt: tracker.updatedAt, deletedAt: null }).success).toBe(true)
  })
})

describe('legacy adapters', () => {
  const category = { id: 'routine-1', name: 'Read', icon: 'book', accent: 'green', schedule: { kind: 'every-day' as const }, position: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', archivedAt: null, deletedAt: null }
  const common = { id: 'entry-1', categoryId: category.id, date: '2026-01-02' as const, note: 'Ten pages', createdAt: category.createdAt, updatedAt: category.updatedAt, deletedAt: null }

  it('maps legacy category metadata while retaining its stable identity', () => {
    const result = categoryToTracker(category)
    expect(result.id).toBe(category.id)
    expect(result.schedule).toEqual(category.schedule)
    expect(result.metrics[0]?.id).toBe(category.id)
  })

  it('preserves completed and skipped entry IDs, date, note, and tombstone', () => {
    expect(dailyEntryToTrackerEntry({ ...common, status: 'completed' })).toMatchObject({ id: common.id, trackerId: category.id, date: common.date, outcome: 'recorded', values: { [category.id]: true }, note: common.note })
    expect(dailyEntryToTrackerEntry({ ...common, status: 'skipped', deletedAt: category.updatedAt })).toMatchObject({ id: common.id, outcome: 'skipped', values: {}, deletedAt: category.updatedAt })
  })
})
