import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry } from './types'
import { createCumulativeAllocationPreview, distributeTarget, summarizeAllocations } from './allocationPreview'

const tracker: TrackerDefinition = {
  schemaVersion: 2, id: 'preview-goal', name: 'Write a guide', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' }, startDate: '2026-01-05', deadline: '2026-01-07',
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' }], customFields: [], milestones: [],
  goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: {}, cumulativeTargets: { pages: 10 } },
  createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

function entry(date: string, value: number, overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return { id: `entry-${date}`, trackerId: tracker.id, date, outcome: 'recorded', values: { pages: value }, note: '', createdAt: `${date}T09:00:00.000Z`, updatedAt: `${date}T09:00:00.000Z`, deletedAt: null, ...overrides }
}

describe('cumulative allocation preview', () => {
  it('distributes the remaining amount to scheduled dates and rounds with an exact remainder', () => {
    const preview = createCumulativeAllocationPreview({ tracker, entries: [], metricId: 'pages', totalTarget: 10, startDate: '2026-01-05', asOfDate: '2026-01-05' })
    expect(preview.days).toEqual([
      { date: '2026-01-05', eligible: true, amount: 3.34 },
      { date: '2026-01-06', eligible: true, amount: 3.33 },
      { date: '2026-01-07', eligible: true, amount: 3.33 },
    ])
    expect(preview.days.reduce((total, day) => total + (day.amount ?? 0), 0)).toBe(10)
    expect(distributeTarget(1.005, 2)).toEqual([0.503, 0.502])
  })

  it('front-loads integer remainders and leaves later dates at zero', () => {
    expect(distributeTarget(10, 3, false, 1)).toEqual([4, 3, 3])
    expect(distributeTarget(3, 5, false, 1)).toEqual([1, 1, 1, 0, 0])
  })

  it('recalculates remaining future suggestions after today is logged', () => {
    const wholeGoal: TrackerDefinition = {
      ...tracker, schemaVersion: 4, schedule: { kind: 'every-day' }, startDate: '2026-01-05', deadline: '2026-01-07',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', precision: { decimalPlaces: 0, increment: 1 } }],
    }
    const before = createCumulativeAllocationPreview({ tracker: wholeGoal, entries: [], metricId: 'pages', totalTarget: 10, startDate: '2026-01-05', asOfDate: '2026-01-05' })
    expect(before.days.map((day) => day.amount)).toEqual([4, 3, 3])
    const afterSix = createCumulativeAllocationPreview({ tracker: wholeGoal, entries: [entry('2026-01-05', 6)], metricId: 'pages', totalTarget: 10, startDate: '2026-01-05', asOfDate: '2026-01-05' })
    expect(afterSix.actualProgress).toBe(6)
    expect(afterSix.days).toMatchObject([{ closed: true, eligible: false }, { eligible: true, amount: 2 }, { eligible: true, amount: 2 }])
    const afterTwo = createCumulativeAllocationPreview({ tracker: wholeGoal, entries: [entry('2026-01-05', 2)], metricId: 'pages', totalTarget: 10, startDate: '2026-01-05', asOfDate: '2026-01-05' })
    expect(afterTwo.days.map((day) => day.amount)).toEqual([null, 4, 4])
  })

  it('front-loads hundredths, then recalculates decimal future days after progress', () => {
    const decimalGoal: TrackerDefinition = {
      ...tracker, schemaVersion: 4, schedule: { kind: 'every-day' }, startDate: '2026-01-05', deadline: '2026-01-07',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', precision: { decimalPlaces: 2, increment: 0.01 } }],
    }
    const before = createCumulativeAllocationPreview({ tracker: decimalGoal, entries: [], metricId: 'pages', totalTarget: 1, startDate: '2026-01-05', asOfDate: '2026-01-05' })
    expect(before.days.map((day) => day.amount)).toEqual([0.34, 0.33, 0.33])
    const afterProgress = createCumulativeAllocationPreview({ tracker: decimalGoal, entries: [entry('2026-01-05', 0.5)], metricId: 'pages', totalTarget: 1, startDate: '2026-01-05', asOfDate: '2026-01-05' })
    expect(afterProgress.actualProgress).toBe(0.5)
    expect(afterProgress.days.map((day) => day.amount)).toEqual([null, 0.25, 0.25])
  })

  it('uses tenth-unit precision and excludes holidays while keeping milestone and deadline dates intact', () => {
    const tenthGoal: TrackerDefinition = {
      ...tracker, schemaVersion: 4, schedule: { kind: 'every-day' }, startDate: '2026-01-05', deadline: '2026-01-07',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', precision: { decimalPlaces: 1, increment: 0.1 } }],
      milestones: [{ id: 'draft', title: 'Draft checkpoint', description: '', metricId: 'pages', targetValue: 0.5, dueDate: '2026-01-06', position: 0 }],
    }
    const preview = createCumulativeAllocationPreview({
      tracker: tenthGoal, entries: [], metricId: 'pages', totalTarget: 1, startDate: '2026-01-05', asOfDate: '2026-01-05',
      holidays: new Set(['2026-01-06']),
    })
    expect(preview.days.map((day) => [day.date, day.amount, day.holiday])).toEqual([
      ['2026-01-05', 0.5, undefined], ['2026-01-06', null, true], ['2026-01-07', 0.5, undefined],
    ])
    expect(preview.days.every((day) => day.date <= tenthGoal.deadline!)).toBe(true)
    expect(tenthGoal.milestones[0]).toMatchObject({ dueDate: '2026-01-06', targetValue: 0.5 })
    expect(distributeTarget(1, 3, false, 0.1)).toEqual([0.4, 0.3, 0.3])
  })

  it('distributes whole-number and decimal increments exactly without impractical fractions', () => {
    const whole = distributeTarget(100, 30, false, 1)
    expect(whole).toHaveLength(30)
    expect(whole.reduce((sum, amount) => sum + amount, 0)).toBe(100)
    expect(new Set(whole)).toEqual(new Set([3, 4]))
    expect(distributeTarget(2.5, 4, false, 0.5)).toEqual([1, 0.5, 0.5, 0.5])
    expect(distributeTarget(1, 3, false, 0.25)).toEqual([0.5, 0.25, 0.25])
    const legacyRemainderPlan = distributeTarget(1.1, 2, false, 0.25)
    expect(legacyRemainderPlan).toEqual([0.75, 0.5])
    expect(summarizeAllocations(1.1, legacyRemainderPlan).overAllocation).toBeCloseTo(0.15)
  })

  it.each([
    { decimalPlaces: 0 as const, increment: 1 },
    { decimalPlaces: 1 as const, increment: 0.1 },
    { decimalPlaces: 2 as const, increment: 0.01 },
  ])('keeps generated allocation suggestions on $increment increments after recorded progress', ({ decimalPlaces, increment }) => {
    const preciseGoal: TrackerDefinition = {
      ...tracker, schemaVersion: 4,
      startDate: '2026-01-05', deadline: '2026-01-07', schedule: { kind: 'every-day' },
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', precision: { decimalPlaces, increment } }],
    }
    const preview = createCumulativeAllocationPreview({
      tracker: preciseGoal, entries: [entry('2026-01-06', 0.03)], metricId: 'pages', totalTarget: 10,
      startDate: '2026-01-06', asOfDate: '2026-01-06',
    })
    const suggestions = preview.days.filter((day) => day.eligible).map((day) => day.amount ?? 0)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.every((amount) => Math.abs(amount / increment - Math.round(amount / increment)) < 1e-8)).toBe(true)
    expect(preview.actualProgress).toBe(0.03)
    expect(preview.totalTarget).toBe(10)
  })

  it('front-loads whole questions and leaves later days at zero when there are more days than questions', () => {
    const across110Days = distributeTarget(100, 110, false, 1)
    expect(across110Days.slice(0, 100)).toEqual(Array(100).fill(1))
    expect(across110Days.slice(100)).toEqual(Array(10).fill(0))

    const across90Days = distributeTarget(100, 90, false, 1)
    expect(across90Days.slice(0, 10)).toEqual(Array(10).fill(2))
    expect(across90Days.slice(10)).toEqual(Array(80).fill(1))
    expect(across90Days.every(Number.isInteger)).toBe(true)
  })

  it('recalculates whole-unit pace as dates pass, progress is recorded, or an eligible day is missed', () => {
    const deadline = '2026-04-25'
    const wholeQuestionGoal: TrackerDefinition = {
      ...tracker,
      schedule: { kind: 'every-day' },
      startDate: '2026-01-01',
      deadline,
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'questions', precision: { decimalPlaces: 0, increment: 1 } }],
    }
    const firstDay = createCumulativeAllocationPreview({ tracker: wholeQuestionGoal, entries: [], metricId: 'pages', totalTarget: 100, startDate: '2026-01-01', asOfDate: '2026-01-01' })
    const initialEligibleDays = firstDay.days.filter((day) => day.eligible).length
    expect(initialEligibleDays).toBeGreaterThan(100)
    expect(firstDay.days.filter((day) => day.eligible).map((day) => day.amount)).toEqual([...Array(100).fill(1), ...Array(initialEligibleDays - 100).fill(0)])

    const afterProgress = createCumulativeAllocationPreview({ tracker: wholeQuestionGoal, entries: [entry('2026-01-01', 1)], metricId: 'pages', totalTarget: 100, startDate: '2026-01-01', asOfDate: '2026-01-02' })
    expect(afterProgress.remainingTarget).toBe(99)
    const progressEligibleDays = afterProgress.days.filter((day) => day.eligible).length
    expect(progressEligibleDays).toBe(initialEligibleDays - 1)
    expect(afterProgress.days.filter((day) => day.eligible).map((day) => day.amount)).toEqual([...Array(99).fill(1), ...Array(progressEligibleDays - 99).fill(0)])

    const afterMissedDay = createCumulativeAllocationPreview({ tracker: wholeQuestionGoal, entries: [], metricId: 'pages', totalTarget: 100, startDate: '2026-01-02', asOfDate: '2026-01-02' })
    expect(afterMissedDay.remainingTarget).toBe(100)
    const missedDayEligibleDays = afterMissedDay.days.filter((day) => day.eligible).length
    expect(missedDayEligibleDays).toBe(initialEligibleDays - 1)
    expect(afterMissedDay.days.filter((day) => day.eligible).map((day) => day.amount)).toEqual([...Array(100).fill(1), ...Array(missedDayEligibleDays - 100).fill(0)])
    expect(afterMissedDay.days.filter((day) => day.amount !== null).every((amount) => Number.isInteger(amount.amount))).toBe(true)
  })

  it('retains rest days in the calendar without assigning work and subtracts actual incremental progress', () => {
    const longerDeadline = { ...tracker, startDate: '2026-01-01', deadline: '2026-01-09', createdAt: '2026-01-01T00:00:00.000Z' }
    const preview = createCumulativeAllocationPreview({ tracker: longerDeadline, entries: [entry('2026-01-01', 4)], metricId: 'pages', totalTarget: 10, startDate: '2026-01-01', asOfDate: '2026-01-01' })
    expect(preview.actualProgress).toBe(4)
    expect(preview.remainingTarget).toBe(6)
    expect(preview.days.find((day) => day.date === '2026-01-03')).toMatchObject({ eligible: false, amount: null })
    expect(preview.days.find((day) => day.date === '2026-01-04')).toMatchObject({ eligible: false, amount: null })
    expect(preview.days.filter((day) => day.eligible)).toHaveLength(6)
  })

  it('reports manual shortfall and over-allocation without altering the target', () => {
    expect(summarizeAllocations(10, [2, 3])).toEqual({ plannedTotal: 5, shortfall: 5, overAllocation: 0 })
    expect(summarizeAllocations(10, [5, 7])).toEqual({ plannedTotal: 12, shortfall: 0, overAllocation: 2 })
    expect(summarizeAllocations(10, [4, 6])).toEqual({ plannedTotal: 10, shortfall: 0, overAllocation: 0 })
  })

  it('uses whole checklist items and leaves expired targets visibly unallocated', () => {
    expect(distributeTarget(10, 3, true)).toEqual([4, 3, 3])
    expect(() => distributeTarget(2.5, 2, true)).toThrow(/whole item/)
    const expired = createCumulativeAllocationPreview({ tracker, entries: [], metricId: 'pages', totalTarget: 10, startDate: '2026-01-05', asOfDate: '2026-01-08' })
    expect(expired).toMatchObject({ eligibleDayCount: 0, remainingTarget: 10, days: [] })
  })

  it('handles a completed target and invalid manual values safely', () => {
    const completed = createCumulativeAllocationPreview({ tracker, entries: [entry('2026-01-05', 12)], metricId: 'pages', totalTarget: 10, startDate: '2026-01-05', asOfDate: '2026-01-05' })
    expect(completed).toMatchObject({ actualProgress: 12, remainingTarget: 0 })
    expect(completed.days.map((day) => day.amount)).toEqual([null, 0, 0])
    const exceeded = createCumulativeAllocationPreview({ tracker, entries: [entry('2026-01-05', 12)], metricId: 'pages', totalTarget: 10, startDate: '2026-01-05', asOfDate: '2026-01-05' })
    expect(exceeded.remainingTarget).toBe(0)
    expect(exceeded.days.slice(1).map((day) => day.amount)).toEqual([0, 0])
    const behind = createCumulativeAllocationPreview({ tracker: { ...tracker, deadline: '2026-01-05' }, entries: [entry('2026-01-05', 2)], metricId: 'pages', totalTarget: 10, startDate: '2026-01-05', asOfDate: '2026-01-05' })
    expect(behind).toMatchObject({ remainingTarget: 8, eligibleDayCount: 0 })
    expect(() => distributeTarget(-1, 2)).toThrow(/finite nonnegative/)
    expect(() => summarizeAllocations(10, [Number.POSITIVE_INFINITY])).toThrow(/finite and nonnegative/)
  })
})
