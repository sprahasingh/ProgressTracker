import type { TrackerDefinition, TrackerEntry, TrackerMetricDefinition } from './types'
import { assertCalendarDate, assertDateRange } from '../../db/calendarDate'
import { evaluateTrackerEntry, isTrackerInActivePeriod, isTrackerScheduledOccurrence, trackerEvaluationHistoryStartDate } from './planning'
import { calculateStreak, qualifiesForStreak } from './progression'
import { trackerStrictModeForDate } from './ruleVersions'

export type MetricObservation = { date: string; value: number }
export type MetricAnalytics = {
  metric: TrackerMetricDefinition
  observationCount: number
  averageValue: number | null
  latestValue: number | null
  observations: MetricObservation[]
}
export type TrackerAnalytics = {
  tracker: TrackerDefinition
  entryCount: number
  historicalCount: number
  recordedCount: number
  skippedCount: number
  qualifiedCount: number
  streakQualifiedCount: number
  scheduledCount: number | null
  scheduledQualifiedCount: number | null
  consistencyPercent: number | null
  currentStreak: number
  longestStreak: number
  lifetimeEntryCount: number
  lifetimeRecordedCount: number
  lifetimeSkippedCount: number
  metrics: MetricAnalytics[]
}

const DAY_MS = 86_400_000

function dateNumber(value: string): number {
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new RangeError(`Invalid calendar date: ${value}`)
  return time
}

function entryMetricValue(metric: TrackerMetricDefinition, value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (metric.valueType === 'boolean' && typeof value === 'boolean') return value ? 1 : 0
  if (metric.valueType === 'checklist') {
    if (Array.isArray(value)) return value.filter((item) => item === true).length
    if (typeof value === 'object' && value !== null) return Object.values(value).filter((item) => item === true).length
  }
  return null
}

/** Summarizes one tracker over a date-only window without combining metric units. */
export function calculateTrackerAnalytics(
  tracker: TrackerDefinition,
  entries: readonly TrackerEntry[],
  startDate: string,
  endDate: string,
  holidays: ReadonlySet<string> = new Set(),
  timeZone?: string,
  historicalEntries: readonly TrackerEntry[] = entries,
  currentStreakAsOfDate: string = endDate,
): TrackerAnalytics {
  assertDateRange(startDate, endDate)
  assertCalendarDate(currentStreakAsOfDate)
  const latestByDate = new Map<string, TrackerEntry>()
  for (const entry of entries) {
    if (entry.trackerId !== tracker.id || entry.date < startDate || entry.date > endDate) continue
    const current = latestByDate.get(entry.date)
    if (!current || entry.updatedAt > current.updatedAt || (entry.updatedAt === current.updatedAt && entry.id > current.id)) latestByDate.set(entry.date, entry)
  }
  const allEntries = [...latestByDate.values()].filter((entry) => entry.deletedAt === null).sort((a, b) => a.date.localeCompare(b.date))
  const trackerEntries = allEntries.filter((entry) => isTrackerInActivePeriod(tracker, entry.date, timeZone))
  const historicalCount = allEntries.length - trackerEntries.length
  const recorded = trackerEntries.filter((entry) => entry.outcome === 'recorded')
  // This metric describes saved recorded outcomes; holiday exclusions apply to
  // opportunity consistency, not to whether a saved value met its rule.
  const qualifiedEntries = recorded.filter((entry) => evaluateTrackerEntry(tracker, entry).qualified)
  const activeSchedule = tracker.status === 'active' && tracker.deletedAt === null
  let scheduledCount = 0
  let scheduledQualifiedCount = 0
  let streakQualifiedCount = 0
  if (activeSchedule) {
    const trackerFirst = trackerEvaluationHistoryStartDate(tracker, timeZone)
    const firstDate = trackerFirst > startDate ? trackerFirst : startDate
    const entryByDate = new Map(trackerEntries.map((entry) => [entry.date, entry]))
    const boundedEnd = tracker.deadline && tracker.deadline < endDate ? tracker.deadline : endDate
    for (let time = dateNumber(firstDate); time <= dateNumber(boundedEnd); time += DAY_MS) {
      const date = new Date(time).toISOString().slice(0, 10)
      const opportunity = trackerStrictModeForDate(tracker, date) ? isTrackerInActivePeriod(tracker, date, timeZone) : isTrackerInActivePeriod(tracker, date, timeZone) && isTrackerScheduledOccurrence(tracker, date, timeZone) && !holidays.has(date)
      if (!opportunity) continue
      const entry = entryByDate.get(date)
      // Leave an unlogged as-of date open; it is not a missed opportunity yet.
      if (date === endDate && !entry) continue
      scheduledCount += 1
      if (entry?.outcome === 'recorded' && evaluateTrackerEntry(tracker, entry).qualified) scheduledQualifiedCount += 1
      if (entry && qualifiesForStreak(tracker, entry)) streakQualifiedCount += 1
    }
  }
  const metrics = tracker.metrics.map((metric): MetricAnalytics => {
    const observations = recorded.flatMap((entry) => {
      const value = entryMetricValue(metric, entry.values[metric.id])
      return value === null ? [] : [{ date: entry.date, value }]
    })
    const averageValue = observations.length ? observations.reduce((total, item) => total + item.value, 0) / observations.length : null
    return { metric, observationCount: observations.length, averageValue, latestValue: observations.at(-1)?.value ?? null, observations }
  })
  const latestHistoryByDate = new Map<string, TrackerEntry>()
  for (const entry of historicalEntries) {
    if (entry.trackerId !== tracker.id) continue
    const current = latestHistoryByDate.get(entry.date)
    if (!current || entry.updatedAt > current.updatedAt || (entry.updatedAt === current.updatedAt && entry.id > current.id)) latestHistoryByDate.set(entry.date, entry)
  }
  const lifetimeEntries = [...latestHistoryByDate.values()].filter((entry) =>
    entry.deletedAt === null && entry.date <= currentStreakAsOfDate && isTrackerInActivePeriod(tracker, entry.date, timeZone),
  )
  const streak = calculateStreak(tracker, [...latestHistoryByDate.values()].filter((entry) => entry.deletedAt === null), currentStreakAsOfDate, holidays, timeZone)
  return {
    tracker,
    entryCount: trackerEntries.length,
    historicalCount,
    recordedCount: recorded.length,
    skippedCount: trackerEntries.filter((entry) => entry.outcome === 'skipped').length,
    qualifiedCount: qualifiedEntries.length,
    streakQualifiedCount,
    scheduledCount: activeSchedule ? scheduledCount : null,
    scheduledQualifiedCount: activeSchedule ? scheduledQualifiedCount : null,
    consistencyPercent: activeSchedule && scheduledCount > 0 ? Math.round(scheduledQualifiedCount / scheduledCount * 100) : null,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    lifetimeEntryCount: lifetimeEntries.length,
    lifetimeRecordedCount: lifetimeEntries.filter((entry) => entry.outcome === 'recorded').length,
    lifetimeSkippedCount: lifetimeEntries.filter((entry) => entry.outcome === 'skipped').length,
    metrics,
  }
}
