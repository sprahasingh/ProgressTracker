import { describe, expect, it } from 'vitest'
import { expandHolidayRange, liveHolidayDates } from './holidays'
import { calculateStreak } from './trackers/progression'
import { calculateDailyRecurringMetricPlan, calculateCumulativeMetricPlan } from './trackers/planning'
import type { TrackerDefinition, TrackerEntry } from './trackers/types'

const daily: TrackerDefinition = {
  schemaVersion: 2, id: 'holiday-tracker', name: 'Practice', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' }, startDate: '2026-03-06', deadline: '2026-03-12',
  metrics: [{ id: 'minutes', name: 'Minutes', valueType: 'quantity', thresholds: { direction: 'increase', minimum: 10, target: 30, streakQualification: 'minimum' } }],
  customFields: [], milestones: [], createdAt: '2026-03-06T00:00:00.000Z', updatedAt: '2026-03-06T00:00:00.000Z', archivedAt: null, deletedAt: null,
}
const entry = (date: string, value: number): TrackerEntry => ({ id: `e-${date}`, trackerId: daily.id, date, outcome: 'recorded', values: { minutes: value }, note: '', createdAt: `${date}T09:00:00.000Z`, updatedAt: `${date}T09:00:00.000Z`, deletedAt: null })

describe('global holidays', () => {
  it('expands one-day and date ranges using calendar arithmetic across leap day and DST dates', () => {
    expect(expandHolidayRange('2024-02-28', '2024-03-01')).toEqual(['2024-02-28', '2024-02-29', '2024-03-01'])
    expect(expandHolidayRange('2026-03-07', '2026-03-09')).toEqual(['2026-03-07', '2026-03-08', '2026-03-09'])
    expect(expandHolidayRange('2026-03-08', '2026-03-08')).toEqual(['2026-03-08'])
    expect(() => expandHolidayRange('2026-02-30', '2026-03-01')).toThrow(/Invalid holiday date/)
    expect(() => expandHolidayRange('2026-03-02', '2026-03-01')).toThrow(/on or after/)
  })

  it('does not count holidays as successes or misses and resumes a streak on the next scheduled date', () => {
    const entries = [entry('2026-03-06', 10), entry('2026-03-10', 10)]
    const result = calculateStreak(daily, entries, '2026-03-10', new Set(['2026-03-09']))
    expect(result).toMatchObject({ current: 2, longest: 2, qualifyingCount: 2, scheduledCount: 2, missedCount: 0 })
  })

  it('pauses a streak across consecutive scheduled holidays without counting holiday activity', () => {
    const holidays = new Set(['2026-03-09', '2026-03-10'])
    const entries = [entry('2026-03-06', 10), entry('2026-03-09', 30), entry('2026-03-10', 30), entry('2026-03-11', 10)]
    expect(calculateStreak(daily, entries, '2026-03-11', holidays)).toMatchObject({
      current: 2, longest: 2, qualifyingCount: 2, scheduledCount: 2, missedCount: 0,
    })
    expect(calculateStreak(daily, entries, '2026-03-10', holidays)).toMatchObject({ current: 1, scheduledCount: 1, missedCount: 0 })
  })

  it('restarts a paused streak only when a scheduled non-holiday day is missed', () => {
    const holidays = new Set(['2026-03-09', '2026-03-10'])
    const entries = [entry('2026-03-06', 10), entry('2026-03-12', 10)]
    expect(calculateStreak(daily, entries, '2026-03-12', holidays)).toMatchObject({
      current: 1, longest: 1, qualifyingCount: 2, scheduledCount: 3, missedCount: 1,
    })
  })

  it('lets a partial value meet the configured streak threshold without turning it into daily success', () => {
    const tracker = { ...daily, qualificationRule: { kind: 'threshold' as const, metricId: 'minutes', level: 'target' as const } }
    expect(calculateStreak(tracker, [entry('2026-03-06', 10)], '2026-03-06').qualifyingCount).toBe(1)
  })

  it('removes holiday dates from recurring and cumulative scheduled opportunity counts while preserving logged work', () => {
    const holidays = new Set(['2026-03-09'])
    const recurring = calculateDailyRecurringMetricPlan({ tracker: daily, entries: [entry('2026-03-06', 10)], metricId: 'minutes', target: 30, asOfDate: '2026-03-10', startDate: '2026-03-06', holidays })
    expect(recurring.days.find((day) => day.date === '2026-03-09')?.state).toBe('holiday')
    expect(recurring.elapsedOpportunities).toBe(1)
    const cumulative = calculateCumulativeMetricPlan({ tracker: daily, entries: [entry('2026-03-06', 10)], metricId: 'minutes', totalTarget: 40, asOfDate: '2026-03-10', startDate: '2026-03-06', progressSemantics: 'incremental', holidays })
    expect(cumulative).toMatchObject({ actualProgress: 10, scheduledDaysTotal: 4, scheduledDaysRemaining: 3 })
  })

  it('recalculates cumulative expected progress and pace over eligible days after holidays are added', () => {
    const input = { tracker: daily, entries: [entry('2026-03-06', 10)], metricId: 'minutes', totalTarget: 40, asOfDate: '2026-03-10', startDate: '2026-03-06', progressSemantics: 'incremental' as const }
    const ordinary = calculateCumulativeMetricPlan(input)
    const withBreak = calculateCumulativeMetricPlan({ ...input, holidays: new Set(['2026-03-09', '2026-03-10']) })

    expect(ordinary).toMatchObject({ scheduledDaysTotal: 5, scheduledDaysRemaining: 3, expectedProgress: 24, requiredDailyPace: 10 })
    expect(withBreak).toMatchObject({ scheduledDaysTotal: 3, scheduledDaysRemaining: 2, expectedProgress: 40 / 3, requiredDailyPace: 15 })
  })

  it('filters removed holidays from calculations', () => {
    expect(liveHolidayDates([
      { id: 'live', date: '2026-03-09', reason: null, createdAt: '', updatedAt: '', deletedAt: null },
      { id: 'removed', date: '2026-03-10', reason: null, createdAt: '', updatedAt: '', deletedAt: '2026-03-10T00:00:00Z' },
    ])).toEqual(new Set(['2026-03-09']))
  })
})
