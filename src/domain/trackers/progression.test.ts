import { describe, expect, it } from 'vitest'
import { calculateProgressRewards, calculateStreak } from './progression'
import type { TrackerDefinition, TrackerEntry } from './types'

const tracker = (overrides: Partial<TrackerDefinition> = {}): TrackerDefinition => ({
  schemaVersion: 1, id: 'streak-tracker', name: 'Daily practice', description: '', kind: 'challenge', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: '2026-01-01',
  metrics: [
    { id: 'pages', name: 'Pages', valueType: 'quantity', thresholds: { direction: 'increase', minimum: 2, target: 5, streakQualification: 'minimum' } },
    { id: 'minutes', name: 'Minutes', valueType: 'duration', thresholds: { direction: 'increase', minimum: 10, target: 30, streakQualification: 'minimum' } },
  ], customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
  ...overrides,
})

const entry = (date: string, values: Record<string, number | boolean> = { pages: 2 }): TrackerEntry => ({
  id: `entry-${date}`, trackerId: 'streak-tracker', date, outcome: 'recorded', values, note: '',
  createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, deletedAt: null,
})

describe('streak calculation', () => {
  it('keeps an unlogged current opportunity open and counts scheduled dates only', () => {
    const result = calculateStreak(tracker(), [entry('2026-01-01'), entry('2026-01-02')], '2026-01-03')
    expect(result).toMatchObject({ current: 2, longest: 2, qualifyingCount: 2, scheduledCount: 3, missedCount: 0, lastQualifiedDate: '2026-01-02' })
  })

  it('does not break streaks for rest days and observes weekday schedules', () => {
    const weekdays = tracker({ startDate: '2026-01-09', schedule: { kind: 'weekdays' } })
    const result = calculateStreak(weekdays, [entry('2026-01-09'), entry('2026-01-12')], '2026-01-12')
    expect(result).toMatchObject({ current: 2, longest: 2, scheduledCount: 2, missedCount: 0 })
  })

  it('resets current streak after misses or skips while preserving the personal best', () => {
    const missed = calculateStreak(tracker(), [entry('2026-01-01'), entry('2026-01-02'), entry('2026-01-04')], '2026-01-04')
    expect(missed).toMatchObject({ current: 1, longest: 2, missedCount: 1 })
    const skipped = { ...entry('2026-01-03'), outcome: 'skipped' as const, values: {} }
    expect(calculateStreak(tracker(), [entry('2026-01-01'), entry('2026-01-02'), skipped], '2026-01-03')).toMatchObject({ current: 0, longest: 2, missedCount: 1 })
  })

  it('uses configured streak thresholds, multi-metric qualification, and ignores tombstones', () => {
    const targetThreshold = tracker({ qualificationRule: undefined, metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', thresholds: { direction: 'increase', minimum: 2, target: 5, streakQualification: 'target' } }] })
    expect(calculateStreak(targetThreshold, [entry('2026-01-01', { pages: 3 })], '2026-01-01').qualifyingCount).toBe(0)
    expect(calculateStreak(targetThreshold, [entry('2026-01-01', { pages: 5 })], '2026-01-01').qualifyingCount).toBe(1)
    const targetRule = tracker({
      qualificationRule: { kind: 'all', operands: [
        { kind: 'threshold', metricId: 'pages', level: 'target' },
        { kind: 'threshold', metricId: 'minutes', level: 'minimum' },
      ] },
    })
    const result = calculateStreak(targetRule, [
      entry('2026-01-01', { pages: 5, minutes: 10 }),
      entry('2026-01-02', { pages: 5, minutes: 2 }),
      { ...entry('2026-01-03'), deletedAt: '2026-01-04T00:00:00.000Z' },
    ], '2026-01-03')
    expect(result).toMatchObject({ current: 0, longest: 1, qualifyingCount: 1, missedCount: 1 })
  })

  it('can evaluate retained history after a tracker is completed or archived', () => {
    const completed = tracker({ status: 'completed', archivedAt: '2026-01-03T00:00:00.000Z' })
    expect(calculateStreak(completed, [entry('2026-01-01')], '2026-01-01').current).toBe(1)
  })

  it('rejects ambiguous or invalid entry input instead of producing unstable results', () => {
    expect(() => calculateStreak(tracker(), [entry('2026-01-01'), entry('2026-01-01')], '2026-01-01')).toThrow(/More than one/)
    expect(() => calculateStreak(tracker(), [{ ...entry('2026-01-01'), trackerId: 'other' }], '2026-01-01')).toThrow(/different tracker/)
    expect(() => calculateStreak(tracker(), [], '2026-02-30')).toThrow(/Invalid calendar date/)
  })
})

describe('progress rewards', () => {
  it('calculates retained-entry points and one-time personal-best milestone rewards', () => {
    const result = calculateStreak(tracker(), [entry('2026-01-01'), entry('2026-01-02'), entry('2026-01-03')], '2026-01-04')
    expect(calculateProgressRewards(result).earnedMilestones.map((milestone) => milestone.streak)).toEqual([3])
    expect(calculateProgressRewards(result)).toEqual({ totalPoints: 55, qualifyingEntries: 3, earnedMilestones: [{ id: 'streak-3', streak: 3, points: 25 }] })
    const later = calculateStreak(tracker(), [entry('2026-01-01'), entry('2026-01-02'), entry('2026-01-03'), entry('2026-01-05')], '2026-01-05')
    expect(later.current).toBe(1)
    expect(calculateProgressRewards(later).totalPoints).toBe(65)
  })

  it('validates custom reward policies', () => {
    const streak = calculateStreak(tracker(), [entry('2026-01-01')], '2026-01-01')
    expect(calculateProgressRewards(streak, { pointsPerQualifiedEntry: 2, streakMilestones: [1, 4], pointsPerStreakMilestone: 7 })).toEqual({ totalPoints: 9, qualifyingEntries: 1, earnedMilestones: [{ id: 'streak-1', streak: 1, points: 7 }] })
    expect(() => calculateProgressRewards(streak, { pointsPerQualifiedEntry: -1, streakMilestones: [], pointsPerStreakMilestone: 1 })).toThrow(/finite and nonnegative/)
    expect(() => calculateProgressRewards(streak, { pointsPerQualifiedEntry: 1, streakMilestones: [2, 2], pointsPerStreakMilestone: 1 })).toThrow(/unique positive/)
  })
})
