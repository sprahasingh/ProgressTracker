import { describe, expect, it } from 'vitest'
import { classifyAchievement, createWorkPlan, evaluateQualificationRule, evaluateTrackerEntry } from './planning'
import type { TrackerDefinition } from './types'

const base = (schedule: TrackerDefinition['schedule'] = { kind: 'every-day' }): TrackerDefinition => ({
  schemaVersion: 1, id: 'tracker', name: 'Prepare', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule,
  metrics: [
    { id: 'pages', name: 'Pages', valueType: 'quantity', thresholds: { direction: 'increase', minimum: 2, target: 5, stretch: 10, streakQualification: 'minimum' } },
    { id: 'minutes', name: 'Minutes', valueType: 'duration', thresholds: { direction: 'increase', minimum: 10, target: 30, streakQualification: 'minimum' } },
  ], customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
})

const plan = (overrides: Partial<Parameters<typeof createWorkPlan>[0]> = {}) => createWorkPlan({ tracker: base(), metricId: 'pages', mode: 'cumulative-deadline', startDate: '2026-01-01', deadline: '2026-01-05', asOfDate: '2026-01-01', totalWork: 10, completedWork: 0, ...overrides })

describe('achievement thresholds', () => {
  it('classifies minimum, target, stretch, and below-minimum achievement', () => {
    const metric = base().metrics[0]!
    expect([1, 2, 5, 10, 12].map((value) => classifyAchievement(metric, value))).toEqual(['none', 'minimum', 'target', 'stretch', 'stretch'])
  })

  it('supports decreasing metrics and boolean completion', () => {
    expect(classifyAchievement({ id: 'x', name: 'x', valueType: 'quantity', thresholds: { direction: 'decrease', minimum: 10, target: 5, stretch: 2, streakQualification: 'minimum' } }, 4)).toBe('target')
    expect(classifyAchievement({ id: 'b', name: 'done', valueType: 'boolean' }, true)).toBe('target')
  })

  it('uses the number of checked checklist items for achievement levels', () => {
    const checklist = { id: 'items', name: 'Practice', valueType: 'checklist' as const, checklistItems: [{ id: 'a', label: 'A', position: 0 }, { id: 'b', label: 'B', position: 1 }, { id: 'c', label: 'C', position: 2 }], thresholds: { direction: 'increase' as const, minimum: 1, target: 2, stretch: 3, streakQualification: 'minimum' as const } }
    expect(classifyAchievement(checklist, { a: true, b: true, c: false })).toBe('target')
    expect(classifyAchievement(checklist, [true, true, true])).toBe('stretch')
    expect(evaluateQualificationRule({ kind: 'threshold', metricId: 'items', level: 'target' }, [checklist], { items: { a: true, b: false, c: false } }).qualified).toBe(false)
  })
})

describe('qualification rules', () => {
  const metrics = base().metrics
  const rule = { kind: 'all' as const, operands: [
    { kind: 'threshold' as const, metricId: 'pages', level: 'minimum' as const },
    { kind: 'any' as const, operands: [
      { kind: 'threshold' as const, metricId: 'minutes', level: 'target' as const },
      { kind: 'comparison' as const, metricId: 'pages', operator: 'at-least' as const, value: 8 },
    ] },
  ] }

  it('evaluates nested all/any rules and returns stable metric summaries', () => {
    expect(evaluateQualificationRule(rule, metrics, { pages: 2, minutes: 30 })).toEqual({ qualified: true, achievedMetricIds: ['minutes', 'pages'], failedMetricIds: [] })
    expect(evaluateQualificationRule(rule, metrics, { pages: 2, minutes: 15 })).toEqual({ qualified: false, achievedMetricIds: ['pages'], failedMetricIds: ['minutes'] })
  })

  it('evaluates at-least counts and skipped entries do not qualify', () => {
    expect(evaluateQualificationRule({ kind: 'at-least', required: 2, operands: rule.operands }, metrics, { pages: 8, minutes: 30 }).qualified).toBe(true)
    const tracker = { ...base(), qualificationRule: rule }
    expect(evaluateTrackerEntry(tracker, { id: 'e', trackerId: tracker.id, date: '2026-01-01', outcome: 'skipped', values: {}, note: '', createdAt: tracker.createdAt, updatedAt: tracker.updatedAt, deletedAt: null }).qualified).toBe(false)
  })
})

describe('adaptive workload planning', () => {
  it('distributes work over eligible days and recalculates remaining workload', () => {
    expect(plan().dailyWorkload).toBe(2)
    const recalculated = plan({ asOfDate: '2026-01-03', completedWork: 4, completedDates: ['2026-01-01', '2026-01-02'] })
    expect(recalculated.remainingWork).toBe(6)
    expect(recalculated.dailyWorkload).toBe(2)
    expect(recalculated.days.find((day) => day.date === '2026-01-02')?.state).toBe('completed')
  })

  it('respects rest days and non-daily schedules', () => {
    const weekdays = plan({ tracker: base({ kind: 'weekdays' }), startDate: '2026-01-03', deadline: '2026-01-06', asOfDate: '2026-01-03', totalWork: 2 })
    expect(weekdays.days.map(({ date, state }) => [date, state])).toEqual([['2026-01-03', 'rest'], ['2026-01-04', 'rest'], ['2026-01-05', 'planned'], ['2026-01-06', 'planned']])
    const withRest = plan({ startDate: '2026-01-01', deadline: '2026-01-04', restDays: [0], totalWork: 3 })
    expect(withRest.days.find((day) => day.date === '2026-01-04')?.state).toBe('rest')
  })

  it('marks missed days, early completion, and overdue deadlines', () => {
    expect(plan({ asOfDate: '2026-01-03' }).days.find((day) => day.date === '2026-01-01')?.state).toBe('missed')
    const early = plan({ totalWork: 2, completedWork: 2, completedDates: ['2026-01-02'], asOfDate: '2026-01-01' })
    expect(early.status).toBe('completed')
    expect(early.days.find((day) => day.date === '2026-01-02')?.state).toBe('early-completion')
    const overdue = plan({ asOfDate: '2026-01-07', deadline: '2026-01-05' })
    expect(overdue.status).toBe('overdue')
    expect(overdue.overdueByDays).toBe(2)
  })

  it('supports daily recurring goals and rejects impossible inputs', () => {
    expect(plan({ mode: 'daily-recurring', totalWork: 5, deadline: '2026-01-05' }).mode).toBe('daily-recurring')
    expect(() => plan({ completedWork: 11 })).toThrow(/cannot exceed/)
    expect(() => plan({ metricId: 'unknown' })).toThrow(/Unknown metric/)
    expect(() => plan({ deadline: '2025-12-31' })).toThrow(/Deadline cannot precede/)
  })
})
