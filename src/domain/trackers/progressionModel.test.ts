import { describe, expect, it } from 'vitest'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calculateProgressionLevel, estimateProvisionalCheckInReward, getAchievementEligibility, PROGRESSION_REWARDS, selectProvisionalRewards, summarizeProgression, xpRequiredForLevel } from './progressionModel'

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
  it('estimates only pending qualifying local activity and keeps provisional IDs stable', () => {
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: provisionalEntry, pendingSync: true, today: '2026-10-13' }))
      .toEqual({ id: 'check-in:pending-entry', effectiveDate: '2026-10-12', xpDelta: 10 })
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: provisionalEntry, pendingSync: false, today: '2026-10-13' })).toBeNull()
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: { ...provisionalEntry, outcome: 'skipped' }, pendingSync: true, today: '2026-10-13' })).toBeNull()
    expect(estimateProvisionalCheckInReward({ tracker: { ...provisionalTracker, status: 'archived' }, entry: provisionalEntry, pendingSync: true, today: '2026-10-13' })).toBeNull()
    expect(estimateProvisionalCheckInReward({ tracker: provisionalTracker, entry: { ...provisionalEntry, date: '2026-10-14' }, pendingSync: true, today: '2026-10-13' })).toBeNull()
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
    const facts = { qualifyingCheckIns: 100, longestStreak: 100, perfectDays: 1, perfectWeeks: 1, goalMilestones: 1, completedGoals: 1, consistencyScore: null, completedConsistencyDays: 0 }
    expect(getAchievementEligibility(facts).filter((item) => item.eligible).map((item) => item.id)).toEqual([
      'first-step', 'momentum', 'first-flame', 'steady-flame', 'unstoppable', 'century', 'perfect-day', 'perfect-week', 'milestone-maker', 'goal-crusher', 'dedicated',
    ])
  })
})
