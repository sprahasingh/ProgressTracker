import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry, TrackerMetricDefinition, TrackerMilestoneDefinition } from './types'
import { availableMilestoneTypes, evaluateMilestones } from './milestones'

const problems: TrackerMetricDefinition = { id: 'problems', name: 'DSA Problems', valueType: 'quantity', unit: 'problems' }
const baseTracker = (overrides: Partial<TrackerDefinition> = {}): TrackerDefinition => ({
  schemaVersion: 8,
  id: 'tracker-1', name: 'Practice', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '#315e46', schedule: { kind: 'every-day' }, startDate: '2026-01-01',
  metrics: [problems], qualificationRule: { kind: 'comparison', metricId: 'problems', operator: 'at-least', value: 1 },
  streakRuleMode: 'same-as-success', customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
  ...overrides,
})
const milestone = (type: TrackerMilestoneDefinition['type'], targetValue: number, changes: Partial<TrackerMilestoneDefinition> = {}): TrackerMilestoneDefinition => ({
  id: 'milestone-1', title: 'Checkpoint', description: '', type, metricId: 'problems', targetValue,
  measureTypeSnapshot: 'quantity', unitSnapshot: 'problems', position: 0, ...changes,
})
const entry = (date: string, value: unknown, changes: Partial<TrackerEntry> = {}): TrackerEntry => ({
  id: `entry-${date}`, trackerId: 'tracker-1', date, outcome: 'recorded', values: { problems: value as number }, note: '',
  createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, deletedAt: null, ...changes,
})

describe('typed milestone calculations', () => {
  it('sums cumulative numeric measures, counts zero once, and recomputes edited or deleted history', () => {
    const tracker = baseTracker({ milestones: [milestone('cumulative-quantity', 10)] })
    const history = [entry('2026-01-01', 3), entry('2026-01-02', 0), entry('2026-01-03', 5)]
    expect(evaluateMilestones({ tracker, entries: history, asOfDate: '2026-01-03' })[0]).toMatchObject({ current: 8, completed: false, progressLabel: '8 / 10 problems total', reachedDate: null })
    expect(evaluateMilestones({ tracker, entries: [...history, entry('2026-01-04', 2)], asOfDate: '2026-01-04' })[0]).toMatchObject({ current: 10, completed: true, reachedDate: '2026-01-04', percent: 100 })
    expect(evaluateMilestones({ tracker, entries: [...history, entry('2026-01-04', 7)], asOfDate: '2026-01-04' })[0]).toMatchObject({ current: 15, completed: true, progressLabel: '15 / 10 problems total', percent: 100 })
    const deleted = entry('2026-01-03', 5, { deletedAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z' })
    expect(evaluateMilestones({ tracker, entries: [...history, deleted], asOfDate: '2026-01-05' })[0]).toMatchObject({ current: 3, completed: false, reachedDate: null })
  })

  it('keeps single-day quantity separate from cumulative totals and records the first qualifying date', () => {
    const tracker = baseTracker({ milestones: [milestone('single-day-quantity', 10)] })
    const twoSmallerDays = [entry('2026-01-01', 5), entry('2026-01-02', 5)]
    expect(evaluateMilestones({ tracker, entries: twoSmallerDays, asOfDate: '2026-01-02' })[0]).toMatchObject({ current: 5, completed: false, progressLabel: 'Best day: 5 / 10 problems' })
    expect(evaluateMilestones({ tracker, entries: [...twoSmallerDays, entry('2026-01-03', 12)], asOfDate: '2026-01-03' })[0]).toMatchObject({ current: 12, completed: true, reachedDate: '2026-01-03' })
  })

  it('uses Success Rule for successful dates and Streak Rule for the longest achieved streak', () => {
    const tracker = baseTracker({
      qualificationRule: { kind: 'comparison', metricId: 'problems', operator: 'at-least', value: 3 },
      streakRuleMode: 'custom', streakRule: { kind: 'comparison', metricId: 'problems', operator: 'at-least', value: 1 },
      milestones: [
        milestone('successful-days', 2, { id: 'success', metricId: undefined, measureTypeSnapshot: undefined, unitSnapshot: undefined, position: 0 }),
        milestone('streak-length', 3, { id: 'streak', metricId: undefined, measureTypeSnapshot: undefined, unitSnapshot: undefined, position: 1 }),
      ],
    })
    const result = evaluateMilestones({ tracker, entries: [entry('2026-01-01', 2), entry('2026-01-02', 3), entry('2026-01-03', 2)], asOfDate: '2026-01-03' })
    expect(result[0]).toMatchObject({ current: 1, completed: false, trackingLabel: 'Successful activity days' })
    expect(result[1]).toMatchObject({ current: 3, completed: true, reachedDate: '2026-01-03', progressLabel: 'Best streak: 3 / 3 days', secondaryLabel: 'Current streak', secondaryValue: 3 })
  })

  it('counts successful days only on progression opportunities and applies Strict Mode to rest days and holidays', () => {
    const tracker = baseTracker({ schedule: { kind: 'weekdays' }, milestones: [milestone('successful-days', 2, { metricId: undefined, measureTypeSnapshot: undefined, unitSnapshot: undefined })] })
    const history = [entry('2026-01-05', 1), entry('2026-01-06', 1), entry('2026-01-10', 1)]
    const holidays = new Set(['2026-01-06'])
    expect(evaluateMilestones({ tracker, entries: history, asOfDate: '2026-01-10', holidays })[0]).toMatchObject({ current: 2, completed: true })
    expect(evaluateMilestones({ tracker: { ...tracker, strictMode: true }, entries: history, asOfDate: '2026-01-10', holidays })[0]).toMatchObject({ current: 3, completed: true, reachedDate: '2026-01-06' })
  })

  it('keeps holiday activity out of every milestone unless it is counted normally', () => {
    const date = '2026-01-05'
    const holiday = new Set([date])
    const tracker = baseTracker({ milestones: [milestone('cumulative-quantity', 1), milestone('successful-days', 1, { id: 'successful-days', metricId: undefined, measureTypeSnapshot: undefined, unitSnapshot: undefined, position: 1 })] })
    const keep = entry(date, 5, { holidayTreatment: 'keep-holiday' })
    expect(evaluateMilestones({ tracker, entries: [keep], asOfDate: date, holidays: holiday }).map(({ current }) => current)).toEqual([0, 0])
    const counted = { ...keep, holidayTreatment: 'count-normal' as const }
    expect(evaluateMilestones({ tracker, entries: [counted], asOfDate: date, holidays: holiday }).map(({ current }) => current)).toEqual([5, 1])
    const legacy = { ...keep, holidayTreatment: undefined }
    expect(evaluateMilestones({ tracker, entries: [legacy], asOfDate: date, holidays: holiday }).map(({ current }) => current)).toEqual([5, 1])
  })

  it('uses Calendar Days and both Effective Days methods for challenge progression', () => {
    const calendar = baseTracker({ kind: 'challenge', startDate: '2026-01-05', deadline: '2026-01-08', scheduling: { mode: 'calendar' }, milestones: [milestone('challenge-day', 4, { metricId: undefined, measureTypeSnapshot: undefined, unitSnapshot: undefined })] })
    expect(evaluateMilestones({ tracker: calendar, entries: [], asOfDate: '2026-01-08' })[0]).toMatchObject({ current: 4, completed: true, reachedDate: '2026-01-08', progressLabel: 'Challenge Day 4 / 4' })
    const planned = baseTracker({ kind: 'challenge', startDate: '2026-01-09', schedule: { kind: 'weekdays' }, deadline: '2026-01-13', scheduling: { mode: 'effective', effectiveDays: 3, effectiveDayCounting: 'planned-activity-days' }, milestones: [milestone('challenge-day', 2, { metricId: undefined, measureTypeSnapshot: undefined, unitSnapshot: undefined })] })
    expect(evaluateMilestones({ tracker: planned, entries: [], asOfDate: '2026-01-12' })[0]).toMatchObject({ current: 2, completed: true, reachedDate: '2026-01-12' })
    const allNonHoliday = { ...planned, scheduling: { mode: 'effective' as const, effectiveDays: 3, effectiveDayCounting: 'all-non-holiday-days' as const } }
    expect(evaluateMilestones({ tracker: allNonHoliday, entries: [], asOfDate: '2026-01-11' })[0]).toMatchObject({ current: 3, completed: true, reachedDate: '2026-01-10' })
    expect(availableMilestoneTypes(baseTracker({ kind: 'challenge', scheduling: { mode: 'ongoing' } }))).not.toContain('challenge-day')
  })

  it('counts Done days, selected checklist items, and fully complete checklist dates', () => {
    const yesNo: TrackerMetricDefinition = { id: 'theory', name: 'Studied theory', valueType: 'boolean' }
    const yesMilestone = milestone('measure-completion-count', 2, { metricId: 'theory', measureTypeSnapshot: 'boolean', unitSnapshot: undefined, completionCondition: 'true-day' })
    const booleanTracker = baseTracker({ metrics: [yesNo], qualificationRule: { kind: 'comparison', metricId: 'theory', operator: 'equals', value: true }, milestones: [yesMilestone] })
    const boolEntries = [entry('2026-01-01', true, { values: { theory: true } }), entry('2026-01-02', false, { values: { theory: false } }), entry('2026-01-03', true, { values: { theory: true } })]
    expect(evaluateMilestones({ tracker: booleanTracker, entries: boolEntries, asOfDate: '2026-01-03' })[0]).toMatchObject({ current: 2, completed: true, reachedDate: '2026-01-03', progressLabel: '2 / 2 Done days' })

    const checklist: TrackerMetricDefinition = { id: 'routine', name: 'Routine', valueType: 'checklist', checklistItems: [{ id: 'theory', label: 'Theory', position: 0 }, { id: 'review', label: 'Review', position: 1 }] }
    const checklistTracker = baseTracker({ metrics: [checklist], qualificationRule: undefined, milestones: [
      milestone('measure-completion-count', 1, { id: 'item', metricId: 'routine', measureTypeSnapshot: 'checklist', unitSnapshot: undefined, completionCondition: 'checklist-item-day', checklistItemId: 'theory', checklistItemLabelSnapshot: 'Theory' }),
      milestone('measure-completion-count', 2, { id: 'full', metricId: 'routine', measureTypeSnapshot: 'checklist', unitSnapshot: undefined, completionCondition: 'checklist-complete-day', checklistItemsSnapshot: ['theory', 'review'], position: 1 }),
    ] })
    const checklistEntries = [entry('2026-01-01', { theory: true, review: false }, { values: { routine: { theory: true, review: false } } }), entry('2026-01-02', { theory: true, review: true }, { values: { routine: { theory: true, review: true } } }), entry('2026-01-03', { theory: true, review: true }, { values: { routine: { theory: true, review: true } } })]
    expect(evaluateMilestones({ tracker: checklistTracker, entries: checklistEntries, asOfDate: '2026-01-03' }).map((item) => ({ current: item.current, complete: item.completed, date: item.reachedDate }))).toEqual([
      { current: 3, complete: true, date: '2026-01-01' },
      { current: 2, complete: true, date: '2026-01-03' },
    ])
  })

  it('keeps no-recurrence measures countable without inventing scheduled success or streak days', () => {
    const yesNo: TrackerMetricDefinition = { id: 'theory', name: 'Studied theory', valueType: 'boolean' }
    const tracker = baseTracker({ schedule: { kind: 'none' }, metrics: [yesNo], qualificationRule: { kind: 'comparison', metricId: 'theory', operator: 'equals', value: true }, milestones: [
      milestone('measure-completion-count', 2, { metricId: 'theory', measureTypeSnapshot: 'boolean', unitSnapshot: undefined, completionCondition: 'true-day' }),
    ] })
    const history = [entry('2026-01-01', true, { values: { theory: true } }), entry('2026-01-02', true, { values: { theory: true } })]
    expect(evaluateMilestones({ tracker, entries: history, asOfDate: '2026-01-02' })[0]).toMatchObject({ current: 2, completed: true, reachedDate: '2026-01-02' })
    expect(availableMilestoneTypes(tracker)).not.toContain('successful-days')
    expect(availableMilestoneTypes(tracker)).not.toContain('streak-length')
    expect(availableMilestoneTypes({ ...tracker, strictMode: true })).toContain('streak-length')
  })

  it('keeps legacy checkpoints as best single observations and reports changed measure definitions', () => {
    const legacy = { id: 'milestone-1', title: 'Old checkpoint', description: '', metricId: 'problems', targetValue: 10, position: 0 }
    const oldTracker = baseTracker({ milestones: [legacy] })
    expect(evaluateMilestones({ tracker: oldTracker, entries: [entry('2026-01-01', 6), entry('2026-01-02', 6)], asOfDate: '2026-01-02' })[0]).toMatchObject({ type: 'legacy', current: 6, completed: false, trackingLabel: 'Saved checkpoint (original calculation)' })
    const typed = baseTracker({ milestones: [milestone('cumulative-quantity', 10)] })
    expect(evaluateMilestones({ tracker: { ...typed, metrics: [{ ...problems, valueType: 'duration' }] }, entries: [], asOfDate: '2026-01-01' })[0]!.configurationIssue).toMatch(/changed from quantity to duration/)
    expect(evaluateMilestones({ tracker: { ...typed, metrics: [{ ...problems, unit: 'hours' }] }, entries: [], asOfDate: '2026-01-01' })[0]!.configurationIssue).toMatch(/unit.*changed/i)
  })
})
