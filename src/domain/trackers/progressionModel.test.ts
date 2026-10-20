import { describe, expect, it } from 'vitest'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calculateProgressionLevel, estimateProvisionalCheckInReward, getAchievementEligibility, PROGRESSION_ACHIEVEMENTS, PROGRESSION_REWARDS, selectProvisionalRewards, summarizeProgression, xpRequiredForLevel } from './progressionModel'

const provisionalTracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'provisional-habit', name: 'Read', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: '2026-10-01',
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
  qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true }, customFields: [], milestones: [],
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}
const provisionalEntry: StoredTrackerEntry = {
  id: 'pending-entry', trackerId: provisionalTracker.id, date: '2026-10-12', outcome: 'recorded', values: { done: true }, note: '',
  createdAt: '2026-10-12T12:00:00.000Z', updatedAt: '2026-10-12T12:00:00.000Z', deletedAt: null,
}

describe('progression policy and summaries', () => {
  it('keeps the stable achievement definitions free of a duplicate client cadence list', () => {
    expect(PROGRESSION_ACHIEVEMENTS.map(({ id }) => id)).toEqual([
      'first-step', 'momentum', 'first-flame', 'steady-flame', 'unstoppable', 'century',
      'perfect-day', 'perfect-week', 'milestone-maker', 'goal-crusher', 'consistency-star',
      'dedicated', 'perfect-month', 'perfect-year', 'the-comeback',
    ])
    expect(PROGRESSION_ACHIEVEMENTS.some((achievement) => 'repeatable' in achievement || 'awardCadence' in achievement)).toBe(false)
  })

  it('estimates only pending qualifying local activity and keeps provisional IDs stable', () => {
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: provisionalEntry, pendingSync: true, today: '2026-10-13' }))
      .toEqual({ id: 'check-in:pending-entry', effectiveDate: '2026-10-12', xpDelta: 10 })
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: provisionalEntry, pendingSync: false, today: '2026-10-13' })).toBeNull()
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: { ...provisionalEntry, outcome: 'skipped' }, pendingSync: true, today: '2026-10-13' })).toBeNull()
    expect(estimateProvisionalCheckInReward({ tracker: { ...provisionalTracker, status: 'archived' }, entry: provisionalEntry, pendingSync: true, today: '2026-10-13' })).toBeNull()
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: { ...provisionalEntry, date: '2026-10-14' }, pendingSync: true, today: '2026-10-13' })).toBeNull()
  })

  it('awards provisional XP for qualifying holiday work but not zero or skipped activity', () => {
    const holiday = new Set([provisionalEntry.date])
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: provisionalEntry, pendingSync: true, today: '2026-10-13', holidays: holiday }))
      .toEqual({ id: 'check-in:pending-entry', effectiveDate: provisionalEntry.date, xpDelta: 10 })
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: provisionalEntry, pendingSync: true, today: '2026-10-13', trackerHolidays: [{ trackerId: provisionalTracker.id, date: provisionalEntry.date }] }))
      .toEqual({ id: 'check-in:pending-entry', effectiveDate: provisionalEntry.date, xpDelta: 10 })
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: { ...provisionalEntry, values: { done: false } }, pendingSync: true, today: '2026-10-13', holidays: holiday })).toBeNull()
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: { ...provisionalEntry, outcome: 'skipped' }, pendingSync: true, today: '2026-10-13', holidays: holiday })).toBeNull()
  })

  it('estimates daily success XP from the Success Rule and ignores streak-only qualification', () => {
    const mixed: StoredTrackerDefinition = {
      ...provisionalTracker,
      schemaVersion: 8,
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', thresholds: { direction: 'increase', minimum: 1, streakQualification: 'minimum' } }],
      qualificationRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 5 },
      streakRuleMode: 'custom',
      streakRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 1 },
    }
    const partial = { ...provisionalEntry, trackerId: mixed.id, values: { pages: 1 } }
    expect(estimateProvisionalCheckInReward({ tracker: mixed, entry: partial, pendingSync: true, today: '2026-10-13' })).toBeNull()

    const successOnly: StoredTrackerDefinition = {
      ...mixed,
      qualificationRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 1 },
      streakRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 5 },
    }
    expect(estimateProvisionalCheckInReward({ tracker: successOnly, entry: partial, pendingSync: true, today: '2026-10-13' }))
      .toMatchObject({ id: 'check-in:pending-entry', xpDelta: 10 })
  })

  it('deduplicates pending entries and excludes missing tracker references', () => {
    expect(selectProvisionalRewards({
      trackers: [provisionalTracker], entries: [provisionalEntry, provisionalEntry, { ...provisionalEntry, id: 'orphan', trackerId: 'missing' }],
      pendingEntryIds: new Set(['pending-entry', 'orphan']), today: '2026-10-13',
    })).toEqual([{ id: 'check-in:pending-entry', effectiveDate: '2026-10-12', xpDelta: 10 }])
  })

  it('centralizes the versioned reward values', () => {
    expect(PROGRESSION_REWARDS).toMatchObject({
      checkIn: 10,
      perfectDay: 20,
      streakMilestones: [{ days: 7, xp: 35 }, { days: 14, xp: 50 }, { days: 30, xp: 100 }, { days: 100, xp: 200 }],
      goalMilestone: 25,
      goalCompleted: 100,
    })
  })

  it('calculates integer level thresholds and progress at boundaries', () => {
    expect(xpRequiredForLevel(1)).toBe(0)
    expect(xpRequiredForLevel(2)).toBe(100)
    expect(xpRequiredForLevel(3)).toBe(300)
    expect(calculateProgressionLevel(299)).toMatchObject({ level: 2, currentLevelXp: 100, nextLevelXp: 300, progressXp: 199, requiredXp: 200 })
    expect(calculateProgressionLevel(300)).toMatchObject({ level: 3, progressXp: 0, requiredXp: 300 })
    expect(() => calculateProgressionLevel(-1)).toThrow(RangeError)
  })

  it('keeps the quadratic thresholds stable through level 20 and recalculates on net XP reversals', () => {
    const thresholds = Array.from({ length: 20 }, (_, index) => 50 * index * (index + 1))
    expect(thresholds).toEqual([0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500, 5500, 6600, 7800, 9100, 10500, 12000, 13600, 15300, 17100, 19000])
    thresholds.forEach((xp, index) => expect(calculateProgressionLevel(xp).level).toBe(index + 1))
    expect(calculateProgressionLevel(100 - 10)).toMatchObject({ level: 1, progressXp: 90 })
    expect(calculateProgressionLevel(Number.MAX_SAFE_INTEGER).nextLevelXp).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('keeps provisional XP separate from authoritative lifetime XP and reports period reversals', () => {
    const summary = summarizeProgression({
      events: [
        { id: 'a', effectiveDate: '2026-10-10', xpDelta: 10 },
        { id: 'b', effectiveDate: '2026-10-11', xpDelta: 20 },
        { id: 'c', effectiveDate: '2026-10-11', xpDelta: -10 },
      ],
      provisionalRewards: [{ id: 'pending', effectiveDate: '2026-10-11', xpDelta: 10 }],
      periodStart: '2026-10-11',
      periodEnd: '2026-10-11',
    })
    expect(summary).toMatchObject({ lifetimeXp: 20, provisionalXp: 10, periodNetXp: 10, periodEarnedXp: 20, periodReversedXp: -10 })
  })

  it('does not unlock consistency without thirty eligible completed dates', () => {
    const facts = { qualifyingCheckIns: 1, longestStreak: 0, perfectDays: 0, perfectWeeks: 0, goalMilestones: 0, completedGoals: 0, consistencyScore: 100, completedConsistencyDays: 29 }
    expect(getAchievementEligibility(facts).find((item) => item.id === 'consistency-star')).toMatchObject({ eligible: false, progress: 80, target: 80 })
    expect(getAchievementEligibility({ ...facts, completedConsistencyDays: 30 }).find((item) => item.id === 'consistency-star')).toMatchObject({ eligible: true })
  })

  it('only marks achievements eligible when their authoritative facts meet their criteria', () => {
    const facts = { qualifyingCheckIns: 100, longestStreak: 100, perfectDays: 1, perfectWeeks: 1, goalMilestones: 1, completedGoals: 1, consistencyScore: null, completedConsistencyDays: 0, perfectMonths: 2, perfectYears: 1, comebacks: 3 }
    expect(getAchievementEligibility(facts).filter((item) => item.eligible).map((item) => item.id)).toEqual([
      'first-step', 'momentum', 'first-flame', 'steady-flame', 'unstoppable', 'century', 'perfect-day', 'perfect-week', 'milestone-maker', 'goal-crusher', 'dedicated', 'perfect-month', 'perfect-year', 'the-comeback',
    ])
  })
})
