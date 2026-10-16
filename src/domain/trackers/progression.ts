import type { TrackerDefinition, TrackerEntry, TrackerMetricDefinition, TrackerRule, TrackerValue } from './types'
import { activeTrackerMetrics } from './types'
import { classifyAchievement, evaluateQualificationRule, evaluateTrackerEntry, isTrackerInActivePeriod, isTrackerScheduledOccurrence, trackerActiveStartDate, trackerCreationDate } from './planning'

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

export type ProgressionOpportunityState = 'qualified' | 'failed' | 'pending' | 'neutral' | 'future' | 'outside-period' | 'inactive'
export type TrackerProgressionDay = { trackerId: string; date: string; state: ProgressionOpportunityState; required: boolean }
export type AccountDayQualification = 'perfect' | 'failed' | 'pending' | 'neutral' | 'future' | 'unsupported'

/** Daily Perfect Day qualification mirrors the server's configured success rule, not streak thresholds. */
export function evaluateAllTrackersPerfectDay(input: {
  trackers: readonly TrackerDefinition[]
  entries: readonly TrackerEntry[]
  date: string
  today: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): { date: string; state: AccountDayQualification; eligibleTrackerIds: string[]; failedTrackerIds: string[]; pendingTrackerIds: string[] } {
  parseDate(input.date)
  parseDate(input.today)
  const eligible = input.trackers.filter((tracker) => {
    if (tracker.deletedAt !== null || !['active', 'archived', 'completed'].includes(tracker.status)) return false
    if (tracker.status === 'archived' && tracker.archivedAt && input.date > tracker.archivedAt.slice(0, 10)) return false
    if (!isTrackerInActivePeriod(tracker, input.date, input.timeZone)) return false
    return tracker.strictMode === true || (!input.holidays?.has(input.date) && isTrackerScheduledOccurrence(tracker, input.date, input.timeZone))
  })
  const reliableFrom = input.trackers.filter((tracker) => tracker.deletedAt === null && ['active', 'archived', 'completed'].includes(tracker.status))
    .map((tracker) => {
      const created = trackerCreationDate(tracker, input.timeZone)
      const updated = tracker.updatedAt.slice(0, 10)
      return updated > created ? updated : created
    }).sort().at(-1)
  if (reliableFrom && input.date < reliableFrom) return { date: input.date, state: 'unsupported', eligibleTrackerIds: [], failedTrackerIds: [], pendingTrackerIds: [] }
  if (input.date > input.today) return { date: input.date, state: 'future', eligibleTrackerIds: [], failedTrackerIds: [], pendingTrackerIds: [] }
  const failed: string[] = []
  const pending: string[] = []
  const positiveTarget = eligible.some((tracker) => {
    const metrics = activeTrackerMetrics(tracker.metrics)
    const dayEntry = input.entries.find((candidate) => candidate.trackerId === tracker.id && candidate.date === input.date && candidate.deletedAt === null)
    return metrics.some((metric) => {
      if (metric.valueType === 'boolean' || Object.values(metric.thresholds ?? {}).some((value) => typeof value === 'number' && value > 0)) return true
      if (metric.thresholds || dayEntry?.outcome !== 'recorded') return false
      const value = dayEntry.values[metric.id]
      return typeof value === 'number' ? value > 0
        : Array.isArray(value) ? value.some((item) => item === true)
          : typeof value === 'object' && value !== null ? Object.values(value).some((item) => item === true) : false
    })
  })
  for (const tracker of eligible) {
    const entry = input.entries.find((candidate) => candidate.trackerId === tracker.id && candidate.date === input.date && candidate.deletedAt === null)
    if (!entry || entry.outcome !== 'recorded' || !evaluateTrackerEntry(tracker, entry).qualified) {
      if (input.date === input.today && (!entry || entry.outcome === 'recorded')) pending.push(tracker.id)
      else failed.push(tracker.id)
    }
  }
  const state: AccountDayQualification = !eligible.length || !positiveTarget ? 'neutral'
    : failed.length ? 'failed'
      : pending.length ? 'pending'
        : 'perfect'
  return { date: input.date, state, eligibleTrackerIds: eligible.map((tracker) => tracker.id), failedTrackerIds: failed, pendingTrackerIds: pending }
}

/** The single client-side decision point for whether a tracker/date advances progression. */
export function evaluateTrackerProgressionDay(input: {
  tracker: TrackerDefinition
  entries: readonly TrackerEntry[]
  date: string
  today: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): TrackerProgressionDay {
  const { tracker, date, today } = input
  parseDate(date)
  parseDate(today)
  const dayEntries = input.entries.filter((candidate) => candidate.trackerId === tracker.id && candidate.date === date && candidate.deletedAt === null)
  if (dayEntries.length > 1) throw new RangeError(`More than one live entry exists for ${date}.`)
  const entry = dayEntries[0]
  if (date > today) return { trackerId: tracker.id, date, state: 'future', required: false }
  if (!isTrackerInActivePeriod(tracker, date, input.timeZone)) return { trackerId: tracker.id, date, state: 'outside-period', required: false }
  if (tracker.status !== 'active' && tracker.status !== 'archived' && tracker.status !== 'completed') return { trackerId: tracker.id, date, state: 'inactive', required: false }

  const strict = tracker.strictMode === true
  const neutral = !strict && (input.holidays?.has(date) || !isTrackerScheduledOccurrence(tracker, date, input.timeZone))
  // Existing saved activity remains visible, but an ineligible date never earns progression.
  if (neutral) return { trackerId: tracker.id, date, state: 'neutral', required: false }
  if (entry?.outcome === 'skipped') return { trackerId: tracker.id, date, state: 'failed', required: true }
  if (entry?.outcome === 'recorded') {
    const qualified = qualifiesForStreak(tracker, entry)
    return { trackerId: tracker.id, date, state: qualified ? 'qualified' : date === today ? 'pending' : 'failed', required: true }
  }
  return { trackerId: tracker.id, date, state: date === today ? 'pending' : 'failed', required: true }
}

/** Account streak is a run of Perfect Days, never an aggregation of tracker streak lengths. */
export function evaluateAllTrackersDay(input: {
  trackers: readonly TrackerDefinition[]
  entries: readonly TrackerEntry[]
  date: string
  today: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): { date: string; state: AccountDayQualification; requiredTrackerIds: string[]; failedTrackerIds: string[]; pendingTrackerIds: string[] } {
  const results = input.trackers
    .filter((tracker) => tracker.deletedAt === null && (tracker.status === 'active' || tracker.status === 'archived' || tracker.status === 'completed'))
    .filter((tracker) => dateIsAtOrAfterTrackerStart(tracker, input.date, input.timeZone))
    .filter((tracker) => tracker.status !== 'archived' || !tracker.archivedAt || input.date <= tracker.archivedAt.slice(0, 10))
    .map((tracker) => evaluateTrackerProgressionDay({ ...input, tracker, entries: input.entries.filter((entry) => entry.trackerId === tracker.id) }))
  const reliableFrom = input.trackers
    .filter((tracker) => tracker.deletedAt === null && (tracker.status === 'active' || tracker.status === 'archived' || tracker.status === 'completed'))
    .map((tracker) => {
      const created = trackerCreationDate(tracker, input.timeZone)
      const updated = tracker.updatedAt.slice(0, 10)
      return updated > created ? updated : created
    })
    .sort()
    .at(-1)
  if (reliableFrom && input.date < reliableFrom) return { date: input.date, state: 'unsupported', requiredTrackerIds: [], failedTrackerIds: [], pendingTrackerIds: [] }
  if (results.some((item) => item.state === 'future')) return { date: input.date, state: 'future', requiredTrackerIds: [], failedTrackerIds: [], pendingTrackerIds: [] }
  const required = results.filter((item) => item.required)
  const failedTrackerIds = required.filter((item) => item.state === 'failed').map((item) => item.trackerId)
  const pendingTrackerIds = required.filter((item) => item.state === 'pending').map((item) => item.trackerId)
  const state: AccountDayQualification = required.length === 0 ? 'neutral'
    : failedTrackerIds.length > 0 ? 'failed'
      : pendingTrackerIds.length > 0 ? 'pending'
        : 'perfect'
  return { date: input.date, state, requiredTrackerIds: required.map((item) => item.trackerId), failedTrackerIds, pendingTrackerIds }
}

export type AccountStreakResult = { current: number; longest: number; lastPerfectDate: string | null; state: AccountDayQualification }

export function calculateAllTrackersStreak(input: {
  trackers: readonly TrackerDefinition[]
  entries: readonly TrackerEntry[]
  asOfDate: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): AccountStreakResult {
  const relevant = input.trackers.filter((tracker) => (tracker.status === 'active' || tracker.status === 'archived' || tracker.status === 'completed') && tracker.deletedAt === null)
  if (!relevant.length) return { current: 0, longest: 0, lastPerfectDate: null, state: 'neutral' }
  // Current definitions cannot reconstruct earlier membership or schedules. Start at the latest known definition boundary.
  const startDates = relevant.map((tracker) => {
    const created = trackerCreationDate(tracker, input.timeZone)
    const changed = tracker.updatedAt.slice(0, 10)
    return [trackerActiveStartDate(tracker, input.timeZone), changed > created ? changed : created].sort().at(-1)!
  }).sort()
  const start = parseDate(startDates.at(-1)!)
  const end = parseDate(input.asOfDate)
  let run = 0
  let longest = 0
  let lastPerfectDate: string | null = null
  let currentState: AccountDayQualification = 'neutral'
  for (let time = start; time <= end; time += DAY_MS) {
    const date = dateText(time)
    const result = evaluateAllTrackersDay({ ...input, date, today: input.asOfDate })
    currentState = result.state
    if (result.state === 'perfect') {
      run += 1
      longest = Math.max(longest, run)
      lastPerfectDate = date
    } else if (result.state === 'failed') run = 0
    // Neutral and pending days do not add or break the confirmed run.
  }
  return { current: run, longest, lastPerfectDate, state: currentState }
}

export type PerfectPeriodResult = { state: 'qualified' | 'failed' | 'insufficient' | 'incomplete' | 'unsupported'; requiredDates: number; qualifyingDates: number }

/** Evaluates a fully elapsed calendar period: every local date must be a Perfect Day. */
export function evaluatePerfectPeriod(input: {
  trackers: readonly TrackerDefinition[]
  entries: readonly TrackerEntry[]
  startDate: string
  endDate: string
  today: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): PerfectPeriodResult {
  const start = parseDate(input.startDate)
  const end = parseDate(input.endDate)
  const today = parseDate(input.today)
  if (end >= today) return { state: 'incomplete', requiredDates: 0, qualifyingDates: 0 }
  const requiredDates = (end - start) / DAY_MS + 1
  let qualifyingDates = 0
  let failed = false
  for (let time = start; time <= end; time += DAY_MS) {
    const result = evaluateAllTrackersPerfectDay({ ...input, date: dateText(time) })
    if (result.state === 'unsupported') return { state: 'unsupported', requiredDates, qualifyingDates }
    if (result.state === 'pending' || result.state === 'future') return { state: 'incomplete', requiredDates, qualifyingDates }
    if (result.state === 'perfect') {
      qualifyingDates += 1
    } else failed = true
  }
  if (failed) return { state: 'failed', requiredDates, qualifyingDates }
  return qualifyingDates === requiredDates
    ? { state: 'qualified', requiredDates, qualifyingDates }
    : { state: 'insufficient', requiredDates, qualifyingDates }
}

const DAY_MS = 86_400_000
const parseDate = (value: string): number => {
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new RangeError(`Invalid calendar date: ${value}`)
  return time
}
const dateText = (time: number): string => new Date(time).toISOString().slice(0, 10)

function dateIsAtOrAfterTrackerStart(tracker: TrackerDefinition, date: string, timeZone?: string): boolean {
  return date >= trackerActiveStartDate(tracker, timeZone)
}

function metricHasQualifyingValue(metric: TrackerMetricDefinition, value: TrackerValue | undefined): boolean {
  if (value === undefined || value === null) return false
  if (metric.valueType === 'boolean') return value === true
  if (metric.valueType === 'quantity' || metric.valueType === 'duration') return typeof value === 'number' && Number.isFinite(value) && value > 0
  if (metric.valueType === 'checklist') {
    if (Array.isArray(value)) return value.some((item) => item === true)
    return typeof value === 'object' && value !== null && Object.values(value).some((item) => item === true)
  }
  return false
}

function qualifiesForLegacyStreak(tracker: TrackerDefinition, entry: TrackerEntry): boolean {
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
  const activeMetrics = activeTrackerMetrics(tracker.metrics)
  if (!tracker.qualificationRule) return activeMetrics[0] ? metricQualifies(activeMetrics[0]) : false
  const metrics = new Map(activeMetrics.map((metric) => [metric.id, metric]))
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

/** Daily success and streak qualification are independent for schema-v8 trackers. */
export function qualifiesForStreak(tracker: TrackerDefinition, entry: TrackerEntry): boolean {
  if (entry.outcome !== 'recorded') return false
  if (tracker.streakRuleMode === 'same-as-success') return evaluateTrackerEntry(tracker, entry).qualified
  if (tracker.streakRuleMode === 'custom') {
    return tracker.streakRule !== undefined && evaluateQualificationRule(tracker.streakRule, activeTrackerMetrics(tracker.metrics), entry.values).qualified
  }
  // Definitions through v7 keep their original, implicit streak interpretation.
  return qualifiesForLegacyStreak(tracker, entry)
}

function buildOccurrences(tracker: TrackerDefinition, entries: readonly TrackerEntry[], asOfDate: string, holidays: ReadonlySet<string>, timeZone?: string): Array<{ date: string; state: ProgressionOpportunityState }> {
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

  const anchor = trackerActiveStartDate(tracker, timeZone)
  const start = parseDate(anchor)
  const occurrences: Array<{ date: string; state: ProgressionOpportunityState }> = []
  for (let time = start; time <= end; time += DAY_MS) {
    const date = dateText(time)
    const entry = byDate.get(date)
    const result = evaluateTrackerProgressionDay({ tracker, entries: entry ? [entry] : [], date, today: asOfDate, holidays, timeZone })
    occurrences.push({ date, state: result.state })
  }
  return occurrences
}

/**
 * Counts qualifying scheduled occurrences. Holidays and rest days pause the
 * run: they neither add to it nor reset it. A missed scheduled occurrence
 * resets the current run, not the personal best.
 */
export function calculateStreak(tracker: TrackerDefinition, entries: readonly TrackerEntry[], asOfDate: string, holidays: ReadonlySet<string> = new Set(), timeZone?: string): StreakResult {
  parseDate(asOfDate)
  const occurrences = buildOccurrences(tracker, entries, asOfDate, holidays, timeZone)
  let longest = 0
  let run = 0
  let qualifyingCount = 0
  let missedCount = 0
  let lastQualifiedDate: string | null = null
  for (const occurrence of occurrences) {
    if (occurrence.state === 'qualified') {
      run += 1
      qualifyingCount += 1
      longest = Math.max(longest, run)
      lastQualifiedDate = occurrence.date
    } else if (occurrence.state === 'failed') {
      run = 0
      missedCount += 1
    } else {
      // Pending, neutral, and inapplicable dates preserve the confirmed streak.
    }
  }

  const current = run
  // A pending current opportunity does not prematurely erase the last confirmed run.

  return { asOfDate, current, longest, lastQualifiedDate, qualifyingCount,
    scheduledCount: occurrences.filter((item) => item.state === 'qualified' || item.state === 'failed' || item.state === 'pending').length,
    missedCount }
}

/** Returns the first local date on which this tracker ever reached a streak length. */
export function firstDateAtStreakLength(tracker: TrackerDefinition, entries: readonly TrackerEntry[], target: number, asOfDate: string, holidays: ReadonlySet<string> = new Set(), timeZone?: string): string | null {
  if (!Number.isSafeInteger(target) || target <= 0) throw new RangeError('Streak target must be a positive whole number.')
  let run = 0
  for (const occurrence of buildOccurrences(tracker, entries, asOfDate, holidays, timeZone)) {
    if (occurrence.state === 'qualified') {
      run += 1
      if (run >= target) return occurrence.date
    } else if (occurrence.state === 'failed') run = 0
  }
  return null
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
