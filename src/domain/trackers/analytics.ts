import type { TrackerDefinition, TrackerEntry, TrackerMetricDefinition } from './types'
import { assertDateRange } from '../../db/calendarDate'
import { evaluateTrackerEntry, isTrackerInActivePeriod, isTrackerScheduledOccurrence } from './planning'
import { qualifiesForStreak } from './progression'

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
  recordedCount: number
  skippedCount: number
  qualifiedCount: number
  scheduledCount: number | null
  scheduledQualifiedCount: number | null
  consistencyPercent: number | null
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
): TrackerAnalytics {
  assertDateRange(startDate, endDate)
  const latestByDate = new Map<string, TrackerEntry>()
  for (const entry of entries) {
    if (entry.trackerId !== tracker.id || entry.date < startDate || entry.date > endDate) continue
    const current = latestByDate.get(entry.date)
    if (!current || entry.updatedAt > current.updatedAt || (entry.updatedAt === current.updatedAt && entry.id > current.id)) latestByDate.set(entry.date, entry)
  }
  const trackerEntries = [...latestByDate.values()].filter((entry) => entry.deletedAt === null).sort((a, b) => a.date.localeCompare(b.date))
  const recorded = trackerEntries.filter((entry) => entry.outcome === 'recorded')
  const qualifiedEntries = recorded.filter((entry) => !holidays.has(entry.date) && evaluateTrackerEntry(tracker, entry).qualified)
  const activeSchedule = tracker.status === 'active' && tracker.deletedAt === null
  let scheduledCount = 0
  let scheduledQualifiedCount = 0
  if (activeSchedule) {
    const createdDay = tracker.createdAt.slice(0, 10)
    const trackerFirst = tracker.startDate && tracker.startDate > createdDay ? tracker.startDate : createdDay
    const firstDate = trackerFirst > startDate ? trackerFirst : startDate
    const entryByDate = new Map(trackerEntries.map((entry) => [entry.date, entry]))
    const boundedEnd = tracker.deadline && tracker.deadline < endDate ? tracker.deadline : endDate
    for (let time = dateNumber(firstDate); time <= dateNumber(boundedEnd); time += DAY_MS) {
      const date = new Date(time).toISOString().slice(0, 10)
      const opportunity = tracker.strictMode === true ? isTrackerInActivePeriod(tracker, date) : isTrackerInActivePeriod(tracker, date) && isTrackerScheduledOccurrence(tracker, date) && !holidays.has(date)
      if (!opportunity) continue
      const entry = entryByDate.get(date)
      // Leave an unlogged as-of date open; it is not a missed opportunity yet.
      if (date === endDate && !entry) continue
      scheduledCount += 1
      if (entry && (tracker.strictMode ? qualifiesForStreak(tracker, entry) : entry.outcome === 'recorded' && evaluateTrackerEntry(tracker, entry).qualified)) scheduledQualifiedCount += 1
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
  return {
    tracker,
    entryCount: trackerEntries.length,
    recordedCount: recorded.length,
    skippedCount: trackerEntries.filter((entry) => entry.outcome === 'skipped').length,
    qualifiedCount: qualifiedEntries.length,
    scheduledCount: activeSchedule ? scheduledCount : null,
    scheduledQualifiedCount: activeSchedule ? scheduledQualifiedCount : null,
    consistencyPercent: activeSchedule && scheduledCount > 0 ? Math.round(scheduledQualifiedCount / scheduledCount * 100) : null,
    metrics,
  }
}
