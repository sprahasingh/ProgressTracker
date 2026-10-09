import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry } from '../../domain/trackers/planning'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { assertDateRange } from '../../db/calendarDate'
import { validateTrackerEntryValues } from '../../domain/trackers/schema'
import type { TrackerValue } from '../../domain/trackers/types'
import { TrackerEntryFields } from '../shared/TrackerEntryFields'

type HistoryRange = '7' | '30' | '90' | 'custom'

export function HistoryPage() {
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [range, setRange] = useState<HistoryRange>('30')
  const [customStart, setCustomStart] = useState<string>(() => shiftCalendarDate(today, -29))
  const [customEnd, setCustomEnd] = useState<string>(today)
  const [trackerFilter, setTrackerFilter] = useState('all')
  const [trackers, setTrackers] = useState<StoredTrackerDefinition[]>([])
  const [entries, setEntries] = useState<StoredTrackerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const startDate = (range === 'custom' ? customStart : shiftCalendarDate(today, -(Number(range) - 1))) as CalendarDate
  const endDate = (range === 'custom' ? customEnd : today) as CalendarDate
  let rangeIssue = ''
  try {
    assertDateRange(startDate, endDate)
    if (endDate > today) rangeIssue = 'Choose an end date that is today or earlier in this workspace time zone.'
  } catch {
    rangeIssue = 'Choose valid dates, with the start date on or before the end date.'
  }
  const rangeRequest = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++rangeRequest.current
    if (rangeIssue) {
      setLoading(false)
      setError('')
      setEntries([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const [allTrackers, recentEntries] = await Promise.all([
        localRepository.listTrackers(true),
        localRepository.listTrackerEntriesBetween(startDate, endDate),
      ])
      if (request !== rangeRequest.current) return
      setTrackers(allTrackers)
      setEntries(recentEntries)
    } catch {
      if (request !== rangeRequest.current) return
      setError('Your check-in history could not be loaded from this device.')
    } finally {
      if (request === rangeRequest.current) setLoading(false)
    }
  }, [endDate, rangeIssue, startDate])

  useEffect(() => { void refresh() }, [refresh])
  const trackerMap = useMemo(() => new Map(trackers.map((tracker) => [tracker.id, tracker])), [trackers])
  const filtered = entries.filter((entry) => trackerFilter === 'all' || entry.trackerId === trackerFilter)
  const grouped = rangeIssue ? [] : groupByDate(filtered)
  const qualifiedCount = filtered.filter((entry) => {
    const tracker = trackerMap.get(entry.trackerId)
    return tracker && entry.outcome === 'recorded' && evaluateTrackerEntry(tracker, entry).qualified
  }).length

  return (
    <section className="tracker-page history-page" aria-labelledby="history-title">
      <PageHeader headingId="history-title" eyebrow="YOUR RECORD" title="History" description="Review and update past check-ins without losing the original timeline." />
      <div className="history-toolbar">
        <label className="history-filter"><span>Date range</span><select className="auth-input" value={range} onChange={(event) => setRange(event.target.value as HistoryRange)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></label>
        {range === 'custom' && <>
          <label className="history-filter"><span>From</span><input className="auth-input" type="date" max={today} value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label>
          <label className="history-filter"><span>Through</span><input className="auth-input" type="date" max={today} value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label>
        </>}
        <label className="history-filter"><span>Tracker</span><select className="auth-input" value={trackerFilter} onChange={(event) => setTrackerFilter(event.target.value)}><option value="all">All trackers</option>{trackers.map((tracker) => <option key={tracker.id} value={tracker.id}>{tracker.name}</option>)}</select></label>
        {!loading && <p className="history-count" role="status" aria-live="polite" aria-atomic="true">{filtered.length} check-ins · {qualifiedCount} met the success rule</p>}
      </div>
      {rangeIssue && <div role="alert" className="form-alert">{rangeIssue}</div>}
      {error && <div role="alert" className="form-alert">{error}</div>}
      {rangeIssue ? null : loading ? <p role="status" className="tracker-loading">Loading your history…</p> : error ? <Surface><EmptyState title="Your history is still here" description="This device could not open local storage. Try loading the history again." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : grouped.length === 0 ? <Surface><EmptyState title="No check-ins in this range" description="Your saved activity will appear here. Nothing is filled in until you log it." action={<Link className="button button-primary button-medium" to="/">Go to today</Link>} /></Surface> : <div className="history-timeline">
        {grouped.map(([date, dayEntries]) => <section className="history-day" key={date} aria-labelledby={`history-${date}`}><header className="history-day-heading"><h2 id={`history-${date}`}>{calendarDateLabel(date, { weekday: 'long', month: 'long', day: 'numeric' })}</h2><span>{dayEntries.length} {dayEntries.length === 1 ? 'check-in' : 'check-ins'}</span></header><div className="history-entry-list">{dayEntries.map((entry) => {
          const tracker = trackerMap.get(entry.trackerId)
          if (!tracker) return null
          const qualifies = entry.outcome === 'recorded' && evaluateTrackerEntry(tracker, entry).qualified
          return <HistoryEntry key={entry.id} tracker={tracker} entry={entry} qualifies={qualifies} onSaved={refresh} />
        })}</div></section>)}
      </div>}
      <p className="history-local-note"><span className="sync-dot" /> Your entries are saved offline on this device and sync to your signed-in account when available. Guest activity stays in its separate workspace.</p>
    </section>
  )
}

function groupByDate(entries: StoredTrackerEntry[]): Array<[string, StoredTrackerEntry[]]> {
  const groups = new Map<string, StoredTrackerEntry[]>()
  for (const entry of entries) groups.set(entry.date, [...(groups.get(entry.date) ?? []), entry])
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a))
}

function HistoryEntry({ tracker, entry, qualifies, onSaved }: { tracker: StoredTrackerDefinition; entry: StoredTrackerEntry; qualifies: boolean; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, TrackerValue>>(entry.values)
  const [note, setNote] = useState(entry.note)
  const [entryOutcome, setEntryOutcome] = useState<StoredTrackerEntry['outcome']>(entry.outcome)
  const [saving, setSaving] = useState(false)
  const [issue, setIssue] = useState('')
  const [saved, setSaved] = useState('')
  const setValue = (key: string, value: TrackerValue | undefined) => setValues((current) => {
    const next = { ...current }
    if (value === undefined) delete next[key]
    else next[key] = value
    return next
  })
  async function saveChanges() {
    const validationIssue = entryOutcome === 'recorded' ? validateTrackerEntryValues(tracker, values) : undefined
    if (validationIssue) {
      setIssue(validationIssue.replace(/^[^ ]+ is required\.$/, 'Please complete all required fields.'))
      return
    }
    setIssue('')
    setSaved('')
    setSaving(true)
    try {
      await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: entry.date, outcome: entryOutcome, values: entryOutcome === 'skipped' ? {} : values, note })
      await onSaved()
      setEditing(false)
      setSaved('Check-in updated.')
    } catch (cause) {
      setIssue(cause instanceof Error ? cause.message : 'This check-in could not be updated.')
    } finally {
      setSaving(false)
    }
  }
  const outcomeLabel = entry.outcome === 'skipped' ? 'Skipped' : qualifies ? 'Success rule met' : 'Logged'
  return <Surface className="history-entry-card"><div className="history-entry-header"><div><span className="tracker-kind-chip">{tracker.kind}</span><h3>{tracker.name}</h3></div><span className={`history-outcome ${entry.outcome === 'skipped' ? 'muted' : qualifies ? 'positive' : ''}`}>{outcomeLabel}</span></div>
    {saved && <p className="auth-success" role="status">{saved}</p>}
    {!editing && <button className="button button-secondary button-medium" disabled={tracker.status === 'archived'} onClick={() => { setValues(entry.values); setNote(entry.note); setEntryOutcome(entry.outcome); setEditing(true); setSaved('') }}>Edit check-in</button>}
    {tracker.status === 'archived' && !editing && <p className="history-entry-note">Archived trackers’ check-ins are read-only.</p>}
    {editing && <div className="history-edit-form">
      <label className="form-field"><span>Outcome</span><select className="auth-input" value={entryOutcome} onChange={(event) => setEntryOutcome(event.target.value as StoredTrackerEntry['outcome'])}><option value="recorded">Recorded</option><option value="skipped">Skipped</option></select></label>
      {entryOutcome === 'recorded' && <TrackerEntryFields tracker={tracker} values={values} setValue={setValue} />}
      <label className="form-field form-field-wide"><span>Note <em>· optional</em></span><textarea className="auth-input tracker-textarea" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      {issue && <p className="today-validation" role="alert">{issue}</p>}
      <div className="today-actions"><button className="button button-primary button-medium" disabled={saving} onClick={() => void saveChanges()}>{saving ? 'Saving…' : 'Save changes'}</button><button className="button button-quiet button-medium" disabled={saving} onClick={() => { setEditing(false); setIssue('') }}>Cancel</button></div>
    </div>}
    {!editing && <>
    {entry.outcome === 'recorded' && <dl className="history-values">{tracker.metrics.map((metric) => {
      const value = entry.values[metric.id]
      if (value === undefined || value === null) return null
      return <div key={metric.id}><dt>{metric.name}</dt><dd>{formatMetric(metric, value)}{metric.unit && typeof value === 'number' ? ` ${metric.unit}` : ''}</dd></div>
    })}{tracker.customFields.map((field) => {
      const value = entry.values[`field:${field.id}`]
      if (value === undefined || value === null || value === '') return null
      return <div key={field.id}><dt>{field.name}</dt><dd>{Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>
    })}</dl>}
    {entry.note && <p className="history-entry-note">{entry.note}</p>}
    </>}
  </Surface>
}

function formatMetric(metric: StoredTrackerDefinition['metrics'][number], value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Done' : 'Not done'
  if (typeof value === 'number') return String(value)
  if (metric.valueType === 'checklist' && Array.isArray(value)) return `${value.filter((item) => item === true).length} items done`
  if (metric.valueType === 'checklist' && typeof value === 'object' && value !== null) return `${Object.values(value).filter((item) => item === true).length} items done`
  if (typeof value === 'string') return value
  return 'Recorded'
}
