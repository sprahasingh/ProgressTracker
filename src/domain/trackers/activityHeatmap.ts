import type { TrackerDefinition, TrackerEntry } from './types'
import { isTrackerInActivePeriod, isTrackerScheduledOccurrence } from './planning'
import { qualifiesForStreak } from './progression'

export type HeatmapDay = { date: string; eligibleCount: number; qualifiedCount: number; percent: number | null; level: 0 | 1 | 2 | 3 | 4 | 5 | 6; holiday: boolean; restCount: number }

/** Normalizes daily qualifying check-ins by each tracker’s own opportunity policy. */
export function calculateActivityHeatmap(input: {
  trackers: readonly TrackerDefinition[]; entries: readonly TrackerEntry[]; startDate: string; endDate: string; holidays?: ReadonlySet<string>
}): HeatmapDay[] {
  const live = input.trackers.filter((tracker) => tracker.status === 'active' && tracker.deletedAt === null)
  const entriesByTrackerDate = new Map(input.entries.filter((entry) => entry.deletedAt === null).map((entry) => [`${entry.trackerId}:${entry.date}`, entry]))
  const days: HeatmapDay[] = []
  for (let time = parse(input.startDate); time <= parse(input.endDate); time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10)
    let eligibleCount = 0, qualifiedCount = 0, restCount = 0
    for (const tracker of live) {
      const inRange = isTrackerInActivePeriod(tracker, date)
      const scheduled = inRange && isTrackerScheduledOccurrence(tracker, date)
      if (inRange && !scheduled) restCount += 1
      const opportunity = inRange && (tracker.strictMode === true || (!input.holidays?.has(date) && scheduled))
      if (!opportunity) continue
      eligibleCount += 1
      const entry = entriesByTrackerDate.get(`${tracker.id}:${date}`)
      if (entry && qualifiesForStreak(tracker, entry)) qualifiedCount += 1
    }
    const percent = eligibleCount ? Math.round(qualifiedCount / eligibleCount * 100) : null
    const level: HeatmapDay['level'] = percent === null ? 0 : percent === 0 ? 1 : percent <= 25 ? 2 : percent <= 50 ? 3 : percent <= 75 ? 4 : percent < 100 ? 5 : 6
    days.push({ date, eligibleCount, qualifiedCount, percent, level, holiday: input.holidays?.has(date) ?? false, restCount })
  }
  return days
}

function parse(date: string): number {
  const time = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new RangeError(`Invalid calendar date: ${date}`)
  return time
}
