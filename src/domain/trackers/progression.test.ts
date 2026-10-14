import { describe, expect, it } from 'vitest'
import { calculateAllTrackersStreak, calculateProgressRewards, calculateStreak, evaluateAllTrackersDay, evaluatePerfectPeriod, evaluateTrackerProgressionDay } from './progression'
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

  it('derives an elapsed missing opportunity while keeping the current date open, then recalculates a backdated correction', () => {
    const successful = ['2026-10-08', '2026-10-09', '2026-10-10'].map((date) => entry(date))
    const overdue = calculateStreak(tracker({ startDate: '2026-10-08' }), successful, '2026-10-12')
    expect(overdue).toMatchObject({ current: 0, longest: 3, scheduledCount: 5, missedCount: 1 })

    const corrected = calculateStreak(tracker({ startDate: '2026-10-08' }), [...successful, entry('2026-10-11')], '2026-10-12')
    expect(corrected).toMatchObject({ current: 4, longest: 4, scheduledCount: 5, missedCount: 0 })
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

  it('requires the configured minimum, preserves today while progress is still open, and breaks past below-minimum runs', () => {
    const belowMinimum = tracker({ qualificationRule: undefined })
    const day1 = entry('2026-01-01', { pages: 2 })
    const partialBelow = entry('2026-01-02', { pages: 1 })
    expect(calculateStreak(belowMinimum, [day1, partialBelow], '2026-01-03')).toMatchObject({ current: 0, longest: 1, missedCount: 1 })
    expect(calculateStreak(belowMinimum, [day1, entry('2026-01-02', { pages: 2 })], '2026-01-02')).toMatchObject({ current: 2, qualifyingCount: 2, missedCount: 0 })
    expect(calculateStreak(belowMinimum, [day1, entry('2026-01-02', { pages: 1 })], '2026-01-02')).toMatchObject({ current: 1, qualifyingCount: 1, missedCount: 0 })
  })

  it('keeps an incomplete current-day value open without extending the streak until it qualifies', () => {
    const configured = tracker({ qualificationRule: undefined })
    const result = calculateStreak(configured, [entry('2026-01-01'), entry('2026-01-02'), entry('2026-01-03', { pages: 1 })], '2026-01-03')
    expect(result).toMatchObject({ current: 2, longest: 2, qualifyingCount: 2, missedCount: 0 })
  })

  it('retains boolean success rules and does not create a streak from exempt days alone', () => {
    const yesNo = tracker({
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
      qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
    })
    const booleanEntry = (date: string, done: boolean): TrackerEntry => ({ ...entry(date, { pages: 0 }), values: { done } })
    expect(calculateStreak(yesNo, [booleanEntry('2026-01-01', true)], '2026-01-02', new Set(['2026-01-02']))).toMatchObject({ current: 1, longest: 1, qualifyingCount: 1 })
    expect(calculateStreak(yesNo, [], '2026-01-03', new Set(['2026-01-01', '2026-01-02', '2026-01-03']))).toMatchObject({ current: 0, longest: 0, qualifyingCount: 0, missedCount: 0 })
    expect(calculateStreak(yesNo, [booleanEntry('2026-01-01', false)], '2026-01-01')).toMatchObject({ current: 0, missedCount: 0 })
  })

  it('makes holidays and rest dates required only in Strict Mode', () => {
    const weekdays = tracker({ startDate: '2026-01-09', deadline: '2026-01-12', schedule: { kind: 'weekdays' } })
    const holiday = new Set(['2026-01-12'])
    expect(calculateStreak(weekdays, [entry('2026-01-09')], '2026-01-12', holiday)).toMatchObject({ current: 1, scheduledCount: 1, missedCount: 0 })
    const strict = { ...weekdays, strictMode: true }
    expect(calculateStreak(strict, [entry('2026-01-09')], '2026-01-12', holiday)).toMatchObject({ current: 0, scheduledCount: 4, missedCount: 2 })
    expect(calculateStreak(strict, [entry('2026-01-09'), entry('2026-01-10'), entry('2026-01-11'), entry('2026-01-12')], '2026-01-12', holiday)).toMatchObject({ current: 4, longest: 4, scheduledCount: 4 })
  })

  it('keeps an incomplete strict day open, then breaks on the next elapsed day, and ignores dates after deadline', () => {
    const strict = tracker({ strictMode: true, schedule: { kind: 'weekdays' }, startDate: '2026-01-09', deadline: '2026-01-10' })
    expect(calculateStreak(strict, [entry('2026-01-09')], '2026-01-10')).toMatchObject({ current: 1, missedCount: 0, scheduledCount: 2 })
    expect(calculateStreak(strict, [entry('2026-01-09')], '2026-01-11')).toMatchObject({ current: 0, missedCount: 1, scheduledCount: 2 })
    expect(calculateStreak(strict, [entry('2026-01-09'), entry('2026-01-10')], '2026-01-15')).toMatchObject({ current: 2, longest: 2, scheduledCount: 2 })
  })

  it('does not count recorded numeric zero as streak progress under the default rule', () => {
    const zeroTracker = tracker({ qualificationRule: undefined, metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' }] })
    expect(calculateStreak(zeroTracker, [entry('2026-01-01', { pages: 0 })], '2026-01-01').qualifyingCount).toBe(0)
    expect(calculateStreak(zeroTracker, [entry('2026-01-01', { pages: 1 })], '2026-01-01').qualifyingCount).toBe(1)
  })

  it('keeps an explicitly defined zero threshold meaningful for streak qualification', () => {
    const zeroTracker = tracker({
      qualificationRule: { kind: 'threshold', metricId: 'pages', level: 'minimum' },
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', thresholds: { direction: 'decrease', minimum: 0, streakQualification: 'minimum' } }],
    })
    expect(calculateStreak(zeroTracker, [entry('2026-01-01', { pages: 0 })], '2026-01-01').qualifyingCount).toBe(1)
  })

  it('starts a new run after intentional legacy skips and handles year boundaries', () => {
    const definition = tracker({ startDate: '2026-12-30' })
    const skip = { ...entry('2026-12-31'), outcome: 'skipped' as const, values: {} }
    expect(calculateStreak(definition, [entry('2026-12-30'), skip, entry('2027-01-01')], '2027-01-01')).toMatchObject({ current: 1, longest: 1, qualifyingCount: 2, missedCount: 1 })
  })

  it('honors tracker start and deadline dates and advances dates safely across DST boundaries', () => {
    const bounded = tracker({ startDate: '2026-03-07', deadline: '2026-03-09' })
    const springDates = ['2026-03-07', '2026-03-08', '2026-03-09']
    const result = calculateStreak(bounded, springDates.map((date) => entry(date)), '2026-03-10')
    expect(result).toMatchObject({ current: 3, longest: 3, qualifyingCount: 3, scheduledCount: 3, missedCount: 0 })
    expect(calculateStreak(bounded, [entry('2026-03-07')], '2026-03-10')).toMatchObject({ scheduledCount: 3, missedCount: 2, current: 0 })
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

describe('shared progression day evaluator', () => {
  it('distinguishes qualifying partial progress, pending, a saved skip, and a finalized miss', () => {
    const minimum = tracker({ qualificationRule: undefined })
    expect(evaluateTrackerProgressionDay({ tracker: minimum, entries: [entry('2026-01-01', { pages: 2 })], date: '2026-01-01', today: '2026-01-03' }).state).toBe('qualified')
    expect(evaluateTrackerProgressionDay({ tracker: minimum, entries: [entry('2026-01-01', { pages: 1 })], date: '2026-01-01', today: '2026-01-03' }).state).toBe('failed')
    expect(evaluateTrackerProgressionDay({ tracker: minimum, entries: [], date: '2026-01-03', today: '2026-01-03' }).state).toBe('pending')
    expect(evaluateTrackerProgressionDay({ tracker: minimum, entries: [{ ...entry('2026-01-01'), outcome: 'skipped' }], date: '2026-01-01', today: '2026-01-03' }).state).toBe('failed')
    expect(evaluateTrackerProgressionDay({ tracker: minimum, entries: [], date: '2026-01-01', today: '2026-01-03' }).state).toBe('failed')
  })

  it('makes holidays and rest dates neutral in Standard Mode and required in Strict Mode', () => {
    const weekday = tracker({ startDate: '2026-01-09', schedule: { kind: 'weekdays' } })
    const date = '2026-01-10'
    const common = { entries: [], date, today: date, holidays: new Set([date]) }
    expect(evaluateTrackerProgressionDay({ ...common, tracker: weekday }).state).toBe('neutral')
    expect(evaluateTrackerProgressionDay({ ...common, tracker: { ...weekday, strictMode: true } }).state).toBe('pending')
    expect(evaluateTrackerProgressionDay({ ...common, tracker: weekday, entries: [{ ...entry(date), outcome: 'skipped' }] }).state).toBe('neutral')
  })

  it('qualifies an account Perfect Day only when every required tracker qualifies', () => {
    const first = tracker()
    const second = tracker({ id: 'second', name: 'Second', schedule: { kind: 'weekdays' } })
    const third = tracker({ id: 'third', name: 'Third' })
    const date = '2026-01-10'
    const entries = [entry(date), { ...entry(date), id: 'second-entry', trackerId: second.id }, { ...entry(date), id: 'third-entry', trackerId: third.id }]
    const evaluated = evaluateAllTrackersDay({ trackers: [first, second, third], entries, date, today: date })
    expect(evaluated).toMatchObject({ state: 'perfect', requiredTrackerIds: [first.id, third.id], failedTrackerIds: [], pendingTrackerIds: [] })
    expect(evaluateAllTrackersDay({ trackers: [first, second, third], entries: entries.map((item) => item.trackerId === third.id ? { ...item, outcome: 'skipped' as const } : item), date, today: date }).state).toBe('failed')
  })

  it('does not count pending required trackers as Perfect Days, but reports a known failure first', () => {
    const first = tracker()
    const second = tracker({ id: 'second', name: 'Second' })
    const date = '2026-01-03'
    expect(evaluateAllTrackersDay({ trackers: [first, second], entries: [entry(date)], date, today: date })).toMatchObject({ state: 'pending', pendingTrackerIds: ['second'] })
    expect(evaluateAllTrackersDay({ trackers: [first, second], entries: [{ ...entry(date), outcome: 'skipped' }], date, today: date }).state).toBe('failed')
  })

  it('keeps All Trackers streak separate and pauses it on neutral dates', () => {
    const first = tracker({ startDate: '2026-01-01', schedule: { kind: 'weekdays' } })
    const second = tracker({ id: 'second', name: 'Second', startDate: '2026-01-01', schedule: { kind: 'weekdays' } })
    const dates = ['2026-01-05', '2026-01-06']
    const entries = dates.flatMap((date) => [entry(date), { ...entry(date), id: `second-${date}`, trackerId: second.id }])
    const result = calculateAllTrackersStreak({ trackers: [first, second], entries, asOfDate: '2026-01-07', holidays: new Set(['2026-01-07']) })
    expect(result).toMatchObject({ current: 2, longest: 2, lastPerfectDate: '2026-01-06', state: 'neutral' })
    const broken = calculateAllTrackersStreak({ trackers: [first, second], entries: [...entries, { ...entry('2026-01-07'), outcome: 'skipped' }], asOfDate: '2026-01-07' })
    expect(broken.current).toBe(0)
    expect(calculateAllTrackersStreak({ trackers: [], entries: [], asOfDate: '2026-01-07' })).toMatchObject({ current: 0, longest: 0, state: 'neutral' })
  })

  it('ignores a tracker before its creation date and does not let its later failure erase earlier history', () => {
    const first = tracker({ createdAt: '2026-01-01T00:00:00.000Z', startDate: '2026-01-01' })
    const later = tracker({ id: 'later', name: 'Later', createdAt: '2026-01-03T00:00:00.000Z', startDate: '2026-01-03' })
    const result = calculateAllTrackersStreak({ trackers: [first, later], entries: [entry('2026-01-01'), entry('2026-01-02'), entry('2026-01-03'), { ...entry('2026-01-03'), id: 'later-jan3', trackerId: later.id }], asOfDate: '2026-01-03' })
    expect(result).toMatchObject({ current: 1, longest: 1, lastPerfectDate: '2026-01-03', state: 'perfect' })
  })

  it('qualifies a completed week with three required dates and neutral Standard Mode holidays', () => {
    const dateList = ['2026-01-05', '2026-01-06', '2026-01-07']
    expect(evaluatePerfectPeriod({
      trackers: [tracker({ schedule: { kind: 'weekdays' } })], entries: dateList.map((date) => entry(date)), startDate: '2026-01-05', endDate: '2026-01-11',
      today: '2026-01-12', minimumRequiredDates: 3, holidays: new Set(['2026-01-08', '2026-01-09']),
    })).toMatchObject({ state: 'qualified', requiredDates: 3, qualifyingDates: 3 })
    expect(evaluatePerfectPeriod({
      trackers: [tracker({ schedule: { kind: 'specific-dates', dates: dateList.slice(0, 2) } })], entries: dateList.slice(0, 2).map((date) => entry(date)), startDate: '2026-01-05', endDate: '2026-01-11',
      today: '2026-01-12', minimumRequiredDates: 3,
    }).state).toBe('insufficient')
  })

  it('requires Strict Mode holiday opportunities and at least twelve required dates in a month', () => {
    const dates = Array.from({ length: 14 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`)
    const holidays = new Set(['2026-01-06', '2026-01-07'])
    expect(evaluatePerfectPeriod({
      trackers: [tracker({ schedule: { kind: 'specific-dates', dates } })], entries: dates.map((date) => entry(date)), startDate: '2026-01-01', endDate: '2026-01-31',
      today: '2026-02-01', minimumRequiredDates: 12, holidays,
    }).state).toBe('qualified')
    expect(evaluatePerfectPeriod({
      trackers: [tracker({ strictMode: true })], entries: Array.from({ length: 31 }, (_, index) => entry(`2026-01-${String(index + 1).padStart(2, '0')}`)).filter((item) => item.date !== '2026-01-06'), startDate: '2026-01-01', endDate: '2026-01-31',
      today: '2026-02-01', minimumRequiredDates: 12, holidays,
    }).state).toBe('failed')
    const elevenDates = dates.slice(0, 11)
    expect(evaluatePerfectPeriod({
      trackers: [tracker({ schedule: { kind: 'specific-dates', dates: elevenDates } })], entries: elevenDates.map((date) => entry(date)), startDate: '2026-01-01', endDate: '2026-01-31',
      today: '2026-02-01', minimumRequiredDates: 12,
    }).state).toBe('insufficient')
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
