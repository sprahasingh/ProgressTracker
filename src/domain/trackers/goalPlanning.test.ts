import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry } from './types'
import { calculateCumulativeMetricPlan, calculateDailyRecurringMetricPlan } from './planning'
import { calculateTrackerAnalytics } from './analytics'

const tracker: TrackerDefinition = {
  schemaVersion: 1, id: 'goal-plan', name: 'Write', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' }, startDate: '2026-10-01', deadline: '2026-10-09',
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', target: 5, streakQualification: 'target' } }],
  customFields: [], milestones: [], createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z', archivedAt: null, deletedAt: null,
}

function entry(date: string, value: number, updatedAt = `${date}T12:00:00.000Z`, overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return { id: `entry-${date}-${updatedAt}`, trackerId: tracker.id, date, outcome: 'recorded', values: { pages: value }, note: '', createdAt: `${date}T09:00:00.000Z`, updatedAt, deletedAt: null, ...overrides }
}

describe('daily recurring planning', () => {
  it('starts at the later of tracker creation and configured start', () => {
    const createdToday = { ...tracker, createdAt: '2026-10-02T09:00:00.000Z', startDate: '2026-10-01' }
    const daily = calculateDailyRecurringMetricPlan({ tracker: createdToday, metricId: 'pages', target: 5, startDate: '2026-10-01', asOfDate: '2026-10-04', entries: [] })
    expect(daily.days.map((day) => day.date)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'])
    expect(daily.days.some((day) => day.state === 'missed' && day.date < createdToday.createdAt.slice(0, 10))).toBe(false)
    const withoutConfiguredStart = { ...createdToday, startDate: undefined }
    expect(calculateDailyRecurringMetricPlan({ tracker: withoutConfiguredStart, metricId: 'pages', target: 5, startDate: '2026-10-01', asOfDate: '2026-10-04', entries: [] }).days[0]?.date).toBe('2026-10-02')
    const futureStart = calculateDailyRecurringMetricPlan({ tracker: createdToday, metricId: 'pages', target: 5, startDate: '2026-10-05', asOfDate: '2026-10-04', entries: [] })
    expect(futureStart.days.map((day) => [day.date, day.state])).toEqual([
      ['2026-10-05', 'future'], ['2026-10-06', 'future'], ['2026-10-07', 'future'], ['2026-10-08', 'future'], ['2026-10-09', 'future'],
    ])
    const shortWindowTracker = { ...createdToday, deadline: '2026-10-04' }
    const shortWindowPlan = calculateDailyRecurringMetricPlan({ tracker: shortWindowTracker, metricId: 'pages', target: 5, startDate: '2026-10-01', asOfDate: '2026-10-04', entries: [] })
    const analytics = calculateTrackerAnalytics(shortWindowTracker, [], '2026-10-01', '2026-10-04')
    expect(shortWindowPlan.elapsedOpportunities).toBe(analytics.scheduledCount)
  })

  it('follows scheduled days, leaves today open, and excludes rest days from missed consistency', () => {
    const plan = calculateDailyRecurringMetricPlan({
      tracker, metricId: 'pages', target: 5, startDate: '2026-10-01', asOfDate: '2026-10-07',
      entries: [entry('2026-10-01', 5), entry('2026-10-02', 2), entry('2026-10-05', 5)],
    })
    expect(plan.days.find((day) => day.date === '2026-10-03')?.state).toBe('rest')
    expect(plan.days.find((day) => day.date === '2026-10-04')?.state).toBe('rest')
    expect(plan.days.find((day) => day.date === '2026-10-06')?.state).toBe('missed')
    expect(plan.days.find((day) => day.date === '2026-10-07')?.state).toBe('pending')
    expect(plan.days.find((day) => day.date === '2026-10-08')?.state).toBe('future')
    expect(plan.metCount).toBe(2)
    expect(plan.elapsedOpportunities).toBe(4)
    expect(plan.consistencyPercent).toBe(50)
  })

  it('uses the latest edited entry for a date and excludes a later tombstone', () => {
    const plan = calculateDailyRecurringMetricPlan({
      tracker, metricId: 'pages', target: 5, startDate: '2026-10-01', asOfDate: '2026-10-07',
      entries: [
        entry('2026-10-01', 20), entry('2026-10-01', 3, '2026-10-01T13:00:00.000Z'),
        entry('2026-10-02', 10), entry('2026-10-02', 10, '2026-10-02T13:00:00.000Z', { deletedAt: '2026-10-02T13:00:00.000Z' }),
      ],
    })
    expect(plan.days.find((day) => day.date === '2026-10-01')).toMatchObject({ state: 'below-target', value: 3 })
    expect(plan.days.find((day) => day.date === '2026-10-02')?.state).toBe('missed')
    expect(plan.metCount).toBe(0)
  })

  it('respects decreasing metric direction for per-day targets', () => {
    const decreasing: TrackerDefinition = { ...tracker, metrics: [{ ...tracker.metrics[0]!, thresholds: { direction: 'decrease', target: 5, streakQualification: 'target' } }] }
    const plan = calculateDailyRecurringMetricPlan({ tracker: decreasing, metricId: 'pages', target: 5, startDate: '2026-10-01', asOfDate: '2026-10-01', entries: [entry('2026-10-01', 3)] })
    expect(plan.direction).toBe('decrease')
    expect(plan.days[0]?.state).toBe('met')
  })
})

describe('cumulative deadline planning', () => {
  it('excludes pre-creation scheduled days and progress from goal projections', () => {
    const createdToday = { ...tracker, createdAt: '2026-10-02T09:00:00.000Z', startDate: '2026-10-01' }
    const plan = calculateCumulativeMetricPlan({
      tracker: createdToday, metricId: 'pages', totalTarget: 100, startDate: '2026-10-01', asOfDate: '2026-10-06', progressSemantics: 'incremental',
      entries: [entry('2026-10-01', 90), entry('2026-10-02', 5), entry('2026-10-06', 0)],
    })
    expect(plan).toMatchObject({ actualProgress: 5, scheduledDaysTotal: 6, scheduledDaysRemaining: 3, remainingWork: 95 })
  })

  it('handles a deadline equal to the first eligible date and an exhausted plan', () => {
    const createdOnDeadline = { ...tracker, createdAt: '2026-10-02T09:00:00.000Z', deadline: '2026-10-02', startDate: '2026-10-01' }
    const plan = calculateCumulativeMetricPlan({ tracker: createdOnDeadline, entries: [], metricId: 'pages', totalTarget: 10, startDate: '2026-10-01', asOfDate: '2026-10-03', progressSemantics: 'incremental' })
    expect(plan).toMatchObject({ scheduledDaysTotal: 1, scheduledDaysRemaining: 0, status: 'overdue', requiredDailyPace: null })
  })

  it('recalculates from a later start while retaining pre-start entries as saved history', () => {
    const historical = entry('2026-10-01', 20)
    const current = entry('2026-10-05', 5)
    const entries = [historical, current]
    const plan = calculateCumulativeMetricPlan({
      tracker, entries, metricId: 'pages', totalTarget: 100, startDate: '2026-10-05', asOfDate: '2026-10-06', progressSemantics: 'incremental',
    })

    expect(plan).toMatchObject({ actualProgress: 5, scheduledDaysTotal: 5, expectedProgress: 40 })
    expect(entries).toEqual([historical, current])
  })

  it('sums only explicit increments, counts rest-day work, replaces edits, and ignores tombstones and skipped rows', () => {
    const plan = calculateCumulativeMetricPlan({
      tracker, metricId: 'pages', totalTarget: 100, startDate: '2026-10-01', asOfDate: '2026-10-07', progressSemantics: 'incremental',
      entries: [
        entry('2026-10-01', 10), entry('2026-10-02', 8, undefined, { outcome: 'skipped' }),
        entry('2026-10-03', 3), // Saturday rest day; the completed work still counts.
        entry('2026-10-05', 99), entry('2026-10-05', 5, '2026-10-05T13:00:00.000Z'),
        entry('2026-10-06', 40), entry('2026-10-06', 40, '2026-10-06T13:00:00.000Z', { deletedAt: '2026-10-06T13:00:00.000Z' }),
        entry('2026-10-07', 10), entry('2026-10-08', 50),
      ],
    })
    expect(plan.actualProgress).toBe(28)
    expect(plan.expectedProgress).toBeCloseTo(100 * 5 / 7)
    expect(plan.remainingWork).toBe(72)
    expect(plan.scheduledDaysTotal).toBe(7)
    expect(plan.scheduledDaysRemaining).toBe(2)
    expect(plan.requiredDailyPace).toBe(36)
    expect(plan.status).toBe('active')
    expect(plan.paceStatus).toBe('behind')
  })

  it('rejects cumulative sums of snapshot metrics', () => {
    expect(() => calculateCumulativeMetricPlan({ tracker, entries: [], metricId: 'pages', totalTarget: 10, startDate: '2026-10-01', asOfDate: '2026-10-02', progressSemantics: 'snapshot' })).toThrow(/incremental/)
  })

  it('adds decimal progress without binary floating-point drift', () => {
    const decimalTracker = { ...tracker, deadline: '2026-10-31' }
    const plan = calculateCumulativeMetricPlan({
      tracker: decimalTracker, metricId: 'pages', totalTarget: 0.3, startDate: '2026-10-01', asOfDate: '2026-10-02', progressSemantics: 'incremental',
      entries: [entry('2026-10-01', 0.1), entry('2026-10-02', 0.2)],
    })
    expect(plan.actualProgress).toBe(0.3)
    expect(plan.remainingWork).toBe(0)
    expect(plan.status).toBe('completed')
  })

  it('handles completion, deadline expiry, future starts, and zero scheduled days without infinity', () => {
    const input = { tracker, entries: [entry('2026-10-01', 100)], metricId: 'pages', totalTarget: 100, startDate: '2026-10-01', progressSemantics: 'incremental' as const }
    expect(calculateCumulativeMetricPlan({ ...input, asOfDate: '2026-10-02' })).toMatchObject({ status: 'completed', remainingWork: 0, requiredDailyPace: 0 })
    expect(calculateCumulativeMetricPlan({ ...input, entries: [], asOfDate: '2026-10-10' })).toMatchObject({ status: 'overdue', requiredDailyPace: null, scheduledDaysRemaining: 0 })
    expect(calculateCumulativeMetricPlan({ ...input, entries: [], startDate: '2026-10-05', asOfDate: '2026-10-01' })).toMatchObject({ status: 'not-started' })
    const noSchedule = { ...tracker, schedule: { kind: 'none' as const } }
    expect(calculateCumulativeMetricPlan({ ...input, tracker: noSchedule, entries: [], asOfDate: '2026-10-02' })).toMatchObject({ status: 'no-scheduled-days', paceStatus: 'no-scheduled-days', requiredDailyPace: null })
  })

  it('counts checklist values as completed-item increments without combining other metrics', () => {
    const checklistTracker: TrackerDefinition = { ...tracker, metrics: [
      { id: 'steps', name: 'Steps', valueType: 'checklist', checklistItems: [{ id: 'a', label: 'A', position: 0 }, { id: 'b', label: 'B', position: 1 }] },
      { id: 'minutes', name: 'Minutes', valueType: 'duration', unit: 'min' },
    ] }
    const checklistEntry: TrackerEntry = { ...entry('2026-10-01', 0), values: { steps: { a: true, b: false }, minutes: 20 } }
    expect(calculateCumulativeMetricPlan({ tracker: checklistTracker, entries: [checklistEntry], metricId: 'steps', totalTarget: 6, startDate: '2026-10-01', asOfDate: '2026-10-01', progressSemantics: 'incremental' })).toMatchObject({ actualProgress: 1, remainingWork: 5 })
    expect(calculateCumulativeMetricPlan({ tracker: checklistTracker, entries: [checklistEntry], metricId: 'minutes', totalTarget: 60, startDate: '2026-10-01', asOfDate: '2026-10-01', progressSemantics: 'incremental' })).toMatchObject({ actualProgress: 20, remainingWork: 40 })
  })
})
