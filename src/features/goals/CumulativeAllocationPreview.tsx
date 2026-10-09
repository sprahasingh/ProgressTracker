import { useMemo, useState } from 'react'
import type { TrackerDefinition, TrackerEntry } from '../../domain/trackers/types'
import { createCumulativeAllocationPreview, summarizeAllocations } from '../../domain/trackers/allocationPreview'
import { calendarDateLabel } from '../shared/localDates'

type Props = {
  tracker: TrackerDefinition
  entries: readonly TrackerEntry[]
  metricId: string
  startDate: string
  asOfDate: string
  timeZone: string
}

export function CumulativeAllocationPreview({ tracker, entries, metricId, startDate, asOfDate, timeZone }: Props) {
  const [manualValues, setManualValues] = useState<Record<string, number>>({})
  const metric = tracker.metrics.find((item) => item.id === metricId)
  const preview = useMemo(() => createCumulativeAllocationPreview({
    tracker, entries, metricId, totalTarget: tracker.goalPlanning?.cumulativeTargets[metricId] ?? 0, startDate, asOfDate,
  }), [tracker, entries, metricId, startDate, asOfDate])
  if (!metric) return null

  const eligibleDays = preview.days.filter((day) => day.eligible)
  const allocations = eligibleDays.map((day) => manualValues[day.date] ?? day.amount ?? 0)
  const totals = summarizeAllocations(preview.remainingTarget, allocations)
  const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
  const isChecklistMetric = metric.valueType === 'checklist'
  const format = (value: number) => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 15 }).format(value)}${unit}`
  const latestEntries = latestEntriesByDate(entries, metricId)

  function changeAllocation(date: string, raw: string) {
    const value = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return
    if (isChecklistMetric && !Number.isInteger(value)) return
    setManualValues((current) => ({ ...current, [date]: value }))
  }

  return <section className="allocation-preview" aria-label={`${metric.name} allocation preview`}>
    <header className="allocation-preview-heading">
      <div><span className="tracker-kind-chip">PREVIEW</span><h4>{metric.name} · {preview.days.length} calendar days</h4></div>
      <button className="button button-quiet button-small" type="button" onClick={() => setManualValues({})}>Reset even distribution</button>
    </header>
    <p className="allocation-preview-note">Unsaved proposal only. Adjustments disappear when you leave or refresh; actual check-ins, goal targets, and sync data are unchanged. Dates use the {timeZone} workspace calendar.</p>
    <div className="allocation-preview-summary" role="group" aria-label={`${metric.name} preview totals`}>
      <span><small>Actual recorded</small><strong>{format(preview.actualProgress)}</strong></span>
      <span><small>Remaining target</small><strong>{format(preview.remainingTarget)}</strong></span>
      <span><small>Planned total</small><strong>{format(totals.plannedTotal)}</strong></span>
      <span><small>{totals.shortfall ? 'Shortfall' : totals.overAllocation ? 'Over-allocation' : 'Balance'}</small><strong>{format(totals.shortfall || totals.overAllocation)}</strong></span>
    </div>
    {preview.eligibleDayCount === 0 && preview.remainingTarget > 0 && <p className="allocation-preview-warning" role="status">No scheduled days remain before the deadline. The remaining target is currently unallocated.</p>}
    {eligibleDays.length > 0 && <div className="allocation-preview-table-wrap"><table className="allocation-preview-table">
      <thead><tr><th scope="col">Date</th><th scope="col">Actual recorded</th><th scope="col">Preview allocation</th></tr></thead>
      <tbody>{preview.days.map((day) => {
        const entry = latestEntries.get(day.date)
          const actual = entry?.outcome === 'skipped' ? 'Skipped' : entry ? actualMetricValue(metric.valueType, metricId, entry.values) : null
        return <tr key={day.date} className={day.eligible ? '' : 'allocation-rest-day'}>
          <th scope="row">{calendarDateLabel(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}{!day.eligible && <span className="allocation-rest-label">Rest day</span>}</th>
          <td>{actual === null ? '—' : actual === 'Skipped' ? 'Skipped' : actual === 'invalid' ? 'No numeric value' : format(actual)}</td>
          <td>{day.eligible ? <label className="allocation-input-label"><span className="sr-only">Preview allocation for {day.date}</span><input className="auth-input" aria-label={`Preview allocation for ${day.date}`} type="number" min="0" max={Number.MAX_SAFE_INTEGER} step={metric.valueType === 'checklist' ? 1 : 'any'} value={manualValues[day.date] ?? day.amount ?? 0} onChange={(event) => changeAllocation(day.date, event.target.value)} />{unit && <span>{unit.trim()}</span>}</label> : <span className="allocation-rest-value">Not scheduled</span>}</td>
        </tr>
      })}</tbody>
    </table></div>}
    {eligibleDays.length > 0 && <p className="allocation-rounding-note">The even split rounds numeric daily amounts down to at least hundredths, preserving target precision up to 15 decimal places, and places the exact remainder on the last scheduled day. Checklist allocations use whole items.</p>}
    {(totals.shortfall > 0 || totals.overAllocation > 0) && <p className="allocation-preview-warning" role="status">{totals.shortfall > 0 ? `${format(totals.shortfall)} remains unallocated.` : `${format(totals.overAllocation)} is allocated beyond the remaining target.`}</p>}
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
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (valueType === 'checklist' && value && typeof value === 'object') return Object.values(value).filter((item) => item === true).length
  return 'invalid'
}
