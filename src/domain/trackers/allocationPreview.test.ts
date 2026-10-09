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
      { date: '2026-01-05', eligible: true, amount: 3.33 },
      { date: '2026-01-06', eligible: true, amount: 3.33 },
      { date: '2026-01-07', eligible: true, amount: 3.34 },
    ])
    expect(preview.days.reduce((total, day) => total + (day.amount ?? 0), 0)).toBe(10)
    expect(distributeTarget(1.005, 2)).toEqual([0.502, 0.503])
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

  it('retains rest days in the calendar without assigning work and subtracts actual incremental progress', () => {
    const longerDeadline = { ...tracker, startDate: '2026-01-01', deadline: '2026-01-09', createdAt: '2026-01-01T00:00:00.000Z' }
    const preview = createCumulativeAllocationPreview({ tracker: longerDeadline, entries: [entry('2026-01-01', 4)], metricId: 'pages', totalTarget: 10, startDate: '2026-01-01', asOfDate: '2026-01-01' })
    expect(preview.actualProgress).toBe(4)
    expect(preview.remainingTarget).toBe(6)
    expect(preview.days.find((day) => day.date === '2026-01-03')).toMatchObject({ eligible: false, amount: null })
    expect(preview.days.find((day) => day.date === '2026-01-04')).toMatchObject({ eligible: false, amount: null })
    expect(preview.days.filter((day) => day.eligible)).toHaveLength(7)
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
    expect(completed.days.map((day) => day.amount)).toEqual([0, 0, 0])
    expect(() => distributeTarget(-1, 2)).toThrow(/finite nonnegative/)
    expect(() => summarizeAllocations(10, [Number.POSITIVE_INFINITY])).toThrow(/finite and nonnegative/)
  })
})
