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
  manualPlanWritesEnabled: boolean
  holidays?: ReadonlySet<string>
  isOnline?: boolean
  signedIn?: boolean
}

const EMPTY_ALLOCATIONS: Record<string, number> = {}

export function CumulativeAllocationPreview({ tracker, entries, metricId, startDate, asOfDate, timeZone, onSave, manualPlanWritesEnabled, holidays, isOnline = true, signedIn = false }: Props) {
  const metric = tracker.metrics.find((item) => item.id === metricId)
  const legacy = tracker.goalPlanning?.allocations?.[metricId] ?? EMPTY_ALLOCATIONS
  const configured = tracker.goalPlanning?.manualAllocations
  const hasExplicitManualMap = Boolean(configured && Object.hasOwn(configured, metricId))
  const storedManual = hasExplicitManualMap ? configured?.[metricId] ?? EMPTY_ALLOCATIONS : EMPTY_ALLOCATIONS
  const initial = { ...storedManual }
  const [manualValues, setManualValues] = useState<Record<string, number>>(initial)
  const [legacyPlanChoice, setLegacyPlanChoice] = useState<'unreviewed' | 'keep' | 'automatic'>(() =>
    !hasExplicitManualMap && Object.keys(legacy).some((date) => date >= asOfDate) ? 'unreviewed' : 'automatic')
  const [dirty, setDirty] = useState(false)
  const [resolveHolidayConflicts, setResolveHolidayConflicts] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedLocally, setSavedLocally] = useState(false)
  const [error, setError] = useState('')
  const [pageStart, setPageStart] = useState(0)
  const preview = useMemo(() => createCumulativeAllocationPreview({
    tracker, entries, metricId, totalTarget: tracker.goalPlanning?.cumulativeTargets[metricId] ?? 0, startDate, asOfDate, holidays, timeZone,
    manualAllocations: manualValues,
  }), [tracker, entries, metricId, startDate, asOfDate, holidays, timeZone, manualValues])

  const legacyDatesNeedingReview = Object.keys(legacy).filter((date) => date >= asOfDate && preview.days.some((day) => day.date === date && day.eligible))
  useEffect(() => {
    if (!dirty) setManualValues(initial)
    if (!dirty) setLegacyPlanChoice(!hasExplicitManualMap && legacyDatesNeedingReview.length > 0 ? 'unreviewed' : 'automatic')
  }, [dirty, tracker, metricId])
  useEffect(() => {
    setPageStart((current) => Math.min(current, Math.max(0, preview.days.length - 14)))
  }, [preview.days.length])
  if (!metric) return null

  const eligibleDays = preview.days.filter((day) => day.eligible)
  const saved = legacy
  const allocations = eligibleDays.map((day) => day.outstanding)
  const totals = summarizeAllocations(preview.remainingTarget, allocations)
  const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
  const isChecklistMetric = metric.valueType === 'checklist'
  const format = (value: number) => `${formatTrackerNumber(value)}${unit}`
  const latestEntries = latestEntriesByDate(entries, metricId)
  const holidayConflicts = preview.days.filter((day) => day.holiday && (storedManual[day.date] ?? 0) > 0)
  const pageDays = preview.days.slice(pageStart, pageStart + 14)
  const pageEnd = Math.min(preview.days.length, pageStart + pageDays.length)

  function changeAllocation(date: string, raw: string) {
    const value = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return
    if (isChecklistMetric && !Number.isInteger(value)) return
    if (metric?.precision && Math.abs(value / metric.precision.increment - Math.round(value / metric.precision.increment)) > Math.max(1, value / metric.precision.increment) * Number.EPSILON * 8) return
    setManualValues((current) => ({ ...current, [date]: value }))
    setDirty(true)
    setSavedLocally(false)
    setError('')
  }

  function discardChanges() {
    setManualValues(initial)
    setDirty(false)
    setResolveHolidayConflicts(false)
    setLegacyPlanChoice(!hasExplicitManualMap && legacyDatesNeedingReview.length > 0 ? 'unreviewed' : 'automatic')
    setSavedLocally(false)
    setError('')
  }

  function preservePreviousPlan() {
    setManualValues((current) => ({ ...Object.fromEntries(legacyDatesNeedingReview.map((date) => [date, legacy[date]!] as const)), ...current }))
    setLegacyPlanChoice('keep')
    setSavedLocally(false)
    setDirty(true)
  }

  function useAutomaticPlan() {
    setManualValues({})
    setLegacyPlanChoice('automatic')
    setSavedLocally(false)
    setDirty(true)
  }

  async function savePlan() {
    if (!dirty || !tracker.goalPlanning || (legacyDatesNeedingReview.length > 0 && legacyPlanChoice === 'unreviewed')) return
    setSaving(true)
    setSavedLocally(false)
    setError('')
    try {
      const nextMetricAllocations = { ...manualValues }
      if (resolveHolidayConflicts) holidayConflicts.forEach((day) => { delete nextMetricAllocations[day.date] })
      const candidate = {
        ...tracker,
        schemaVersion: 5 as const,
        goalPlanning: {
          ...tracker.goalPlanning,
          planningTimeZone: timeZone,
          allocations: tracker.goalPlanning.allocations ?? {},
          manualAllocations: { ...(tracker.goalPlanning.manualAllocations ?? {}), [metricId]: nextMetricAllocations },
        },
      }
      const checked = trackerDefinitionSchema.safeParse(candidate)
      if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'This plan contains invalid allocations.')
      await onSave(checked.data as TrackerDefinition)
      setDirty(false)
      setResolveHolidayConflicts(false)
      setSavedLocally(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The plan could not be saved. Your previous plan is unchanged.')
    } finally {
      setSaving(false)
    }
  }

  return <section className="allocation-preview" aria-label={`${metric.name} allocation preview`}>
    <header className="allocation-preview-heading">
      <div><span className="tracker-kind-chip">{dirty ? 'UNSAVED CHANGES' : tracker.schemaVersion >= 3 && saved ? 'SAVED PLAN' : 'PREVIEW'}</span><h4>{metric.name} · {preview.days.length} calendar days</h4></div>
      {dirty && <div className="allocation-plan-actions"><button className="button button-primary button-small" type="button" onClick={() => void savePlan()} disabled={saving || !manualPlanWritesEnabled || (legacyDatesNeedingReview.length > 0 && legacyPlanChoice === 'unreviewed')}>{saving ? 'Saving…' : 'Save manual changes'}</button><button className="button button-secondary button-small" type="button" onClick={discardChanges} disabled={saving}>Discard Changes</button></div>}
    </header>
    <p className="allocation-preview-note">{dirty ? 'Manual changes are not saved yet.' : 'Planned amounts rebalance from remaining work and scheduled days. Completed values always come from saved check-ins.'}</p>
    {!manualPlanWritesEnabled && <p className="allocation-preview-warning" role="status">Saving manual plans is disabled in this production build until the schema v5 migration is applied and verified.</p>}
    {error && <p className="allocation-preview-warning" role="alert">{error}</p>}
    {savedLocally && <p className="allocation-save-status" role="status">{signedIn ? isOnline ? 'Saved on this device. Account sync runs automatically.' : 'Saved on this device. Sync is pending until you reconnect.' : 'Saved on this device.'}</p>}
    {!hasExplicitManualMap && legacyDatesNeedingReview.length > 0 && <div className="allocation-legacy-notice" role="status"><span>This older saved plan does not identify which dates you edited and which were auto-filled. Choose how to handle its future dates before saving your changes.</span><div><button className="button button-secondary button-small" type="button" onClick={preservePreviousPlan}>Keep previous future values as manual</button><button className="button button-quiet button-small" type="button" onClick={useAutomaticPlan}>Use the recalculated plan</button></div></div>}
    {holidayConflicts.length > 0 && <div className="allocation-preview-warning" role="status"><p>{holidayConflicts.length} holiday date{holidayConflicts.length === 1 ? '' : 's'} have manual allocations. They are preserved and excluded from this preview until released.</p><button className="button button-secondary button-small" type="button" onClick={() => { setManualValues((current) => { const next = { ...current }; holidayConflicts.forEach((day) => delete next[day.date]); return next }); setResolveHolidayConflicts(true); setDirty(true); setSavedLocally(false) }}>Release holiday allocations</button></div>}
    <div className="allocation-preview-summary" role="group" aria-label={`${metric.name} preview totals`}>
      <span><small>Completed</small><strong>{format(preview.actualProgress)}</strong></span>
      <span><small>Remaining target</small><strong>{format(preview.remainingTarget)}</strong></span>
      <span><small>Planned</small><strong>{format(totals.plannedTotal)}</strong></span>
      <span><small>{preview.overAllocatedWork ? 'Over-allocation' : preview.unallocatedWork || totals.shortfall ? 'Unallocated' : totals.overAllocation ? 'Over-allocation' : 'Balance'}</small><strong>{format(preview.overAllocatedWork || preview.unallocatedWork || totals.shortfall || totals.overAllocation)}</strong></span>
    </div>
    {preview.eligibleDayCount === 0 && preview.remainingTarget > 0 && <p className="allocation-preview-warning" role="status">The goal is behind schedule: {format(preview.remainingTarget)} remains and no eligible scheduled days remain before the deadline.</p>}
    <details className="allocation-schedule-disclosure"><summary>Daily schedule <span>{preview.days.length} dates</span></summary>
    {preview.days.length > 14 && <nav className="allocation-page-controls" aria-label={`${metric.name} schedule pages`}><button className="button button-secondary button-small" type="button" disabled={pageStart === 0} onClick={() => setPageStart((current) => Math.max(0, current - 14))}>Previous dates</button><span>Dates {pageStart + 1}–{pageEnd} of {preview.days.length}</span><button className="button button-secondary button-small" type="button" disabled={pageEnd >= preview.days.length} onClick={() => setPageStart((current) => Math.min(preview.days.length - 14, current + 14))}>Next dates</button></nav>}
    {preview.days.length > 0 && <div className="allocation-preview-table-wrap"><table className="allocation-preview-table">
      <thead><tr><th scope="col">Date</th><th scope="col">Completed</th><th scope="col">Planned</th></tr></thead>
      <tbody>{pageDays.map((day) => {
        const entry = latestEntries.get(day.date)
          const actual = entry?.outcome === 'skipped' ? 'Skipped · intentionally saved' : entry ? actualMetricValue(metric.valueType, metricId, entry.values) : null
        return <tr key={day.date} className={day.holiday ? 'allocation-holiday' : day.eligible ? '' : 'allocation-rest-day'}>
          <th scope="row">{calendarDateLabel(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}{day.historical && <span className="allocation-rest-label">History</span>}{!day.eligible && !day.historical && <span className="allocation-rest-label">{day.holiday ? 'Holiday' : 'Rest day'}</span>}</th>
          <td>{actual === null ? '—' : actual === 'Skipped · intentionally saved' ? actual : actual === 'invalid' ? 'No numeric value' : format(actual)}</td>
          <td>{day.amount !== null ? <div className="allocation-planned-cell">{day.eligible ? <><label className={`allocation-input-label${dirty ? ' allocation-unsaved' : ''}`}><span className="sr-only">Planned allocation for {day.date}</span><input className="auth-input" aria-label={`Planned allocation for ${day.date}`} type="number" min="0" max={Number.MAX_SAFE_INTEGER} step={metric.valueType === 'checklist' ? 1 : metric.precision?.increment ?? 'any'} value={manualValues[day.date] ?? day.amount} onChange={(event) => changeAllocation(day.date, event.target.value)} /></label>{day.manual ? <><span className="allocation-manual-indicator">Manual</span><button className="allocation-reset-button" type="button" onClick={() => { setManualValues((current) => { const next = { ...current }; delete next[day.date]; return next }); setDirty(true); setSavedLocally(false) }}>Reset to auto</button></> : <span className="allocation-auto-indicator">Auto</span>}</> : <span aria-label={`Planned allocation for ${day.date}`}>{format(day.amount)}{day.manual && <small className="allocation-manual-indicator">Manual · history</small>}</span>}</div> : <span className="allocation-rest-value">{day.closed ? 'Logged' : 'Not scheduled'}</span>}</td>
        </tr>
      })}</tbody>
    </table></div>}
    </details>
    {eligibleDays.length > 0 && <p className="allocation-rounding-note">{metric.precision ? `Amounts follow the configured ${metric.precision.increment} increment.` : 'The split uses the metric’s available decimal precision.'} Extra whole units go to earlier scheduled dates. Completed check-ins stay unchanged, and checklist allocations use whole items.</p>}
    {preview.overAllocatedWork > 0 && <p className="allocation-preview-warning" role="status">Manual future allocations exceed remaining work by {format(preview.overAllocatedWork)}. Release or edit manual dates to rebalance.</p>}
    {preview.overAllocatedWork === 0 && totals.overAllocation > 0 && <p className="allocation-preview-warning" role="status">The configured increment rounds the automatic plan {format(totals.overAllocation)} above the remaining target.</p>}
    {preview.unallocatedWork > 0 && <p className="allocation-preview-warning" role="status">{format(preview.unallocatedWork)} remains unallocated because no eligible automatic dates are available.</p>}
  </section>
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
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (valueType === 'checklist' && value && typeof value === 'object') return Object.values(value).filter((item) => item === true).length
  return 'invalid'
}
