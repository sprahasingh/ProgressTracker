import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from '../../components/ui/useModalLayer'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calculateCumulativeMetricPlan } from '../../domain/trackers/planning'
import { createCumulativeAllocationPreview } from '../../domain/trackers/allocationPreview'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel } from '../shared/localDates'

type Props = {
  tracker: StoredTrackerDefinition
  entry?: StoredTrackerEntry
  today: string
  entries: readonly StoredTrackerEntry[]
  holidays: ReadonlySet<string>
  compactIconOnly?: boolean
  historical?: boolean
}

export type TodayMetricDetails = {
  id: string
  name: string
  unit: string
  isBoolean: boolean
  completed: number | boolean
  expected?: number
  expectedLabel?: string
  remaining?: number
  minimum?: number
  target?: number
  stretch?: number
  direction?: 'increase' | 'decrease'
  savedAllocation?: number
  suggestion?: number
  nextSuggestion?: number
  nextSuggestionDate?: string
  totalTarget?: number
  goalProgress?: number
  goalRemaining?: number
  planningStatus?: 'not-started' | 'active' | 'completed' | 'overdue' | 'no-scheduled-days'
}

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function scheduleDescription(tracker: StoredTrackerDefinition): string {
  const schedule = tracker.schedule
  switch (schedule.kind) {
    case 'none': return 'No recurring schedule'
    case 'every-day': return 'Every day'
    case 'weekdays': return 'Weekdays'
    case 'selected-weekdays': return schedule.weekdays.length ? schedule.weekdays.slice().sort().map((day) => weekdays[day]).join(', ') : 'No weekdays selected'
    case 'every-n-days': return `Every ${schedule.interval} days`
    case 'times-per-week': return `${schedule.count} times per week${schedule.preferredWeekdays?.length ? ` · preferred: ${schedule.preferredWeekdays.slice().sort().map((day) => weekdays[day]).join(', ')}` : ''}`
    case 'times-per-month': return `${schedule.count} times per month`
    case 'specific-dates': return `${schedule.dates.length} selected date${schedule.dates.length === 1 ? '' : 's'}`
    case 'once': return `Once · ${calendarDateLabel(schedule.date)}`
  }
}

export function getTodayMetricDetails(tracker: StoredTrackerDefinition, entry: StoredTrackerEntry | undefined, today: string, entries: readonly StoredTrackerEntry[], holidays: ReadonlySet<string>): TodayMetricDetails[] {
  return tracker.metrics.map((metric) => {
    const value = entry?.outcome === 'recorded' ? entry.values[metric.id] : undefined
    const completed = metric.valueType === 'boolean'
      ? value === true
      : typeof value === 'number' ? value
        : metric.valueType === 'checklist' && value && typeof value === 'object' ? Object.values(value).filter((item) => item === true).length : 0
    const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
    const thresholds = metric.thresholds
    const common = {
      id: metric.id, name: metric.name, unit, isBoolean: metric.valueType === 'boolean', completed,
      minimum: thresholds?.minimum, target: thresholds?.target, stretch: thresholds?.stretch, direction: thresholds?.direction,
    }

    if (metric.valueType === 'boolean') return common

    const planning = tracker.goalPlanning
    if (planning?.mode === 'cumulative-deadline') {
      const totalTarget = planning.cumulativeTargets[metric.id]
      const incremental = planning.progressSemantics[metric.id] === 'incremental'
      if (totalTarget === undefined || !incremental || !tracker.deadline) return common
      const startDate = tracker.startDate ?? tracker.createdAt.slice(0, 10)
      const planInput = { tracker, entries, metricId: metric.id, totalTarget, startDate, asOfDate: today, holidays }
      const plan = calculateCumulativeMetricPlan({ ...planInput, progressSemantics: 'incremental' })
      const savedAllocation = planning.allocations?.[metric.id]?.[today]
      const preview = createCumulativeAllocationPreview(planInput)
      const todaySuggestion = preview.days.find((day) => day.date === today && day.eligible)?.amount ?? undefined
      const nextSuggestionDay = preview.days.find((day) => day.date > today && day.eligible)
      const suggestion = todaySuggestion
      const expected = savedAllocation ?? suggestion
      return {
        ...common,
        ...(expected === undefined ? {} : { expected, expectedLabel: savedAllocation === undefined ? 'Today’s suggested allocation' : 'Today’s saved allocation', remaining: Math.max(0, expected - Number(completed)) }),
        ...(savedAllocation === undefined ? {} : { savedAllocation }),
        ...(suggestion === undefined ? {} : { suggestion }),
        ...(nextSuggestionDay?.amount === null || nextSuggestionDay?.amount === undefined ? {} : { nextSuggestion: nextSuggestionDay.amount, nextSuggestionDate: nextSuggestionDay.date }),
        totalTarget, goalProgress: plan.actualProgress, goalRemaining: plan.remainingWork, planningStatus: plan.status,
      }
    }

    const expected = planning?.mode === 'daily-recurring'
      ? planning.dailyTargets[metric.id]
      : thresholds?.target ?? thresholds?.minimum
    const expectedLabel = expected === undefined ? undefined : planning?.mode === 'daily-recurring' ? 'Today’s target' : thresholds?.target !== undefined ? 'Target threshold' : 'Minimum threshold'
    const remaining = expected === undefined || thresholds?.direction === 'decrease' ? undefined : Math.max(0, expected - Number(completed))
    return { ...common, ...(expected === undefined ? {} : { expected, expectedLabel, ...(remaining === undefined ? {} : { remaining }) }) }
  })
}

function amount(value: number, unit: string): string {
  const cleanUnit = unit.trim()
  const singularUnit = value === 1 && cleanUnit.endsWith('s') ? cleanUnit.slice(0, -1) : cleanUnit
  return `${formatTrackerNumber(value)}${singularUnit ? ` ${singularUnit}` : ''}`
}

export function TodayRequirements({ tracker, entry, today, entries, holidays, compactIconOnly = false, historical = false }: Props) {
  const [open, setOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const metrics = getTodayMetricDetails(tracker, entry, today, entries, holidays)
  const hasThresholds = metrics.some((metric) => metric.minimum !== undefined || metric.target !== undefined || metric.stretch !== undefined)
  const hasPlanning = metrics.some((metric) => metric.totalTarget !== undefined || metric.expectedLabel === 'Today’s target')
  const isCumulative = tracker.goalPlanning?.mode === 'cumulative-deadline' && metrics.some((metric) => metric.totalTarget !== undefined)
  const selectedDateLabel = calendarDateLabel(today)
  const requirementLabel = (label: string) => historical ? label.replace('Today’s', `${selectedDateLabel} ·`).replace('today', selectedDateLabel) : label

  useModalLayer(open, sheetRef, () => setOpen(false))
  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
  }, [open])

  return <>
    {!compactIconOnly && <div className="today-requirements-summary">
      <div className="today-target-summary" role="group" aria-label={`${tracker.name} progress and daily expectation`}>
        {metrics.map((metric) => <div className="today-target-metric" key={metric.id}>
          <span className="today-target-name">{metric.name}</span>
          {metric.isBoolean ? <><strong className="today-target-value">{historical ? 'Complete this activity' : 'Complete today'}</strong><small className="today-target-remaining">{metric.completed ? 'Completed' : 'Not completed'}</small></> : <>
            <span className="today-requirement-label">{requirementLabel(metric.expectedLabel === 'Target threshold' ? 'Today’s target' : metric.expectedLabel === 'Minimum threshold' ? 'Today’s minimum' : metric.expectedLabel ?? 'Progress today')}</span>
            <strong className="today-target-value">{metric.expected === undefined ? amount(Number(metric.completed), metric.unit) : `${formatTrackerNumber(Number(metric.completed))} / ${amount(metric.expected, metric.unit)}`}</strong>
            {metric.remaining !== undefined && <small className="today-target-remaining">{amount(metric.remaining, metric.unit)} remaining</small>}
          </>}
          {metric.savedAllocation !== undefined && metric.suggestion !== undefined && metric.savedAllocation !== metric.suggestion && <small className="today-requirement-note">{requirementLabel("Today’s suggestion")}: {amount(metric.suggestion, metric.unit)}</small>}
          {metric.nextSuggestion !== undefined && <small className="today-requirement-note">Next scheduled suggestion: {amount(metric.nextSuggestion, metric.unit)}</small>}
        </div>)}
      </div>
      <button ref={triggerRef} className="today-requirements-trigger" type="button" aria-label={`Information about ${tracker.name} daily requirements`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><span aria-hidden="true">i</span></button>
    </div>}
    {compactIconOnly && <button ref={triggerRef} className="today-requirements-trigger" type="button" aria-label={`Information about ${tracker.name} daily requirements`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><span aria-hidden="true">i</span></button>}
    {open && createPortal(<div className="today-requirements-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section ref={sheetRef} className="today-requirements-sheet" role="dialog" aria-modal="true" aria-labelledby="today-requirements-title">
        <header className="today-requirements-heading"><div><span className="eyebrow">DAILY REQUIREMENTS</span><h2 id="today-requirements-title">{tracker.name}</h2></div><button ref={closeRef} className="today-requirements-close" type="button" aria-label="Close daily requirements" onClick={() => setOpen(false)}>×</button></header>
        <div className="today-requirements-content"><section className="today-requirements-section"><h3>{historical ? `Progress · ${selectedDateLabel}` : "Today’s progress"}</h3>
          {metrics.map((metric) => <article className="today-requirements-metric" key={metric.id}><h4>{metric.name}{metric.unit && <span>{metric.unit}</span>}</h4>
            <dl>
              <div><dt>Completed</dt><dd>{metric.isBoolean ? metric.completed ? 'Complete' : 'Not yet' : amount(Number(metric.completed), metric.unit)}</dd></div>
              {metric.isBoolean ? <div><dt>Expected</dt><dd>Complete this check-in</dd></div> : metric.expected !== undefined && <div><dt>{requirementLabel(metric.expectedLabel ?? 'Expected')}</dt><dd>{amount(metric.expected, metric.unit)}</dd></div>}
              {!metric.isBoolean && metric.remaining !== undefined && <div><dt>Remaining</dt><dd>{amount(metric.remaining, metric.unit)}</dd></div>}
            </dl>
          </article>)}
        </section>
        {hasThresholds && <section className="today-requirements-section"><h3>Thresholds</h3>{metrics.filter((metric) => metric.minimum !== undefined || metric.target !== undefined || metric.stretch !== undefined).map((metric) => <article className="today-requirements-metric" key={metric.id}><h4>{metric.name}</h4><dl>
          {metric.minimum !== undefined && <div><dt>{metric.direction === 'decrease' ? 'Maximum for minimum level' : 'Minimum'}</dt><dd>{amount(metric.minimum, metric.unit)}</dd></div>}
          {metric.target !== undefined && <div><dt>Target threshold</dt><dd>{amount(metric.target, metric.unit)}</dd></div>}
          {metric.stretch !== undefined && <div><dt>{metric.direction === 'decrease' ? 'Maximum for stretch level' : 'Stretch'}</dt><dd>{amount(metric.stretch, metric.unit)}</dd></div>}
        </dl></article>)}</section>}
        <section className="today-requirements-section"><h3>Schedule</h3><dl><div><dt>Repeats</dt><dd>{scheduleDescription(tracker)}</dd></div>{tracker.startDate && <div><dt>Starts</dt><dd>{calendarDateLabel(tracker.startDate)}</dd></div>}{tracker.deadline && <div><dt>Deadline</dt><dd>{calendarDateLabel(tracker.deadline)}</dd></div>}</dl></section>
        {hasPlanning && <section className="today-requirements-section"><h3>Planning</h3>{metrics.filter((metric) => metric.totalTarget !== undefined || metric.expectedLabel === 'Today’s target').map((metric) => <article className="today-requirements-metric" key={metric.id}><h4>{metric.name}</h4><dl>
          {metric.totalTarget !== undefined && <><div><dt>Goal total</dt><dd>{amount(metric.totalTarget, metric.unit)}</dd></div><div><dt>Recorded toward goal</dt><dd>{amount(metric.goalProgress ?? 0, metric.unit)}</dd></div><div><dt>Goal remaining</dt><dd>{amount(metric.goalRemaining ?? 0, metric.unit)}</dd></div>{metric.savedAllocation !== undefined && <div><dt>Saved allocation</dt><dd>{amount(metric.savedAllocation, metric.unit)}</dd></div>}{metric.suggestion !== undefined && <div><dt>{requirementLabel("Today’s adaptive suggestion")}</dt><dd>{amount(metric.suggestion, metric.unit)}</dd></div>}{metric.nextSuggestion !== undefined && <div><dt>Next scheduled suggestion{metric.nextSuggestionDate ? ` · ${calendarDateLabel(metric.nextSuggestionDate)}` : ''}</dt><dd>{amount(metric.nextSuggestion, metric.unit)}</dd></div>}{metric.planningStatus === 'overdue' && <div><dt>Schedule</dt><dd>Past deadline</dd></div>}{metric.planningStatus === 'no-scheduled-days' && <div><dt>Schedule</dt><dd>No eligible days remain</dd></div>}{metric.planningStatus === 'completed' && <div><dt>Schedule</dt><dd>Goal complete</dd></div>}</>}
          {metric.expectedLabel === 'Today’s target' && metric.expected !== undefined && <div><dt>Daily plan target</dt><dd>{amount(metric.expected, metric.unit)}</dd></div>}
        </dl></article>)}
          {isCumulative && <div className="today-requirements-note">Adaptive suggestions use recorded progress and remaining scheduled days, excluding rest days, holidays, and already recorded days. A saved allocation remains explicit and is not replaced automatically.</div>}
          {!isCumulative && metrics.some((metric) => metric.expectedLabel === 'Today’s target') && <div className="today-requirements-note">Daily recurring targets apply on scheduled days; they are separate from per-check-in thresholds.</div>}
        </section>}</div>
      </section>
    </div>, document.body)}
  </>
}
