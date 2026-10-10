import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, insightsSectionTabs } from '../../components/ui/SectionTabs'
import { ActivityStatusIcon } from '../../components/ui/ActivityStatusIcon'
import { Surface } from '../../components/ui/Surface'
import { useToast } from '../../components/ui/ToastProvider'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import { useAuth } from '../auth/AuthProvider'
import type { AccountHoliday, CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry } from '../../domain/trackers/planning'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { assertDateRange } from '../../db/calendarDate'
import { validateTrackerEntryValues } from '../../domain/trackers/schema'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import type { TrackerValue } from '../../domain/trackers/types'
import { TrackerEntryFields } from '../shared/TrackerEntryFields'

type HistoryRange = '7' | '30' | '90' | 'custom'

export function HistoryPage() {
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending } = useAuth()
  const owner = status === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === owner
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [searchParams] = useSearchParams()
  const initialDate = searchParams.get('date')
  const [range, setRange] = useState<HistoryRange>(initialDate ? 'custom' : '30')
  const [customStart, setCustomStart] = useState<string>(() => initialDate ?? shiftCalendarDate(today, -29))
  const [customEnd, setCustomEnd] = useState<string>(() => initialDate ?? today)
  const [trackerFilter, setTrackerFilter] = useState('all')
  const [trackers, setTrackers] = useState<StoredTrackerDefinition[]>([])
  const [entries, setEntries] = useState<StoredTrackerEntry[]>([])
  const [holidays, setHolidays] = useState<AccountHoliday[]>([])
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

  useEffect(() => {
    const date = searchParams.get('date')
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setRange('custom')
      setCustomStart(date)
      setCustomEnd(date)
    }
  }, [searchParams])

  const refresh = useCallback(async () => {
    const request = ++rangeRequest.current
    if (!workspaceReady) return
    if (rangeIssue) {
      setLoading(false)
      setError('')
      setEntries([])
      setHolidays([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const [allTrackers, recentEntries, recentHolidays] = await Promise.all([
        localRepository.listTrackers(true),
        localRepository.listTrackerEntriesBetween(startDate, endDate),
        localRepository.listAccountHolidays(startDate, endDate),
      ])
      if (request !== rangeRequest.current) return
      setTrackers(allTrackers)
      setEntries(recentEntries)
      setHolidays(recentHolidays)
    } catch {
      if (request !== rangeRequest.current) return
      setError('Your check-in history could not be loaded from this device.')
    } finally {
      if (request === rangeRequest.current) setLoading(false)
    }
  }, [endDate, rangeIssue, startDate, workspaceReady])

  useEffect(() => {
    if (workspaceReady) void refresh()
    return () => { rangeRequest.current += 1 }
  }, [refresh, workspaceReady])
  useWorkspaceDataChanges(owner, workspaceReady, refresh)
  const trackerMap = useMemo(() => new Map(trackers.map((tracker) => [tracker.id, tracker])), [trackers])
  const filtered = entries.filter((entry) => trackerFilter === 'all' || entry.trackerId === trackerFilter)
  const grouped = rangeIssue ? [] : groupByDate(filtered)
  const qualifiedCount = filtered.filter((entry) => {
    const tracker = trackerMap.get(entry.trackerId)
    return tracker && entry.outcome === 'recorded' && evaluateTrackerEntry(tracker, entry).qualified
  }).length

  return (
    <section className="tracker-page history-page" aria-labelledby="history-title">
      <PageHeader headingId="history-title" eyebrow="YOUR RECORD" title="History" description="Review and update past check-ins without losing the original timeline." help={{ title: 'History', summary: 'Find, review, and correct saved check-ins.', description: 'Use the date range and tracker filters to narrow the timeline. Editing an entry changes that saved entry and may change calculated streaks or goal progress. Deleting a check-in removes that local entry and queues the change for account sync when available.' }} />
      <SectionTabs label="Insights sections" items={insightsSectionTabs} />
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
      {holidays.length > 0 && <section className="history-holiday-list" aria-label="Holidays in this date range"><h2>Holidays & breaks</h2>{holidays.map((holiday) => <p key={holiday.id}><span className="status-mark holiday"><ActivityStatusIcon status="holiday" /></span> <strong>{calendarDateLabel(holiday.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong>{holiday.reason ? ` · ${holiday.reason}` : ''} · scheduled opportunities paused; any saved check-ins below remain unchanged.</p>)}</section>}
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
  const { notify } = useToast()
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, TrackerValue>>(entry.values)
  const [invalidInputs, setInvalidInputs] = useState<Set<string>>(() => new Set())
  const [note, setNote] = useState(entry.note)
  const [entryOutcome, setEntryOutcome] = useState<StoredTrackerEntry['outcome']>(entry.outcome)
  const [saving, setSaving] = useState(false)
  const [issue, setIssue] = useState('')
  const setValue = (key: string, value: TrackerValue | undefined) => setValues((current) => {
    const next = { ...current }
    if (value === undefined) delete next[key]
    else next[key] = value
    return next
  })
  function setInputValidity(key: string, valid: boolean) {
    setInvalidInputs((current) => {
      const next = new Set(current)
      if (valid) next.delete(key); else next.add(key)
      return next
    })
  }
  async function saveChanges() {
    if (entryOutcome === 'recorded' && invalidInputs.size > 0) {
      setIssue('Finish or correct the highlighted number fields before saving.')
      return
    }
    // Historical values may predate a newly selected precision; allow edits without rewriting their meaning.
    const validationIssue = entryOutcome === 'recorded' ? validateTrackerEntryValues(tracker, values, { enforcePrecision: false }) : undefined
    if (validationIssue) {
      setIssue(validationIssue.replace(/^[^ ]+ is required\.$/, 'Please complete all required fields.'))
      return
    }
    setIssue('')
    setSaving(true)
    try {
      await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: entry.date, outcome: entryOutcome, values: entryOutcome === 'skipped' ? {} : values, note })
      await onSaved()
      setEditing(false)
      notify({ kind: 'success', title: 'Check-in updated', description: 'Your progress has been saved on this device.', dedupeKey: `checkin:${tracker.id}:${entry.date}` })
    } catch {
      notify({ kind: 'error', title: 'Couldn’t update check-in', description: 'Your changes were not saved. Please try again.', duration: 0, dedupeKey: `checkin:${tracker.id}:${entry.date}` })
    } finally {
      setSaving(false)
    }
  }
  const outcomeLabel = entry.outcome === 'skipped' ? 'Skipped' : qualifies ? 'Completed · success rule met' : 'Partial progress logged'
  const statusClass = entry.outcome === 'skipped' ? 'skipped' : qualifies ? 'completed' : 'partial'
  return <Surface className={`history-entry-card status-card status-${statusClass}`}><div className="history-entry-header"><div><span className="tracker-kind-chip">{tracker.kind}</span><h3>{tracker.name}</h3></div><span className={`history-outcome ${statusClass}`}>{outcomeLabel}</span></div>
    {!editing && <button className="button button-secondary button-medium" disabled={tracker.status === 'archived'} onClick={() => { setValues(entry.values); setNote(entry.note); setEntryOutcome(entry.outcome); setInvalidInputs(new Set()); setEditing(true) }}>Edit check-in</button>}
    {tracker.status === 'archived' && !editing && <p className="history-entry-note">Archived trackers’ check-ins are read-only.</p>}
    {editing && <div className="history-edit-form">
      <label className="form-field"><span>Outcome</span><select className="auth-input" value={entryOutcome} onChange={(event) => setEntryOutcome(event.target.value as StoredTrackerEntry['outcome'])}><option value="recorded">Recorded</option><option value="skipped">Skipped</option></select></label>
      {entryOutcome === 'recorded' && <TrackerEntryFields tracker={tracker} values={values} setValue={setValue} date={entry.date} today={entry.date} onInputValidityChange={setInputValidity} />}
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
  if (typeof value === 'number') return formatTrackerNumber(value)
  if (metric.valueType === 'checklist' && Array.isArray(value)) return `${value.filter((item) => item === true).length} items done`
  if (metric.valueType === 'checklist' && typeof value === 'object' && value !== null) return `${Object.values(value).filter((item) => item === true).length} items done`
  if (typeof value === 'string') return value
  return 'Recorded'
}
