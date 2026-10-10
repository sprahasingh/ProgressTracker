import { useEffect, useMemo, useState } from 'react'
import { trackerDefinitionSchema } from '../../domain/trackers/schema'
import type { TrackerDefinition, TrackerEntry } from '../../domain/trackers/types'
import { createCumulativeAllocationPreview, summarizeAllocations } from '../../domain/trackers/allocationPreview'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel } from '../shared/localDates'

type Props = {
  tracker: TrackerDefinition
  entries: readonly TrackerEntry[]
  metricId: string
  startDate: string
  asOfDate: string
  timeZone: string
  onSave: (tracker: TrackerDefinition) => Promise<void>
  v3WritesEnabled: boolean
  holidays?: ReadonlySet<string>
}

const EMPTY_ALLOCATIONS: Record<string, number> = {}

export function CumulativeAllocationPreview({ tracker, entries, metricId, startDate, asOfDate, timeZone, onSave, v3WritesEnabled, holidays }: Props) {
  const metric = tracker.metrics.find((item) => item.id === metricId)
  const preview = useMemo(() => createCumulativeAllocationPreview({
    tracker, entries, metricId, totalTarget: tracker.goalPlanning?.cumulativeTargets[metricId] ?? 0, startDate, asOfDate, holidays,
  }), [tracker, entries, metricId, startDate, asOfDate, holidays])
  if (!metric) return null

  const eligibleDays = useMemo(() => preview.days.filter((day) => day.eligible), [preview.days])
  const saved = tracker.goalPlanning?.allocations?.[metricId] ?? EMPTY_ALLOCATIONS
  const suggested = Object.fromEntries(eligibleDays.map((day) => [day.date, day.amount ?? 0]))
  const savedPlanExists = Object.keys(saved).length > 0
  const savedAllocationInvalid = Object.values(saved).some((amount) => isInvalidAllocation(amount, metric.valueType, metric.precision?.increment))
  const suggestionChanged = savedPlanExists && (savedAllocationInvalid || eligibleDays.some((day) => saved[day.date] !== (day.amount ?? 0)))
  const initial = useMemo(() => Object.fromEntries(eligibleDays.map((day) => [day.date, saved[day.date] ?? day.amount ?? 0])), [eligibleDays, saved])
  const [manualValues, setManualValues] = useState<Record<string, number>>(initial)
  const [dirty, setDirty] = useState(false)
  const [replaceSavedPlan, setReplaceSavedPlan] = useState(false)
  const [resolveHolidayConflicts, setResolveHolidayConflicts] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pageStart, setPageStart] = useState(() => Math.max(0, preview.days.findIndex((day) => day.eligible)))
  const allocations = eligibleDays.map((day) => manualValues[day.date] ?? day.amount ?? 0)
  const totals = summarizeAllocations(preview.remainingTarget, allocations)
  const suggestedTotals = summarizeAllocations(preview.remainingTarget, eligibleDays.map((day) => day.amount ?? 0))
  const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
  const isChecklistMetric = metric.valueType === 'checklist'
  const format = (value: number) => `${formatTrackerNumber(value)}${unit}`
  const latestEntries = latestEntriesByDate(entries, metricId)
  const holidayConflicts = preview.days.filter((day) => day.holiday && (saved[day.date] ?? 0) > 0)
  const pageDays = preview.days.slice(pageStart, pageStart + 14)
  const pageEnd = Math.min(preview.days.length, pageStart + pageDays.length)

  useEffect(() => {
    if (!dirty) setManualValues(initial)
  }, [dirty, initial])
  useEffect(() => {
    setPageStart((current) => Math.min(current, Math.max(0, preview.days.length - 14)))
  }, [preview.days.length])

  function changeAllocation(date: string, raw: string) {
    const value = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return
    if (isChecklistMetric && !Number.isInteger(value)) return
    if (metric?.precision && Math.abs(value / metric.precision.increment - Math.round(value / metric.precision.increment)) > Math.max(1, value / metric.precision.increment) * Number.EPSILON * 8) return
    setManualValues((current) => ({ ...current, [date]: value }))
    setDirty(true)
    setError('')
  }

  function resetSuggested() {
    setManualValues(suggested)
    setDirty(true)
    setReplaceSavedPlan(true)
    setResolveHolidayConflicts(false)
    setError('')
  }

  function discardChanges() {
    setManualValues(initial)
    setDirty(false)
    setReplaceSavedPlan(false)
    setResolveHolidayConflicts(false)
    setError('')
  }

  async function savePlan() {
    if (!dirty || !tracker.goalPlanning) return
    setSaving(true)
    setError('')
    try {
      const nextMetricAllocations = replaceSavedPlan ? { ...manualValues } : { ...saved, ...manualValues }
      if (resolveHolidayConflicts) holidayConflicts.forEach((day) => { delete nextMetricAllocations[day.date] })
      const candidate = {
        ...tracker,
        schemaVersion: tracker.schemaVersion === 4 ? 4 as const : 3 as const,
        goalPlanning: {
          ...tracker.goalPlanning,
          planningTimeZone: timeZone,
          allocations: { ...(tracker.goalPlanning.allocations ?? {}), [metricId]: nextMetricAllocations },
        },
      }
      const checked = trackerDefinitionSchema.safeParse(candidate)
      if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'This plan contains invalid allocations.')
      await onSave(checked.data as TrackerDefinition)
      setDirty(false)
      setReplaceSavedPlan(false)
      setResolveHolidayConflicts(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The plan could not be saved. Your previous plan is unchanged.')
    } finally {
      setSaving(false)
    }
  }

  return <section className="allocation-preview" aria-label={`${metric.name} allocation preview`}>
    <header className="allocation-preview-heading">
      <div><span className="tracker-kind-chip">{dirty ? 'UNSAVED CHANGES' : tracker.schemaVersion >= 3 && saved ? 'SAVED PLAN' : 'PREVIEW'}</span><h4>{metric.name} · {preview.days.length} calendar days</h4></div>
      <div className="allocation-plan-actions">
        <button className="button button-primary button-small" type="button" onClick={() => void savePlan()} disabled={!dirty || saving || !v3WritesEnabled}>{saving ? 'Saving…' : 'Save Plan'}</button>
        <button className="button button-quiet button-small" type="button" onClick={resetSuggested} disabled={saving}>Reset to Suggested Allocation</button>
        {dirty && <button className="button button-secondary button-small" type="button" onClick={discardChanges} disabled={saving}>Discard Changes</button>}
      </div>
    </header>
    <p className="allocation-preview-note">{dirty ? replaceSavedPlan ? 'This reset replaces saved allocations when saved; check-ins stay unchanged.' : 'Draft changes are not saved yet.' : tracker.schemaVersion >= 3 && savedPlanExists ? `Saved plan · ${tracker.goalPlanning?.planningTimeZone ?? timeZone}.` : 'Preview only · save to store allocations.'} Suggestions recalculate when progress or scheduled days change. Saved allocations change only when you save. Actual check-ins remain separate.</p>
    {!v3WritesEnabled && <p className="allocation-preview-warning" role="status">Saving persistent plans is disabled in this production build until the required hosted schema migration is applied and verified.</p>}
    {error && <p className="allocation-preview-warning" role="alert">{error}</p>}
    {suggestionChanged && !dirty && <div className="allocation-preview-warning" role="status"><p>{savedAllocationInvalid ? 'Some saved allocations no longer match this metric’s precision.' : 'Progress or eligible dates changed, so the automatic suggestions below have been recalculated.'} Saved allocations remain unchanged. Choose “Use updated suggestion” and then save to replace them.</p><button className="button button-secondary button-small" type="button" onClick={resetSuggested} disabled={saving}>Use updated suggestion</button></div>}
    {holidayConflicts.length > 0 && <div className="allocation-preview-warning" role="status"><p>{holidayConflicts.length} holiday date{holidayConflicts.length === 1 ? '' : 's'} have saved allocations. They are preserved and excluded from this preview until you choose how to resolve them.</p><button className="button button-secondary button-small" type="button" onClick={() => { setManualValues(suggested); setResolveHolidayConflicts(true); setDirty(true) }}>Move holiday allocations to eligible days</button></div>}
    <div className="allocation-preview-summary" role="group" aria-label={`${metric.name} preview totals`}>
      <span><small>Actual recorded</small><strong>{format(preview.actualProgress)}</strong></span>
      <span><small>Remaining target</small><strong>{format(preview.remainingTarget)}</strong></span>
      <span><small>{savedPlanExists && !dirty ? 'Saved total' : 'Planned total'}</small><strong>{format(totals.plannedTotal)}</strong></span>
      <span><small>Suggested total now</small><strong>{format(suggestedTotals.plannedTotal)}</strong></span>
      <span><small>{totals.shortfall ? 'Shortfall' : totals.overAllocation ? 'Over-allocation' : 'Balance'}</small><strong>{format(totals.shortfall || totals.overAllocation)}</strong></span>
    </div>
    {preview.eligibleDayCount === 0 && preview.remainingTarget > 0 && <p className="allocation-preview-warning" role="status">The goal is behind schedule: {format(preview.remainingTarget)} remains and no eligible scheduled days remain before the deadline.</p>}
    {preview.days.length > 14 && <nav className="allocation-page-controls" aria-label={`${metric.name} schedule pages`}><button className="button button-secondary button-small" type="button" disabled={pageStart === 0} onClick={() => setPageStart((current) => Math.max(0, current - 14))}>Previous dates</button><span>Dates {pageStart + 1}–{pageEnd} of {preview.days.length}</span><button className="button button-secondary button-small" type="button" disabled={pageEnd >= preview.days.length} onClick={() => setPageStart((current) => Math.min(preview.days.length - 14, current + 14))}>Next dates</button></nav>}
    {eligibleDays.length > 0 && <div className="allocation-preview-table-wrap"><table className="allocation-preview-table">
      <thead><tr><th scope="col">Date</th><th scope="col">Actual recorded</th><th scope="col">{savedPlanExists && !dirty ? 'Saved allocation' : dirty ? 'Your draft allocation' : 'Preview allocation'}</th><th scope="col">Suggested now</th></tr></thead>
      <tbody>{pageDays.map((day) => {
        const entry = latestEntries.get(day.date)
          const actual = entry?.outcome === 'skipped' ? 'Missed · marked intentionally' : entry ? actualMetricValue(metric.valueType, metricId, entry.values) : null
        return <tr key={day.date} className={day.holiday ? 'allocation-holiday' : day.eligible ? '' : 'allocation-rest-day'}>
          <th scope="row">{calendarDateLabel(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}{!day.eligible && <span className="allocation-rest-label">{day.holiday ? 'Holiday' : day.closed ? 'Logged' : 'Rest day'}</span>}</th>
          <td>{actual === null ? '—' : actual === 'Missed · marked intentionally' ? actual : actual === 'invalid' ? 'No numeric value' : format(actual)}</td>
          <td>{day.eligible ? <label className={`allocation-input-label${dirty ? ' allocation-unsaved' : ''}`}><span className="sr-only">{dirty ? 'Unsaved allocation' : savedPlanExists ? 'Saved allocation' : 'Allocation'} for {day.date}</span><input className="auth-input" aria-label={`${dirty ? 'Unsaved allocation' : savedPlanExists ? 'Saved allocation' : 'Allocation'} for ${day.date}`} type="number" min="0" max={Number.MAX_SAFE_INTEGER} step={metric.valueType === 'checklist' ? 1 : metric.precision?.increment ?? 'any'} value={manualValues[day.date] ?? day.amount ?? 0} onChange={(event) => changeAllocation(day.date, event.target.value)} />{unit && <span>{unit.trim()}</span>}</label> : day.closed && saved[day.date] !== undefined ? <span aria-label={`Saved allocation for ${day.date}`}>{format(saved[day.date] ?? 0)}</span> : <span className="allocation-rest-value">{day.closed ? 'Logged' : 'Not scheduled'}</span>}</td>
          <td>{day.eligible ? <span aria-label={`Suggested allocation for ${day.date}`}>{format(day.amount ?? 0)}</span> : <span className="allocation-rest-value">—</span>}</td>
        </tr>
      })}</tbody>
    </table></div>}
    {eligibleDays.length > 0 && <p className="allocation-rounding-note">{metric.precision ? `Amounts follow the configured ${metric.precision.increment} increment.` : 'The split uses the metric’s available decimal precision.'} Whole-unit suggestions place any extra units on earlier scheduled days and leave later days at zero when possible. They recalculate from remaining progress and eligible days; confirmed allocations change only when you save an updated suggestion. Fractions in older recorded progress are preserved and shown as an over-allocation. Checklist allocations use whole items.</p>}
    {(totals.shortfall > 0 || totals.overAllocation > 0) && <p className="allocation-preview-warning" role="status">{totals.shortfall > 0 ? `${format(totals.shortfall)} remains unallocated.` : `${format(totals.overAllocation)} is allocated beyond the remaining target.`}</p>}
  </section>
}

function isInvalidAllocation(amount: number, valueType: string, increment?: number): boolean {
  if (valueType === 'checklist' && !Number.isInteger(amount)) return true
  if (increment === undefined) return false
  const units = amount / increment
  return Math.abs(units - Math.round(units)) > Math.max(1, Math.abs(units)) * Number.EPSILON * 8
}

function latestEntriesByDate(entries: readonly TrackerEntry[], metricId: string): Map<string, TrackerEntry> {
  const latest = new Map<string, TrackerEntry>()
  for (const entry of entries) {
    const previous = latest.get(entry.date)
    if (!previous || entry.updatedAt > previous.updatedAt || (entry.updatedAt === previous.updatedAt && entry.id > previous.id)) latest.set(entry.date, entry)
  }
  return new Map([...latest].filter(([, entry]) => entry.deletedAt === null && (entry.outcome === 'skipped' || metricId in entry.values)))
}

function actualMetricValue(valueType: string, metricId: string, values: TrackerEntry['values']): number | 'invalid' {
  const value = values[metricId]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (valueType === 'checklist' && value && typeof value === 'object') return Object.values(value).filter((item) => item === true).length
  return 'invalid'
}
