import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { isTrackerInActivePeriod, isTrackerScheduledOccurrence } from './planning'
import { qualifiesForStreak } from './progression'

export const PROGRESSION_SCORING_VERSION = 2

export const PROGRESSION_REWARDS = {
  checkIn: 10,
  perfectDay: 20,
  streakMilestones: [
    { days: 7, xp: 35 },
    { days: 14, xp: 50 },
    { days: 30, xp: 100 },
    { days: 100, xp: 200 },
  ],
  goalMilestone: 25,
  goalCompleted: 100,
} as const

export type ProgressionLedgerEvent = { id: string; effectiveDate: string; xpDelta: number }
export type ProvisionalReward = { id: string; effectiveDate: string; xpDelta: number }

export function estimateProvisionalCheckInReward(input: {
  tracker: StoredTrackerDefinition
  entry: StoredTrackerEntry
  pendingSync: boolean
  today: string
  timeZone?: string
  holidays?: ReadonlySet<string>
}): ProvisionalReward | null {
  const { tracker, entry } = input
  if (!input.pendingSync || entry.deletedAt !== null || entry.outcome !== 'recorded' || entry.date > input.today) return null
  if (tracker.id !== entry.trackerId || tracker.deletedAt !== null || tracker.status !== 'active') return null
  if (!isTrackerInActivePeriod(tracker, entry.date, input.timeZone)) return null
  if (tracker.strictMode !== true && (input.holidays?.has(entry.date) || !isTrackerScheduledOccurrence(tracker, entry.date, input.timeZone))) return null
  if (!qualifiesForStreak(tracker, entry)) return null
  return { id: `check-in:${entry.id}`, effectiveDate: entry.date, xpDelta: PROGRESSION_REWARDS.checkIn }
}

export function selectProvisionalRewards(input: {
  trackers: readonly StoredTrackerDefinition[]
  entries: readonly StoredTrackerEntry[]
  pendingEntryIds: ReadonlySet<string>
  today: string
  timeZone?: string
  holidays?: ReadonlySet<string>
}): ProvisionalReward[] {
  const trackerById = new Map(input.trackers.map((tracker) => [tracker.id, tracker]))
  const seen = new Set<string>()
  const rewards: ProvisionalReward[] = []
  for (const entry of input.entries) {
    if (!input.pendingEntryIds.has(entry.id) || seen.has(entry.id)) continue
    seen.add(entry.id)
    const tracker = trackerById.get(entry.trackerId)
    if (!tracker) continue
    const reward = estimateProvisionalCheckInReward({ ...input, tracker, entry, pendingSync: true })
    if (reward) rewards.push(reward)
  }
  return rewards
}

export type ProgressionLevel = {
  level: number
  currentLevelXp: number
  nextLevelXp: number
  progressXp: number
  requiredXp: number
}

/** XP needed to reach a level: 0, 100, 300, 600, ... */
export function xpRequiredForLevel(level: number): number {
  if (!Number.isSafeInteger(level) || level < 1) throw new RangeError('Level must be a positive integer.')
  const xp = 50 * (level - 1) * level
  if (!Number.isSafeInteger(xp)) throw new RangeError('Level is outside the supported XP range.')
  return xp
}

export function calculateProgressionLevel(confirmedXp: number): ProgressionLevel {
  if (!Number.isSafeInteger(confirmedXp) || confirmedXp < 0) throw new RangeError('Confirmed XP must be a nonnegative safe integer.')
  let level = 1
  let upper = Math.max(2, Math.ceil((1 + Math.sqrt(1 + confirmedXp / 12.5)) / 2) + 1)
  while (level + 1 < upper) {
    const middle = Math.floor((level + upper) / 2)
    if (50 * (middle - 1) * middle <= confirmedXp) level = middle
    else upper = middle
  }
  const currentLevelXp = xpRequiredForLevel(level)
  const nextLevelXp = xpRequiredForLevel(level + 1)
  return { level, currentLevelXp, nextLevelXp, progressXp: confirmedXp - currentLevelXp, requiredXp: nextLevelXp - currentLevelXp }
}

function inPeriod(date: string, startDate?: string, endDate?: string): boolean {
  return (!startDate || date >= startDate) && (!endDate || date <= endDate)
}

export function summarizeProgression(input: {
  events: readonly ProgressionLedgerEvent[]
  provisionalRewards?: readonly ProvisionalReward[]
  periodStart?: string
  periodEnd?: string
}) {
  const lifetimeXp = input.events.reduce((sum, event) => sum + event.xpDelta, 0)
  if (!Number.isSafeInteger(lifetimeXp) || lifetimeXp < 0) throw new RangeError('The authoritative ledger must have a nonnegative safe-integer total.')
  const periodEvents = input.events.filter((event) => inPeriod(event.effectiveDate, input.periodStart, input.periodEnd))
  const provisionalRewards = (input.provisionalRewards ?? []).filter((reward) => inPeriod(reward.effectiveDate, input.periodStart, input.periodEnd))
  return {
    lifetimeXp,
    level: calculateProgressionLevel(lifetimeXp),
    provisionalXp: provisionalRewards.reduce((sum, reward) => sum + reward.xpDelta, 0),
    periodNetXp: periodEvents.reduce((sum, event) => sum + event.xpDelta, 0),
    periodReversedXp: periodEvents.reduce((sum, event) => sum + Math.min(0, event.xpDelta), 0),
    periodEarnedXp: periodEvents.reduce((sum, event) => sum + Math.max(0, event.xpDelta), 0),
  }
}

export type AchievementFacts = {
  qualifyingCheckIns: number
  longestStreak: number
  perfectDays: number
  perfectWeeks: number
  goalMilestones: number
  completedGoals: number
  consistencyScore: number | null
  completedConsistencyDays: number
  perfectMonths?: number
  comebacks?: number
}

export const PROGRESSION_ACHIEVEMENTS = [
  { id: 'first-step', name: 'First Step', field: 'qualifyingCheckIns', target: 1 },
  { id: 'momentum', name: 'Momentum', field: 'longestStreak', target: 3 },
  { id: 'first-flame', name: 'First Flame', field: 'longestStreak', target: 7 },
  { id: 'steady-flame', name: 'Steady Flame', field: 'longestStreak', target: 14 },
  { id: 'unstoppable', name: 'Unstoppable', field: 'longestStreak', target: 30 },
  { id: 'century', name: 'Century', field: 'longestStreak', target: 100 },
  { id: 'perfect-day', name: 'Perfect Day', field: 'perfectDays', target: 1 },
  { id: 'perfect-week', name: 'Perfect Week', field: 'perfectWeeks', target: 1 },
  { id: 'milestone-maker', name: 'Milestone Maker', field: 'goalMilestones', target: 1 },
  { id: 'goal-crusher', name: 'Goal Crusher', field: 'completedGoals', target: 1 },
  { id: 'consistency-star', name: 'Consistency Star', field: 'consistencyScore', target: 80, minimumDays: 30 },
  { id: 'dedicated', name: 'Dedicated', field: 'qualifyingCheckIns', target: 100 },
  { id: 'perfect-month', name: 'Perfect Month', field: 'perfectMonths', target: 1 },
  { id: 'the-comeback', name: 'The Comeback', field: 'comebacks', target: 1 },
] as const

export function getAchievementEligibility(facts: AchievementFacts) {
  return PROGRESSION_ACHIEVEMENTS.map((achievement) => {
    const value = facts[achievement.field]
    const eligible = achievement.field === 'consistencyScore'
      ? facts.completedConsistencyDays >= achievement.minimumDays && value !== null && value !== undefined && value >= achievement.target
      : (value ?? 0) >= achievement.target
    return { id: achievement.id, name: achievement.name, eligible, progress: Math.min(value ?? 0, achievement.target), target: achievement.target }
  })
}
