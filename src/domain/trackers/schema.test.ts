import { describe, expect, it } from 'vitest'
import { categoryToTracker, dailyEntryToTrackerEntry } from './legacyAdapters'
import { trackerDefinitionSchema, trackerEntrySchema, validateTrackerEntryValues } from './schema'
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

  it('keeps older definitions valid and round-trips the optional Strict Mode field without a schema bump', () => {
    expect(trackerDefinitionSchema.parse(tracker).strictMode).toBeUndefined()
    expect(trackerDefinitionSchema.parse({ ...tracker, strictMode: true })).toMatchObject({ schemaVersion: 1, strictMode: true })
    expect(trackerDefinitionSchema.safeParse({ ...tracker, strictMode: 'strict' }).success).toBe(false)
  })

  it('keeps version 1 definitions valid and accepts version 2 plans without changing thresholds', () => {
    const planned: TrackerDefinition = {
      ...tracker, schemaVersion: 2, kind: 'goal', goalPlanning: {
        mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: { pages: 2 }, cumulativeTargets: { pages: 100 },
      },
    }
    expect(trackerDefinitionSchema.parse(tracker).schemaVersion).toBe(1)
    const parsed = trackerDefinitionSchema.parse(planned)
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.metrics[0]?.thresholds).toMatchObject({ minimum: 2, target: 5, stretch: 10 })
    expect(parsed.goalPlanning).toMatchObject({ mode: 'cumulative-deadline', dailyTargets: { pages: 2 }, cumulativeTargets: { pages: 100 } })
  })

  it('accepts v3 persistent per-date allocations while preserving legacy versions', () => {
    const v3: TrackerDefinition = {
      ...tracker, schemaVersion: 3, kind: 'goal', schedule: { kind: 'weekdays' },
      goalPlanning: {
        mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' },
        dailyTargets: { pages: 2 }, cumulativeTargets: { pages: 100 }, planningTimeZone: 'Asia/Kolkata',
        allocations: { pages: { '2026-01-05': 4, '2026-01-06': 6 } },
      },
    }
    expect(trackerDefinitionSchema.parse(tracker).schemaVersion).toBe(1)
    expect(trackerDefinitionSchema.parse({ ...v3, schemaVersion: 2, goalPlanning: { ...v3.goalPlanning, planningTimeZone: undefined, allocations: undefined } }).schemaVersion).toBe(2)
    expect(trackerDefinitionSchema.parse(v3)).toMatchObject({ schemaVersion: 3, goalPlanning: { planningTimeZone: 'Asia/Kolkata', allocations: { pages: { '2026-01-05': 4 } } } })
  })

  it('rejects invalid v3 dates, time zones, metric types, amounts, and ineligible schedule days', () => {
    const v3 = {
      ...tracker, schemaVersion: 3 as const, kind: 'goal' as const, schedule: { kind: 'weekdays' as const },
      goalPlanning: {
        mode: 'cumulative-deadline' as const, progressSemantics: { pages: 'incremental' as const }, dailyTargets: {}, cumulativeTargets: { pages: 100 },
        planningTimeZone: 'Asia/Kolkata', allocations: { pages: { '2026-01-05': 4 } },
      },
    }
    expect(trackerDefinitionSchema.safeParse({ ...v3, goalPlanning: { ...v3.goalPlanning, planningTimeZone: 'Mars/Olympus' } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...v3, goalPlanning: { ...v3.goalPlanning, allocations: { pages: { '2026-01-06': -1 } } } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...v3, goalPlanning: { ...v3.goalPlanning, allocations: { pages: { '2026-01-10': 2 } } } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...v3, deadline: '2026-01-04' }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...v3, goalPlanning: { ...v3.goalPlanning, allocations: { minutes: { '2026-01-05': 2 } } } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...v3, goalPlanning: { ...v3.goalPlanning, progressSemantics: { pages: 'snapshot' }, allocations: { pages: { '2026-01-05': 2 } } } }).success).toBe(false)
    const checklist = { id: 'steps', name: 'Steps', valueType: 'checklist' as const, checklistItems: [{ id: 'one', label: 'One', position: 0 }, { id: 'two', label: 'Two', position: 1 }] }
    const checklistGoal = { ...v3, qualificationRule: undefined, milestones: [], metrics: [checklist], goalPlanning: { ...v3.goalPlanning, progressSemantics: { steps: 'incremental' as const }, cumulativeTargets: { steps: 10 }, allocations: { steps: { '2026-01-05': 2 } } } }
    expect(trackerDefinitionSchema.safeParse(checklistGoal).success).toBe(true)
    expect(trackerDefinitionSchema.safeParse({ ...checklistGoal, goalPlanning: { ...checklistGoal.goalPlanning, allocations: { steps: { '2026-01-05': 2.5 } } } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...checklistGoal, goalPlanning: { ...checklistGoal.goalPlanning, allocations: { steps: { '2026-01-05': 3 } } } }).success).toBe(false)
  })

  it('validates v4 precision, increments, and v4 planning allocations while retaining v1-v3 definitions', () => {
    const v4 = {
      ...tracker, schemaVersion: 4 as const, kind: 'goal' as const,
      metrics: [{ ...tracker.metrics[0]!, precision: { decimalPlaces: 2 as const, increment: 0.25 } }, tracker.metrics[1]!],
      goalPlanning: { mode: 'cumulative-deadline' as const, progressSemantics: { pages: 'incremental' as const }, dailyTargets: { pages: 1.25 }, cumulativeTargets: { pages: 100 }, planningTimeZone: 'UTC', allocations: { pages: { '2026-01-02': 1.25 } } },
    }
    expect(trackerDefinitionSchema.safeParse(tracker).success).toBe(true)
    expect(trackerDefinitionSchema.safeParse({ ...v4, schemaVersion: 3 }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse(v4).success).toBe(true)
    expect(trackerDefinitionSchema.safeParse({ ...v4, goalPlanning: { ...v4.goalPlanning, cumulativeTargets: { pages: 100.1 } } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...v4, metrics: [{ ...v4.metrics[0]!, precision: { decimalPlaces: 1, increment: 0.25 } }, tracker.metrics[1]!] }).success).toBe(false)
    expect(validateTrackerEntryValues(v4, { pages: 1.5 })).toBeUndefined()
    expect(validateTrackerEntryValues(v4, { pages: 1.3 })).toMatch(/increments of 0.25/)
    expect(validateTrackerEntryValues(v4, { pages: 1.3 }, { enforcePrecision: false })).toBeUndefined()
    expect(validateTrackerEntryValues(v4, { pages: 1.3 }, { existingValues: { pages: 1.3 } })).toBeUndefined()
    expect(validateTrackerEntryValues(v4, { pages: 1.4 }, { existingValues: { pages: 1.3 } })).toMatch(/increments of 0.25/)
  })

  it('rejects planning on v1 and non-goal v2 definitions', () => {
    const planning = { mode: 'daily-recurring', progressSemantics: {}, dailyTargets: {}, cumulativeTargets: {} }
    expect(trackerDefinitionSchema.safeParse({ ...tracker, goalPlanning: planning }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...tracker, schemaVersion: 2, goalPlanning: planning }).success).toBe(false)
  })

  it('validates plan target references, finite bounds, and cumulative semantics', () => {
    const goal = { ...tracker, schemaVersion: 2 as const, kind: 'goal' as const, goalPlanning: { mode: 'cumulative-deadline' as const, progressSemantics: { pages: 'snapshot' as const }, dailyTargets: {}, cumulativeTargets: { pages: 20 } } }
    expect(trackerDefinitionSchema.safeParse(goal).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...goal, goalPlanning: { ...goal.goalPlanning, progressSemantics: { pages: 'incremental' }, cumulativeTargets: { unknown: 20 } } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...goal, goalPlanning: { ...goal.goalPlanning, progressSemantics: { pages: 'incremental' }, cumulativeTargets: { pages: Number.MAX_SAFE_INTEGER + 1 } } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...goal, deadline: undefined }).success).toBe(false)
  })

  it('enforces checklist plan count semantics and rejects boolean planning targets', () => {
    const checklist = { id: 'steps', name: 'Steps', valueType: 'checklist' as const, checklistItems: [{ id: 'one', label: 'One', position: 0 }, { id: 'two', label: 'Two', position: 1 }] }
    const goal = { ...tracker, schemaVersion: 2 as const, kind: 'goal' as const, qualificationRule: undefined, milestones: [], metrics: [checklist], goalPlanning: { mode: 'daily-recurring' as const, progressSemantics: {}, dailyTargets: { steps: 3 }, cumulativeTargets: {} } }
    expect(trackerDefinitionSchema.safeParse(goal).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...goal, goalPlanning: { ...goal.goalPlanning, dailyTargets: { steps: 1.5 } } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...tracker, schemaVersion: 2, kind: 'goal', metrics: [{ id: 'mood', name: 'Mood', valueType: 'boolean' }], goalPlanning: { mode: 'daily-recurring', progressSemantics: {}, dailyTargets: { mood: 1 }, cumulativeTargets: {} } }).success).toBe(false)
    expect(trackerDefinitionSchema.safeParse({ ...goal, goalPlanning: { ...goal.goalPlanning, dailyTargets: { steps: 2 } } }).success).toBe(true)
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
