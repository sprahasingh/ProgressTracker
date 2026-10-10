import type { TrackerDefinition, TrackerEntry, TrackerMetricDefinition, TrackerRule, TrackerValue } from './types'
import { classifyAchievement, evaluateTrackerEntry, isTrackerScheduledOccurrence } from './planning'

export type StreakResult = {
  asOfDate: string
  current: number
  longest: number
  lastQualifiedDate: string | null
  qualifyingCount: number
  scheduledCount: number
  missedCount: number
}

export type RewardPolicy = {
  pointsPerQualifiedEntry: number
  streakMilestones: number[]
  pointsPerStreakMilestone: number
}

export type ProgressRewards = {
  totalPoints: number
  qualifyingEntries: number
  earnedMilestones: Array<{ id: string; streak: number; points: number }>
}

export const DEFAULT_REWARD_POLICY: Readonly<RewardPolicy> = {
  pointsPerQualifiedEntry: 10,
  streakMilestones: [3, 7, 14, 30, 60, 100],
  pointsPerStreakMilestone: 25,
}

type Occurrence = { date: string; qualified: boolean; open: boolean }

const DAY_MS = 86_400_000
const parseDate = (value: string): number => {
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new RangeError(`Invalid calendar date: ${value}`)
  return time
}
const dateText = (time: number): string => new Date(time).toISOString().slice(0, 10)

function metricHasQualifyingValue(metric: TrackerMetricDefinition, value: TrackerValue | undefined): boolean {
  if (value === undefined || value === null) return false
  if (metric.valueType === 'boolean') return value === true
  if (metric.valueType === 'quantity' || metric.valueType === 'duration') return typeof value === 'number' && Number.isFinite(value) && value >= 0
  return Array.isArray(value) || (typeof value === 'object' && value !== null)
}

export function qualifiesForStreak(tracker: TrackerDefinition, entry: TrackerEntry): boolean {
  if (entry.outcome !== 'recorded') return false
  const metricQualifies = (metric: TrackerMetricDefinition): boolean => {
    const value = entry.values[metric.id]
    if (metric.valueType === 'boolean') return value === true
    const qualification = metric.thresholds?.streakQualification
    if (qualification === 'any-recorded-value' || !qualification) {
      // Preserve the established completion fallback: thresholded metrics need
      // at least their first achievement level; unthresholded metrics need a value.
      return metricHasQualifyingValue(metric, value)
    }
    const achieved = classifyAchievement(metric, value)
    const ranks = { none: 0, minimum: 1, target: 2, stretch: 3 }
    return ranks[achieved] >= (qualification === 'target' ? ranks.target : ranks.minimum)
  }
  if (!tracker.qualificationRule) return tracker.metrics[0] ? metricQualifies(tracker.metrics[0]) : false
  const metrics = new Map(tracker.metrics.map((metric) => [metric.id, metric]))
  const evaluate = (rule: TrackerRule): boolean => {
    if (rule.kind === 'all') return rule.operands.every(evaluate)
    if (rule.kind === 'any') return rule.operands.some(evaluate)
    if (rule.kind === 'at-least') return rule.operands.filter(evaluate).length >= rule.required
    if (rule.kind === 'threshold') {
      const metric = metrics.get(rule.metricId)
      return metric ? metricQualifies(metric) : false
    }
    if (rule.kind === 'comparison') {
      const metric = metrics.get(rule.metricId)
      const hasMinimum = metric?.thresholds?.minimum !== undefined
      return (!hasMinimum || metricQualifies(metric!)) && evaluateTrackerEntry(tracker, entry).achievedMetricIds.includes(rule.metricId)
    }
    return false
  }
  return evaluate(tracker.qualificationRule)
}

function buildOccurrences(tracker: TrackerDefinition, entries: readonly TrackerEntry[], asOfDate: string, holidays: ReadonlySet<string>): Occurrence[] {
  const boundedEnd = tracker.deadline && tracker.deadline < asOfDate ? tracker.deadline : asOfDate
  const end = parseDate(boundedEnd)
  const byDate = new Map<string, TrackerEntry>()
  for (const entry of entries) {
    parseDate(entry.date)
    if (entry.trackerId !== tracker.id) throw new RangeError(`Entry ${entry.id} belongs to a different tracker.`)
    if (entry.date > boundedEnd || entry.deletedAt !== null) continue
    if (byDate.has(entry.date)) throw new RangeError(`More than one live entry exists for ${entry.date}.`)
    byDate.set(entry.date, entry)
  }

  const createdDate = tracker.createdAt.slice(0, 10)
  const anchor = tracker.startDate && tracker.startDate > createdDate ? tracker.startDate : createdDate
  const start = parseDate(anchor)
  const occurrences: Occurrence[] = []
  for (let time = start; time <= end; time += DAY_MS) {
    const date = dateText(time)
    const strict = tracker.strictMode === true
    if (!strict && (!isTrackerScheduledOccurrence(tracker, date) || holidays.has(date))) continue
    const entry = byDate.get(date)
    const qualified = entry ? qualifiesForStreak(tracker, entry) : false
    occurrences.push({ date, qualified, open: date === asOfDate && (!entry || (entry.outcome === 'recorded' && !qualified)) })
  }
  return occurrences
}

/**
 * Counts qualifying scheduled occurrences. Holidays and rest days pause the
 * run: they neither add to it nor reset it. A missed scheduled occurrence
 * resets the current run, not the personal best.
 */
export function calculateStreak(tracker: TrackerDefinition, entries: readonly TrackerEntry[], asOfDate: string, holidays: ReadonlySet<string> = new Set()): StreakResult {
  parseDate(asOfDate)
  const occurrences = buildOccurrences(tracker, entries, asOfDate, holidays)
  let longest = 0
  let run = 0
  let qualifyingCount = 0
  let missedCount = 0
  let lastQualifiedDate: string | null = null
  for (const occurrence of occurrences) {
    if (occurrence.qualified) {
      run += 1
      qualifyingCount += 1
      longest = Math.max(longest, run)
      lastQualifiedDate = occurrence.date
    } else {
      run = 0
      // An unlogged current opportunity is still open; it is not a miss until the day passes.
      if (!occurrence.open) missedCount += 1
    }
  }

  let current = run
  const todayOccurrence = occurrences.at(-1)
  if (todayOccurrence?.date === asOfDate && todayOccurrence.open) {
    current = 0
    for (let index = occurrences.length - 2; index >= 0; index -= 1) {
      const occurrence = occurrences[index]!
      if (!occurrence.qualified) break
      current += 1
    }
  }

  return { asOfDate, current, longest, lastQualifiedDate, qualifyingCount, scheduledCount: occurrences.length, missedCount }
}

/** Produces a reproducible reward summary. Missed days do not subtract earned points or streak badges. */
export function calculateProgressRewards(streak: StreakResult, policy: RewardPolicy = DEFAULT_REWARD_POLICY): ProgressRewards {
  if (!Number.isSafeInteger(streak.qualifyingCount) || streak.qualifyingCount < 0) throw new RangeError('Qualifying entry count must be a nonnegative safe integer.')
  if (!Number.isFinite(policy.pointsPerQualifiedEntry) || policy.pointsPerQualifiedEntry < 0 || !Number.isFinite(policy.pointsPerStreakMilestone) || policy.pointsPerStreakMilestone < 0) throw new RangeError('Reward points must be finite and nonnegative.')
  const milestones = [...policy.streakMilestones].sort((a, b) => a - b)
  if (milestones.some((value, index) => !Number.isSafeInteger(value) || value <= 0 || (index > 0 && value === milestones[index - 1]))) throw new RangeError('Streak milestones must be unique positive safe integers.')
  const earnedMilestones = milestones.filter((milestone) => streak.longest >= milestone).map((milestone) => ({ id: `streak-${milestone}`, streak: milestone, points: policy.pointsPerStreakMilestone }))
  const milestonePoints = earnedMilestones.reduce((sum, milestone) => sum + milestone.points, 0)
  return {
    totalPoints: streak.qualifyingCount * policy.pointsPerQualifiedEntry + milestonePoints,
    qualifyingEntries: streak.qualifyingCount,
    earnedMilestones,
  }
}
