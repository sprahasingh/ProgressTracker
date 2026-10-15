import type { TrackerDefinition } from './types'
import { trackerActiveStartDate } from './planning'
import { deriveSchedulingDeadline, effectiveDayNumber, effectiveDaysElapsed, nextEligibleDate, schedulingMode } from './scheduling'

const DAY_MS = 86_400_000
const parseDate = (date: string) => Date.parse(`${date}T00:00:00.000Z`)
const dayDifference = (from: string, to: string) => Math.round((parseDate(to) - parseDate(from)) / DAY_MS)

export type ChallengeDayDisplay = {
  phase: 'upcoming' | 'active' | 'paused' | 'ended'
  day: number | null
  totalDays: number
  daysRemaining: number
  label: string
  deadline: string
  nextEligibleDate?: string
}

/** The challenge clock is calendar based or eligibility based according to the shared scheduling mode. */
export function getChallengeDayDisplay(
  tracker: Pick<TrackerDefinition, 'kind' | 'startDate' | 'createdAt' | 'goalPlanning' | 'deadline' | 'scheduling' | 'schedule'> & Partial<Pick<TrackerDefinition, 'status'>>,
  date: string,
  timeZone?: string,
  holidays: ReadonlySet<string> = new Set(),
): ChallengeDayDisplay | null {
  if (tracker.kind !== 'challenge') return null
  const mode = schedulingMode(tracker)
  if (mode === 'ongoing') return null
  const start = trackerActiveStartDate(tracker, timeZone)
  const deadline = mode === 'effective'
    ? deriveSchedulingDeadline({ tracker, holidays, timeZone })
    : tracker.deadline
  if (!deadline || deadline < start) return null
  const totalDays = mode === 'effective' ? tracker.scheduling?.effectiveDays ?? 0 : dayDifference(start, deadline) + 1
  if (!totalDays) return null
  if (tracker.status === 'completed') return { phase: 'ended', day: null, totalDays, daysRemaining: 0, label: 'Challenge completed', deadline }
  if (date < start) {
    const daysUntil = dayDifference(date, start)
    return { phase: 'upcoming', day: null, totalDays, daysRemaining: totalDays, label: `Starts in ${daysUntil} ${daysUntil === 1 ? 'day' : 'days'}`, deadline }
  }
  if (date > deadline) return { phase: 'ended', day: totalDays, totalDays, daysRemaining: 0, label: `Ended on Day ${totalDays}`, deadline }
  if (mode === 'effective') {
    const day = effectiveDayNumber({ tracker, date, holidays, timeZone })
    if (day === null) {
      const next = nextEligibleDate({ tracker, afterDate: date, holidays, timeZone })
      const elapsed = effectiveDaysElapsed({ tracker, date, holidays, timeZone })
      return { phase: 'paused', day: null, totalDays, daysRemaining: Math.max(0, totalDays - elapsed), label: next ? `Paused · next is Day ${effectiveDayNumber({ tracker, date: next, holidays, timeZone })}` : 'Paused · no eligible days remain', deadline, ...(next ? { nextEligibleDate: next } : {}) }
    }
    return { phase: 'active', day, totalDays, daysRemaining: totalDays - day, label: `Day ${day} of ${totalDays}`, deadline }
  }
  const day = Math.min(totalDays, dayDifference(start, date) + 1)
  return { phase: 'active', day, totalDays, daysRemaining: totalDays - day, label: `Day ${day} of ${totalDays}`, deadline }
}
