import type { TrackerDefinition } from './types'
import { trackerActiveStartDate } from './planning'

const DAY_MS = 86_400_000
const parseDate = (date: string) => Date.parse(`${date}T00:00:00.000Z`)
const dayDifference = (from: string, to: string) => Math.round((parseDate(to) - parseDate(from)) / DAY_MS)

export type ChallengeDayDisplay = {
  phase: 'upcoming' | 'active' | 'ended'
  day: number | null
  totalDays: number
  daysRemaining: number
  label: string
}

/** Challenge duration is inclusive and measured in calendar dates in the workspace zone. */
export function getChallengeDayDisplay(tracker: Pick<TrackerDefinition, 'kind' | 'startDate' | 'createdAt' | 'goalPlanning' | 'deadline'> & Partial<Pick<TrackerDefinition, 'status'>>, date: string, timeZone?: string): ChallengeDayDisplay | null {
  if (tracker.kind !== 'challenge' || !tracker.deadline) return null
  const start = trackerActiveStartDate(tracker, timeZone)
  if (tracker.deadline < start) return null
  const totalDays = dayDifference(start, tracker.deadline) + 1
  if (tracker.status === 'completed') return { phase: 'ended', day: null, totalDays, daysRemaining: 0, label: 'Challenge completed' }
  if (date < start) {
    const daysUntil = dayDifference(date, start)
    return { phase: 'upcoming', day: null, totalDays, daysRemaining: totalDays, label: `Starts in ${daysUntil} ${daysUntil === 1 ? 'day' : 'days'}` }
  }
  const day = Math.min(totalDays, dayDifference(start, date) + 1)
  if (date > tracker.deadline) return { phase: 'ended', day: totalDays, totalDays, daysRemaining: 0, label: `Ended on Day ${totalDays}` }
  return { phase: 'active', day, totalDays, daysRemaining: totalDays - day, label: `Day ${day} of ${totalDays}` }
}
