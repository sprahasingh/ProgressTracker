import type { TrackerDefinition } from './types'
import { isTrackerInActivePeriod, isTrackerScheduledOccurrence, trackerActiveStartDate, trackerEvaluationHistoryStartDate } from './planning'
import { isEffectiveDateEligible, schedulingMode } from './scheduling'
import { trackerDefinitionForDate } from './ruleVersions'

const DAY_MS = 86_400_000
const parseDate = (date: string) => Date.parse(`${date}T00:00:00.000Z`)
const dayDifference = (from: string, to: string) => Math.round((parseDate(to) - parseDate(from)) / DAY_MS)
const dateText = (time: number) => new Date(time).toISOString().slice(0, 10)

/** Count challenge days using the evaluation settings effective on each date. */
export function challengeDaysElapsed(tracker: TrackerDefinition, throughDate: string, timeZone?: string, holidays: ReadonlySet<string> = new Set()): number {
  const start = trackerEvaluationHistoryStartDate(tracker, timeZone)
  if (throughDate < start) return 0
  let count = 0
  for (let time = parseDate(start); time <= parseDate(throughDate); time += DAY_MS) {
    const date = dateText(time)
    const evaluation = trackerDefinitionForDate(tracker, date)
    if (!isTrackerInActivePeriod(tracker, date, timeZone)) continue
    if (schedulingMode(evaluation) === 'calendar') count += 1
    else if (schedulingMode(evaluation) === 'effective' && isEffectiveDateEligible(evaluation, date, holidays, timeZone)) count += 1
  }
  return count
}

/** Return the date where a challenge day target is first reached across rule versions. */
export function firstChallengeDateAtDay(tracker: TrackerDefinition, targetDay: number, throughDate: string, timeZone?: string, holidays: ReadonlySet<string> = new Set()): string | null {
  const start = trackerEvaluationHistoryStartDate(tracker, timeZone)
  if (throughDate < start) return null
  let count = 0
  for (let time = parseDate(start); time <= parseDate(throughDate); time += DAY_MS) {
    const date = dateText(time)
    const evaluation = trackerDefinitionForDate(tracker, date)
    if (!isTrackerInActivePeriod(tracker, date, timeZone)) continue
    const mode = schedulingMode(evaluation)
    if (mode === 'calendar' || mode === 'effective' && isEffectiveDateEligible(evaluation, date, holidays, timeZone)) count += 1
    if (count >= targetDay) return date
  }
  return null
}

function deadlineForCurrentEffectiveVersion(tracker: TrackerDefinition, date: string, totalDays: number, timeZone: string | undefined, holidays: ReadonlySet<string>): string | undefined {
  let elapsed = challengeDaysElapsed(tracker, date, timeZone, holidays)
  if (elapsed >= totalDays) return firstChallengeDateAtDay(tracker, totalDays, date, timeZone, holidays) ?? date
  const startTime = parseDate(date) + DAY_MS
  for (let offset = 0; offset < 366_000; offset += 1) {
    const nextDate = dateText(startTime + offset * DAY_MS)
    const evaluation = trackerDefinitionForDate(tracker, nextDate)
    if (!isTrackerInActivePeriod(tracker, nextDate, timeZone)) continue
    const mode = schedulingMode(evaluation)
    if (mode === 'calendar' || mode === 'effective' && isEffectiveDateEligible(evaluation, nextDate, holidays, timeZone)) elapsed += 1
    if (elapsed >= totalDays) return nextDate
  }
  return undefined
}

export type ChallengeDayDisplay = {
  phase: 'upcoming' | 'active' | 'paused' | 'ended'
  day: number | null
  totalDays: number
  daysRemaining: number
  label: string
  deadline: string
  nextEligibleDate?: string
  restDay?: boolean
}

/** The challenge clock is calendar based or eligibility based according to the shared scheduling mode. */
export function getChallengeDayDisplay(
  tracker: TrackerDefinition,
  date: string,
  timeZone?: string,
  holidays: ReadonlySet<string> = new Set(),
): ChallengeDayDisplay | null {
  if (tracker.kind !== 'challenge') return null
  const evaluation = trackerDefinitionForDate(tracker, date)
  const mode = schedulingMode(evaluation)
  if (mode === 'ongoing') return null
  const start = trackerActiveStartDate(evaluation, timeZone)
  const deadline = mode === 'effective'
    ? deadlineForCurrentEffectiveVersion(tracker, date, evaluation.scheduling?.effectiveDays ?? 0, timeZone, holidays)
    : evaluation.deadline
  if (!deadline || deadline < start) return null
  const totalDays = mode === 'effective' ? evaluation.scheduling?.effectiveDays ?? 0 : dayDifference(start, deadline) + 1
  if (!totalDays) return null
  if (tracker.status === 'completed') return { phase: 'ended', day: null, totalDays, daysRemaining: 0, label: 'Challenge completed', deadline }
  if (date < start) {
    const daysUntil = dayDifference(date, start)
    return { phase: 'upcoming', day: null, totalDays, daysRemaining: totalDays, label: `Starts in ${daysUntil} ${daysUntil === 1 ? 'day' : 'days'}`, deadline }
  }
  if (date > deadline) return { phase: 'ended', day: totalDays, totalDays, daysRemaining: 0, label: `Ended on Day ${totalDays}`, deadline }
  if (mode === 'effective') {
    const eligible = isEffectiveDateEligible(evaluation, date, holidays, timeZone)
    const day = Math.min(challengeDaysElapsed(tracker, date, timeZone, holidays), totalDays)
    if (!eligible) {
      let next: string | undefined
      for (let offset = 1; offset <= 366_000; offset += 1) {
        const candidateDate = dateText(parseDate(date) + offset * DAY_MS)
        const candidateEvaluation = trackerDefinitionForDate(tracker, candidateDate)
        if (!isTrackerInActivePeriod(tracker, candidateDate, timeZone)) continue
        const candidateMode = schedulingMode(candidateEvaluation)
        if (candidateMode === 'calendar' || candidateMode === 'effective' && isEffectiveDateEligible(candidateEvaluation, candidateDate, holidays, timeZone)) { next = candidateDate; break }
      }
      const elapsed = day
      const holiday = holidays.has(date)
      return { phase: 'paused', day: null, totalDays, daysRemaining: Math.max(0, totalDays - elapsed), label: holiday ? (next ? `Holiday · next is Day ${Math.min(elapsed + 1, totalDays)}` : 'Holiday · no eligible days remain') : (next ? `Rest day · next is Day ${Math.min(elapsed + 1, totalDays)}` : 'Rest day · no eligible days remain'), deadline, ...(next ? { nextEligibleDate: next } : {}) }
    }
    const restDay = evaluation.scheduling?.effectiveDayCounting !== 'planned-activity-days' && !isTrackerScheduledOccurrence({ ...evaluation, deadline: undefined }, date, timeZone)
    return { phase: 'active', day, totalDays, daysRemaining: totalDays - day, label: restDay ? `Day ${day} of ${totalDays} · Rest day` : `Day ${day} of ${totalDays}`, deadline, ...(restDay ? { restDay: true } : {}) }
  }
  const day = Math.min(totalDays, challengeDaysElapsed(tracker, date, timeZone, holidays))
  return { phase: 'active', day, totalDays, daysRemaining: totalDays - day, label: `Day ${day} of ${totalDays}`, deadline }
}
