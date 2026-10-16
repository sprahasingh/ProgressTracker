import type { TrackerDefinition, TrackerEntry, TrackerMetricDefinition, TrackerMilestoneDefinition, TrackerMilestoneType } from './types'
import { activeTrackerMetrics } from './types'
import { calendarDayNumber, effectiveDaysElapsed, inclusiveCalendarDays, nthEffectiveDate, schedulingMode } from './scheduling'
import { calculateStreak, firstDateAtStreakLength } from './progression'
import { evaluateTrackerEntry, isTrackerInActivePeriod, latestEntriesByDate, metricObservationForMilestone, trackerActiveStartDate, isTrackerScheduledOccurrence } from './planning'

export type MilestoneProgress = {
  milestoneId: string
  title: string
  type: TrackerMilestoneType | 'legacy'
  trackingLabel: string
  current: number | null
  target: number | null
  unitLabel: string
  progressLabel: string
  preview: string
  percent: number | null
  completed: boolean
  reachedDate: string | null
  configurationIssue: string | null
  secondaryLabel?: string
  secondaryValue?: number
}

const DAY_MS = 86_400_000
const dateNumber = (date: string) => {
  const value = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new RangeError(`Invalid calendar date: ${date}`)
  return value
}
const dateText = (value: number) => new Date(value).toISOString().slice(0, 10)
const unitText = (metric: TrackerMetricDefinition) => metric.unit?.trim() || (metric.valueType === 'checklist' ? 'items' : 'times')
export type MilestoneConfigurationContext = Pick<TrackerDefinition, 'metrics' | 'kind' | 'scheduling' | 'deadline' | 'schedule' | 'strictMode'>

export function availableMilestoneTypes(tracker: MilestoneConfigurationContext): TrackerMilestoneType[] {
  const metrics = activeTrackerMetrics(tracker.metrics)
  const types: TrackerMilestoneType[] = []
  if (metrics.length) {
    if (metrics.some((metric) => metric.valueType === 'quantity' || metric.valueType === 'duration')) types.push('cumulative-quantity', 'single-day-quantity')
    if (tracker.schedule.kind !== 'none' || tracker.strictMode === true) types.push('successful-days', 'streak-length')
    if (metrics.some((metric) => metric.valueType === 'boolean' || metric.valueType === 'checklist')) types.push('measure-completion-count')
  }
  if (tracker.kind === 'challenge' && schedulingMode(tracker) !== 'ongoing') types.push('challenge-day')
  return [...new Set(types)]
}

export function milestoneTypeLabel(type: TrackerMilestoneType | 'legacy'): string {
  switch (type) {
    case 'cumulative-quantity': return 'Total quantity recorded'
    case 'single-day-quantity': return 'Quantity in a single day'
    case 'successful-days': return 'Successful activity days'
    case 'streak-length': return 'Longest streak'
    case 'challenge-day': return 'Challenge day reached'
    case 'measure-completion-count': return 'Measure completion count'
    case 'legacy': return 'Saved checkpoint (original calculation)'
  }
}

export function milestoneTargetLabel(type: TrackerMilestoneType | 'legacy', metric?: TrackerMetricDefinition): string {
  const unit = metric ? unitText(metric) : 'value'
  switch (type) {
    case 'cumulative-quantity': return `Target total ${unit}`
    case 'single-day-quantity': return `${unit[0]?.toUpperCase()}${unit.slice(1)} in one day`
    case 'successful-days': return 'Target successful days'
    case 'streak-length': return 'Target streak length'
    case 'challenge-day': return 'Target challenge day'
    case 'measure-completion-count': return 'Target completed days'
    case 'legacy': return 'Measure checkpoint'
  }
}

export function milestonePreview(tracker: Pick<TrackerDefinition, 'metrics'>, milestone: TrackerMilestoneDefinition): string {
  const metric = tracker.metrics.find((item) => item.id === milestone.metricId)
  const target = milestone.targetValue
  const number = target === undefined ? 'your target' : String(target)
  const name = metric?.name ?? 'the selected measure'
  const unit = metric ? unitText(metric) : 'units'
  const quantity = metric?.name.toLocaleLowerCase().includes(unit.toLocaleLowerCase()) ? `${number} ${name}` : `${number} ${unit} for ${name}`
  switch (milestone.type) {
    case 'cumulative-quantity': return `Record ${quantity} in total.`
    case 'single-day-quantity': return metric?.thresholds?.direction === 'decrease'
      ? `Record ${quantity} or less on a single day.`
      : `Record at least ${quantity} on a single day.`
    case 'successful-days': return `Complete ${number} successful activity days using this tracker’s Success Rule.`
    case 'streak-length': return `Achieve a streak of ${number} qualifying days using this tracker’s Streak Rule.`
    case 'challenge-day': return `Reach Day ${number} of this challenge using its configured day-counting method.`
    case 'measure-completion-count':
      if (milestone.completionCondition === 'true-day') return `Record ${name} as Yes on ${number} eligible dates.`
      if (milestone.completionCondition === 'checklist-item-day') return `Complete “${milestone.checklistItemLabelSnapshot ?? metric?.checklistItems?.find((item) => item.id === milestone.checklistItemId)?.label ?? 'the selected item'}” on ${number} eligible days.`
      return `Fully complete ${name} on ${number} eligible days.`
    case undefined:
      return metric && target !== undefined
        ? `Keep this saved checkpoint: the best single recorded ${name} value is compared with ${number} ${unit}.`
        : 'This descriptive checkpoint keeps its original saved meaning.'
    default: return 'Choose a milestone type to preview its meaning.'
  }
}

function base(milestone: TrackerMilestoneDefinition, type: TrackerMilestoneType | 'legacy', trackingLabel: string, preview: string): MilestoneProgress {
  return {
    milestoneId: milestone.id,
    title: milestone.title || 'Untitled milestone',
    type,
    trackingLabel,
    current: null,
    target: milestone.targetValue ?? null,
    unitLabel: '',
    progressLabel: 'Not started',
    preview,
    percent: null,
    completed: false,
    reachedDate: null,
    configurationIssue: null,
  }
}

function withProgress(result: MilestoneProgress, current: number, target: number, unitLabel: string, progressLabel: string, reachedDate: string | null): MilestoneProgress {
  return {
    ...result,
    current,
    target,
    unitLabel,
    progressLabel,
    percent: target <= 0 ? 100 : Math.min(100, Math.max(0, current / target * 100)),
    completed: current >= target,
    reachedDate: current >= target ? reachedDate : null,
  }
}

function eligibleRecordedEntries(input: {
  tracker: TrackerDefinition
  entries: readonly TrackerEntry[]
  asOfDate: string
  timeZone?: string
}): TrackerEntry[] {
  return [...latestEntriesByDate(input.tracker, input.entries).values()]
    .filter((entry) => entry.outcome === 'recorded' && entry.date <= input.asOfDate && isTrackerInActivePeriod(input.tracker, entry.date, input.timeZone))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function isProgressionOpportunity(tracker: TrackerDefinition, date: string, holidays: ReadonlySet<string>, timeZone?: string): boolean {
  return tracker.strictMode === true || (!holidays.has(date) && isTrackerScheduledOccurrence(tracker, date, timeZone))
}

export function milestoneConfigurationIssue(milestone: TrackerMilestoneDefinition, metric: TrackerMetricDefinition | undefined): string | null {
  if (!metric) return 'The measure this milestone refers to is no longer available. Choose a compatible measure or remove the milestone.'
  if (milestone.measureTypeSnapshot && metric.valueType !== milestone.measureTypeSnapshot) {
    return `“${metric.name}” changed from ${milestone.measureTypeSnapshot} to ${metric.valueType}; this milestone needs to be reconfigured.`
  }
  if ((milestone.type === 'cumulative-quantity' || milestone.type === 'single-day-quantity') && milestone.unitSnapshot !== undefined && (metric.unit ?? '') !== milestone.unitSnapshot) {
    return `The unit for “${metric.name}” changed. Review the target and update the saved unit before continuing.`
  }
  if (milestone.type === 'measure-completion-count' && milestone.completionCondition === 'checklist-item-day' && !metric.checklistItems?.some((item) => item.id === milestone.checklistItemId)) {
    return `The checklist item “${milestone.checklistItemLabelSnapshot ?? milestone.checklistItemId}” is no longer available.`
  }
  if (milestone.type === 'measure-completion-count' && milestone.completionCondition === 'checklist-complete-day') {
    const currentIds = metric.checklistItems?.map((item) => item.id) ?? []
    const savedIds = milestone.checklistItemsSnapshot ?? []
    if (currentIds.length !== savedIds.length || currentIds.some((id) => !savedIds.includes(id))) return 'The checklist changed after this milestone was created. Review the full-checklist condition.'
  }
  return metric.retiredAt ? `“${metric.name}” is retired; this milestone uses its saved history only.` : null
}

function checklistValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function challengeProgress(tracker: TrackerDefinition, target: number, asOfDate: string, holidays: ReadonlySet<string>, timeZone?: string): { current: number; reachedDate: string | null; total: number } | null {
  const mode = schedulingMode(tracker)
  if (tracker.kind !== 'challenge' || mode === 'ongoing') return null
  const start = trackerActiveStartDate(tracker, timeZone)
  if (mode === 'effective') {
    const total = tracker.scheduling?.effectiveDays ?? 0
    if (!total) return null
    const current = effectiveDaysElapsed({ tracker, date: asOfDate, holidays, timeZone })
    const reachedDate = current >= target ? nthEffectiveDate({ tracker, startDate: start, effectiveDays: target, holidays, timeZone }) : null
    return { current, reachedDate, total }
  }
  if (!tracker.deadline || tracker.deadline < start) return null
  const total = inclusiveCalendarDays(start, tracker.deadline)
  const current = calendarDayNumber(start, tracker.deadline, asOfDate)
  const targetDate = dateText(dateNumber(start) + (target - 1) * DAY_MS)
  return { current, reachedDate: current >= target ? targetDate : null, total }
}

/** Calculates each target from its own authoritative activity source. */
export function evaluateMilestones(input: {
  tracker: TrackerDefinition
  entries: readonly TrackerEntry[]
  asOfDate: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}): MilestoneProgress[] {
  dateNumber(input.asOfDate)
  const { tracker } = input
  const holidays = input.holidays ?? new Set<string>()
  const entries = eligibleRecordedEntries(input)
  const latestEntries = [...latestEntriesByDate(tracker, input.entries).values()]
    .filter((entry) => entry.date <= input.asOfDate && isTrackerInActivePeriod(tracker, entry.date, input.timeZone))
  return tracker.milestones.slice().sort((a, b) => a.position - b.position).map((milestone) => {
    const type = milestone.type ?? 'legacy'
    const result = base(milestone, type, milestoneTypeLabel(type), milestonePreview(tracker, milestone))
    const target = milestone.targetValue

    if (type === 'legacy') {
      if (!milestone.metricId || target === undefined) return { ...result, progressLabel: milestone.metricId ? 'Descriptive checkpoint' : 'Saved descriptive checkpoint' }
      const metric = tracker.metrics.find((item) => item.id === milestone.metricId)
      if (!metric) return { ...result, configurationIssue: milestoneConfigurationIssue(milestone, metric) }
      const observations = latestEntries.flatMap((entry) => {
        const value = metricObservationForMilestone(metric, entry.values[metric.id])
        return entry.outcome === 'recorded' && value !== undefined ? [{ date: entry.date, value }] : []
      })
      if (!observations.length) return { ...result, unitLabel: unitText(metric), progressLabel: 'Not started', configurationIssue: metric.retiredAt ? milestoneConfigurationIssue(milestone, metric) : null }
      const decrease = metric.thresholds?.direction === 'decrease'
      const best = observations.reduce((value, observation) => decrease ? Math.min(value, observation.value) : Math.max(value, observation.value), decrease ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)
      const reachedDate = observations.filter(({ value }) => decrease ? value <= target : value >= target).map(({ date }) => date).sort()[0] ?? null
      const completed = reachedDate !== null
      const unit = metric.valueType === 'checklist' ? 'items' : metric.valueType === 'quantity' || metric.valueType === 'duration' ? metric.unit?.trim() ?? '' : ''
      const progressLabel = `${completed ? 'Reached · ' : ''}best ${formatValue(best)}${unit ? ` ${unit}` : ''} of ${formatValue(target)}`
      const percent = target <= 0 ? completed ? 100 : 0
        : decrease ? completed ? 100 : Math.min(100, best === 0 ? 0 : target / best * 100)
          : Math.min(100, Math.max(0, best / target * 100))
      return { ...result, current: best, target, unitLabel: unit, progressLabel, percent, completed, reachedDate: completed ? reachedDate : null, configurationIssue: metric.retiredAt ? milestoneConfigurationIssue(milestone, metric) : null }
    }

    if (target === undefined || target <= 0) return { ...result, configurationIssue: 'Enter a target greater than zero.' }
    if (type === 'successful-days') {
      const dates = entries.filter((entry) => isProgressionOpportunity(tracker, entry.date, holidays, input.timeZone) && evaluateTrackerEntry(tracker, entry).qualified).map((entry) => entry.date)
      const current = dates.length
      return withProgress(result, current, target, 'successful days', `${formatValue(current)} / ${formatValue(target)} successful days`, current >= target ? dates[target - 1] ?? null : null)
    }
    if (type === 'streak-length') {
      const streak = calculateStreak(tracker, latestEntries, input.asOfDate, holidays, input.timeZone)
      const reachedDate = streak.longest >= target ? firstDateAtStreakLength(tracker, latestEntries, target, input.asOfDate, holidays, input.timeZone) : null
      const progress = withProgress(result, streak.longest, target, 'days', `Best streak: ${formatValue(streak.longest)} / ${formatValue(target)} days`, reachedDate)
      return { ...progress, secondaryLabel: 'Current streak', secondaryValue: streak.current }
    }
    if (type === 'challenge-day') {
      const challenge = challengeProgress(tracker, target, input.asOfDate, holidays, input.timeZone)
      if (!challenge) return { ...result, configurationIssue: tracker.kind !== 'challenge' ? 'Challenge-day milestones are available only for challenges.' : 'This challenge needs a fixed Calendar Days or Effective Days schedule.' }
      if (target > challenge.total) return { ...result, configurationIssue: `The target exceeds this ${challenge.total}-day challenge.` }
      return withProgress(result, challenge.current, target, 'challenge days', `Challenge Day ${formatValue(challenge.current)} / ${formatValue(target)}`, challenge.reachedDate)
    }

    const metric = tracker.metrics.find((item) => item.id === milestone.metricId)
    const issue = milestoneConfigurationIssue(milestone, metric)
    if (!metric) return { ...result, configurationIssue: issue }
    if (issue && !metric.retiredAt) return { ...result, unitLabel: unitText(metric), progressLabel: 'Needs measure review', configurationIssue: issue }
    if (type === 'cumulative-quantity') {
      if (metric.valueType !== 'quantity' && metric.valueType !== 'duration') return { ...result, configurationIssue: `“${metric.name}” is no longer a numeric measure.` }
      const total = entries.reduce((sum, entry) => {
        const value = entry.values[metric.id]
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? sum + value : sum
      }, 0)
      let running = 0
      let reachedDate: string | null = null
      for (const entry of entries) {
        const value = entry.values[metric.id]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) running += value
        if (running >= target) { reachedDate = entry.date; break }
      }
      const progress = withProgress(result, total, target, unitText(metric), `${formatValue(total)} / ${formatValue(target)} ${unitText(metric)} total`, reachedDate)
      return { ...progress, configurationIssue: issue }
    }
    if (type === 'single-day-quantity') {
      if (metric.valueType !== 'quantity' && metric.valueType !== 'duration') return { ...result, configurationIssue: `“${metric.name}” is no longer a numeric measure.` }
      const values = entries.flatMap((entry) => typeof entry.values[metric.id] === 'number' && Number.isFinite(entry.values[metric.id]) && (entry.values[metric.id] as number) >= 0 ? [{ date: entry.date, value: entry.values[metric.id] as number }] : [])
      const decrease = metric.thresholds?.direction === 'decrease'
      const best = values.reduce((value, item) => decrease ? Math.min(value, item.value) : Math.max(value, item.value), decrease ? Number.POSITIVE_INFINITY : 0)
      const reachedDate = values.filter(({ value }) => decrease ? value <= target : value >= target).map(({ date }) => date).sort()[0] ?? null
      const current = values.length ? best : 0
      const label = decrease ? `Best day: ${formatValue(current)} / ${formatValue(target)} ${unitText(metric)} or less` : `Best day: ${formatValue(current)} / ${formatValue(target)} ${unitText(metric)}`
      const progress = decrease
        ? { ...result, current, target, unitLabel: unitText(metric), progressLabel: values.length ? label : `No recorded day / ${formatValue(target)} ${unitText(metric)}`, percent: current <= target && values.length ? 100 : Math.min(100, current === 0 ? 0 : target / current * 100), completed: reachedDate !== null, reachedDate }
        : withProgress(result, current, target, unitText(metric), label, reachedDate)
      return { ...progress, configurationIssue: issue }
    }
    if (type === 'measure-completion-count') {
      const condition = milestone.completionCondition
      if (metric.valueType !== 'boolean' && metric.valueType !== 'checklist') return { ...result, configurationIssue: `“${metric.name}” is no longer a Yes/No or checklist measure.` }
      const dates = entries.filter((entry) => (() => {
        const value = entry.values[metric.id]
        if (condition === 'true-day') return metric.valueType === 'boolean' && value === true
        const checks = checklistValue(value)
        if (!checks || metric.valueType !== 'checklist') return false
        if (condition === 'checklist-item-day') return checks[milestone.checklistItemId ?? ''] === true
        if (condition === 'checklist-complete-day') return (milestone.checklistItemsSnapshot ?? []).length > 0 && milestone.checklistItemsSnapshot!.every((id) => checks[id] === true)
        return false
      })()).map((entry) => entry.date)
      const current = dates.length
      const wording = condition === 'true-day' ? 'Yes days' : condition === 'checklist-item-day' ? 'completed-item days' : 'fully completed days'
      return { ...withProgress(result, current, target, wording, `${formatValue(current)} / ${formatValue(target)} ${wording}`, current >= target ? dates[target - 1] ?? null : null), configurationIssue: issue }
    }
    return { ...result, configurationIssue: 'This milestone type is not supported.' }
  })
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

/** The date-only day number used by Calendar Days and Effective Days milestones. */
export function milestoneChallengeDayAt(tracker: TrackerDefinition, date: string, holidays: ReadonlySet<string> = new Set(), timeZone?: string): number | null {
  if (tracker.kind !== 'challenge') return null
  const mode = schedulingMode(tracker)
  if (mode === 'effective') return effectiveDaysElapsed({ tracker, date, holidays, timeZone })
  if (!tracker.deadline) return null
  return calendarDayNumber(trackerActiveStartDate(tracker, timeZone), tracker.deadline, date)
}
