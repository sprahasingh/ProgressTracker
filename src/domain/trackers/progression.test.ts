import { describe, expect, it } from 'vitest'
import { calculateAllTrackersStreak, calculateProgressRewards, calculateStreak, evaluateAllTrackersDay, evaluatePerfectPeriod, evaluateTrackerProgressionDay } from './progression'
import { evaluateTrackerEntry } from './planning'
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

  it('evaluates v8 Success and Streak Rules independently and leaves legacy rules unchanged', () => {
    const successRule = { kind: 'comparison' as const, metricId: 'pages', operator: 'at-least' as const, value: 5 }
    const streakRule = { kind: 'comparison' as const, metricId: 'pages', operator: 'at-least' as const, value: 1 }
    const streakOnlyTracker = tracker({ schemaVersion: 8, qualificationRule: successRule, streakRuleMode: 'custom', streakRule })
    const streakOnlyEntry = entry('2026-01-01', { pages: 1 })
    expect(evaluateTrackerEntry(streakOnlyTracker, streakOnlyEntry).qualified).toBe(false)
    expect(evaluateTrackerProgressionDay({ tracker: streakOnlyTracker, entries: [streakOnlyEntry], date: '2026-01-01', today: '2026-01-01' }).state).toBe('qualified')
    expect(calculateStreak(streakOnlyTracker, [streakOnlyEntry], '2026-01-01')).toMatchObject({ current: 1, longest: 1 })

    const successOnlyTracker = tracker({
      schemaVersion: 8,
      qualificationRule: streakRule,
      streakRuleMode: 'custom',
      streakRule: successRule,
    })
    const successOnlyEntry = entry('2026-01-01', { pages: 1 })
    expect(evaluateTrackerEntry(successOnlyTracker, successOnlyEntry).qualified).toBe(true)
    expect(evaluateTrackerProgressionDay({ tracker: successOnlyTracker, entries: [successOnlyEntry], date: '2026-01-01', today: '2026-01-02' }).state).toBe('failed')
    expect(calculateStreak(successOnlyTracker, [successOnlyEntry], '2026-01-02')).toMatchObject({ current: 0, longest: 0 })

    const followsSuccess = tracker({ schemaVersion: 8, qualificationRule: successRule, streakRuleMode: 'same-as-success' })
    expect(evaluateTrackerProgressionDay({ tracker: followsSuccess, entries: [streakOnlyEntry], date: '2026-01-01', today: '2026-01-02' }).state).toBe('failed')
    const legacy = tracker({ qualificationRule: undefined })
    expect(evaluateTrackerProgressionDay({ tracker: legacy, entries: [entry('2026-01-01', { pages: 2 })], date: '2026-01-01', today: '2026-01-01' }).state).toBe('qualified')
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

  it('uses configured backdated starts for verified historical streak entries', () => {
    const first = tracker({ createdAt: '2026-01-01T00:00:00.000Z', startDate: '2026-01-01' })
    const later = tracker({ id: 'later', name: 'Later', createdAt: '2026-01-03T00:00:00.000Z', startDate: '2026-01-01' })
    const laterEntries = ['2026-01-01', '2026-01-02', '2026-01-03'].map((date) => ({ ...entry(date), id: `later-${date}`, trackerId: later.id }))
    expect(calculateStreak(later, laterEntries, '2026-01-03')).toMatchObject({ current: 3, longest: 3, qualifyingCount: 3 })
    const result = calculateAllTrackersStreak({ trackers: [first, later], entries: [entry('2026-01-01'), entry('2026-01-02'), entry('2026-01-03'), ...laterEntries], asOfDate: '2026-01-03' })
    expect(result).toMatchObject({ current: 1, longest: 1, lastPerfectDate: '2026-01-03', state: 'perfect' })
  })

  it('requires all seven dates of a completed Monday-based week to be Perfect Days', () => {
    const dateList = Array.from({ length: 7 }, (_, index) => `2026-01-${String(index + 5).padStart(2, '0')}`)
    expect(evaluatePerfectPeriod({
      trackers: [tracker()], entries: dateList.map((date) => entry(date)), startDate: '2026-01-05', endDate: '2026-01-11', today: '2026-01-12',
    })).toMatchObject({ state: 'qualified', requiredDates: 7, qualifyingDates: 7 })
    expect(evaluatePerfectPeriod({
      trackers: [tracker()], entries: dateList.slice(0, 6).map((date) => entry(date)), startDate: '2026-01-05', endDate: '2026-01-11', today: '2026-01-12',
    }).state).toBe('failed')
  })

  it('uses actual month lengths including February and leap years', () => {
    const cases = [
      { start: '2026-02-01', days: 28 }, { start: '2024-02-01', days: 29 },
      { start: '2026-04-01', days: 30 }, { start: '2026-01-01', days: 31 },
    ]
    for (const { start, days } of cases) {
      const from = Date.parse(`${start}T00:00:00.000Z`)
      const dates = Array.from({ length: days }, (_, index) => new Date(from + index * 86_400_000).toISOString().slice(0, 10))
      const end = dates.at(-1)!
      const today = new Date(from + days * 86_400_000).toISOString().slice(0, 10)
      const periodTracker = tracker({ startDate: start, createdAt: `${start}T00:00:00.000Z`, updatedAt: `${start}T00:00:00.000Z` })
      expect(evaluatePerfectPeriod({ trackers: [periodTracker], entries: dates.map((date) => entry(date)), startDate: start, endDate: end, today })).toMatchObject({ state: 'qualified', requiredDates: days, qualifyingDates: days })
    }
  })

  it('requires every date of a 365 or 366 day year and rejects neutral, missed, and holiday dates', () => {
    for (const { start, days } of [{ start: '2025-01-01', days: 365 }, { start: '2024-01-01', days: 366 }]) {
      const from = Date.parse(`${start}T00:00:00.000Z`)
      const dates = Array.from({ length: days }, (_, index) => new Date(from + index * 86_400_000).toISOString().slice(0, 10))
      const end = dates.at(-1)!
      const today = new Date(from + days * 86_400_000).toISOString().slice(0, 10)
      const periodTracker = tracker({ startDate: start, createdAt: `${start}T00:00:00.000Z`, updatedAt: `${start}T00:00:00.000Z` })
      expect(evaluatePerfectPeriod({ trackers: [periodTracker], entries: dates.map((date) => entry(date)), startDate: start, endDate: end, today })).toMatchObject({ state: 'qualified', requiredDates: days, qualifyingDates: days })
      expect(evaluatePerfectPeriod({ trackers: [periodTracker], entries: dates.slice(1).map((date) => entry(date)), startDate: start, endDate: end, today })).toMatchObject({ state: 'failed', qualifyingDates: days - 1 })
    }
    const weekEntries = Array.from({ length: 7 }, (_, index) => entry(`2026-01-${String(index + 5).padStart(2, '0')}`))
    expect(evaluatePerfectPeriod({ trackers: [tracker()], entries: weekEntries, startDate: '2026-01-05', endDate: '2026-01-11', today: '2026-01-12', holidays: new Set(['2026-01-08']) }).state).toBe('failed')
    expect(evaluatePerfectPeriod({ trackers: [tracker({ schedule: { kind: 'specific-dates', dates: ['2026-01-05'] } })], entries: [entry('2026-01-05')], startDate: '2026-01-05', endDate: '2026-01-11', today: '2026-01-12' }).state).toBe('failed')
  })

  it('uses configured success thresholds rather than stricter streak rules, and returns incomplete or unsupported honestly', () => {
    const trackerWithTargetStreak = tracker({ metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', thresholds: { direction: 'increase', minimum: 2, target: 5, streakQualification: 'target' } }] })
    const dates = Array.from({ length: 7 }, (_, index) => `2026-01-${String(index + 5).padStart(2, '0')}`)
    const entries = dates.map((date) => entry(date, { pages: 2 }))
    expect(evaluatePerfectPeriod({ trackers: [trackerWithTargetStreak], entries, startDate: dates[0]!, endDate: dates[6]!, today: '2026-01-12' }).state).toBe('qualified')
    expect(evaluatePerfectPeriod({ trackers: [tracker()], entries, startDate: dates[0]!, endDate: dates[6]!, today: '2026-01-11' }).state).toBe('incomplete')
    const revised = tracker({ updatedAt: '2026-01-08T00:00:00.000Z' })
    expect(evaluatePerfectPeriod({ trackers: [revised], entries, startDate: dates[0]!, endDate: dates[6]!, today: '2026-01-12' }).state).toBe('unsupported')
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
