import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import { assertCalendarDate } from '../../db/calendarDate'
import type { CalendarDate } from '../../db/models'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry, isScheduledDate } from '../../domain/trackers/planning'
import type { TrackerValue } from '../../domain/trackers/types'
import { validateTrackerEntryValues } from '../../domain/trackers/schema'

function localDate(): CalendarDate {
  const now = new Date()
  const value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  assertCalendarDate(value)
  return value
}

const dateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

export function TodayPage() {
  const today = useMemo(localDate, [])
  const [trackers, setTrackers] = useState<StoredTrackerDefinition[]>([])
  const [entries, setEntries] = useState<StoredTrackerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [allTrackers, todayEntries] = await Promise.all([localRepository.listTrackers(), localRepository.listTrackerEntriesForDate(today)])
      setTrackers(allTrackers.filter((tracker) => isScheduledDate(tracker, today)))
      setEntries(todayEntries)
    } catch {
      setError('Today’s check-ins could not be loaded from this device.')
    } finally {
      setLoading(false)
    }
  }, [today])

  useEffect(() => { void refresh() }, [refresh])
  const entryByTracker = useMemo(() => new Map(entries.map((entry) => [entry.trackerId, entry])), [entries])

  async function save(tracker: StoredTrackerDefinition, values: Record<string, TrackerValue>, note: string, outcome: 'recorded' | 'skipped') {
    setError('')
    try {
      await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome, values: outcome === 'skipped' ? {} : values, note })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your check-in could not be saved.')
    }
  }

  async function clear(tracker: StoredTrackerDefinition) {
    try {
      await localRepository.deleteTrackerEntry(tracker.id, today)
      await refresh()
    } catch {
      setError('This check-in could not be cleared.')
    }
  }

  return (
    <section className="tracker-page today-page" aria-labelledby="today-title">
      <PageHeader headingId="today-title" eyebrow="YOUR DAILY PRACTICE" title="Today" description={dateLabel(today)} />
      <p className="today-storage-note"><span className="sync-dot" /> Check-ins are saved on this device.</p>
      {error && <div role="alert" className="form-alert">{error}</div>}
      {loading ? <p role="status" className="tracker-loading">Loading today’s trackers…</p> : trackers.length === 0 ? (
        <Surface>
          <EmptyState title="Nothing scheduled today" description="Create an active tracker and choose a schedule to see it here. Your existing progress stays on this device." action={<Link className="button button-primary button-medium" to="/trackers/new">Create a tracker</Link>} />
        </Surface>
      ) : (
        <div className="today-checkin-list">
          {trackers.map((tracker) => <CheckinCard key={tracker.id} tracker={tracker} entry={entryByTracker.get(tracker.id)} onSave={save} onClear={clear} />)}
        </div>
      )}
    </section>
  )
}

type CheckinCardProps = {
  tracker: StoredTrackerDefinition
  entry?: StoredTrackerEntry
  onSave: (tracker: StoredTrackerDefinition, values: Record<string, TrackerValue>, note: string, outcome: 'recorded' | 'skipped') => Promise<void>
  onClear: (tracker: StoredTrackerDefinition) => Promise<void>
}

function CheckinCard({ tracker, entry, onSave, onClear }: CheckinCardProps) {
  const [values, setValues] = useState<Record<string, TrackerValue>>(entry?.values ?? {})
  const [note, setNote] = useState(entry?.note ?? '')
  const [issue, setIssue] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setValues(entry?.values ?? {}); setNote(entry?.note ?? '') }, [entry])

  const setValue = (key: string, value: TrackerValue | undefined) => setValues((current) => {
    const next = { ...current }
    if (value === undefined) delete next[key]
    else next[key] = value
    return next
  })

  async function submit(outcome: 'recorded' | 'skipped') {
    const valueIssue = outcome === 'recorded' ? validateTrackerEntryValues(tracker, values) : undefined
    if (valueIssue) { setIssue(valueIssue.replace(/^[^ ]+ is required\.$/, 'Please complete all required fields.')); return }
    setIssue('')
    setSaving(true)
    await onSave(tracker, values, note, outcome)
    setSaving(false)
  }

  const result = entry?.outcome === 'recorded' ? evaluateTrackerEntry(tracker, entry) : undefined
  const metricInputs = tracker.metrics.map((metric) => {
    const value = values[metric.id]
    if (metric.valueType === 'boolean') return <label className="form-check today-check" key={metric.id}><input type="checkbox" checked={value === true} onChange={(event) => setValue(metric.id, event.target.checked)} /> <span>{metric.name}</span></label>
    if (metric.valueType === 'checklist') return <fieldset className="today-checklist" key={metric.id}><legend>{metric.name}</legend>{metric.checklistItems?.slice().sort((a, b) => a.position - b.position).map((item) => <label className="form-check today-check" key={item.id}><input type="checkbox" checked={typeof value === 'object' && value !== null && !Array.isArray(value) && value[item.id] === true} onChange={(event) => {
      const current = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, TrackerValue> : {}
      setValue(metric.id, { ...current, [item.id]: event.target.checked })
    }} /> <span>{item.label}</span></label>)}</fieldset>
    return <label className="form-field" key={metric.id}><span>{metric.name}{metric.unit ? <em> · {metric.unit}</em> : null}</span><input className="auth-input" type="number" min="0" step={metric.valueType === 'duration' ? '1' : 'any'} value={typeof value === 'number' ? value : ''} onChange={(event) => setValue(metric.id, event.target.value === '' ? undefined : Number(event.target.value))} /></label>
  })

  return (
    <Surface className="today-checkin-card">
      <div className="today-checkin-heading"><div><span className="tracker-kind-chip">{tracker.kind}</span><h2>{tracker.name}</h2>{tracker.description && <p>{tracker.description}</p>}</div>{entry && <span className={`today-state ${entry.outcome}`}>{entry.outcome === 'skipped' ? 'Skipped' : result?.qualified ? 'Success rule met' : 'Logged'}</span>}</div>
      <div className="today-entry-fields">
        {metricInputs}
        {tracker.customFields.slice().sort((a, b) => a.position - b.position).map((field) => <CustomField key={field.id} field={field} value={values[`field:${field.id}`]} setValue={(value) => setValue(`field:${field.id}`, value)} />)}
        <label className="form-field form-field-wide"><span>Note <em>· optional</em></span><textarea className="auth-input tracker-textarea" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      </div>
      {issue && <p className="today-validation" role="alert">{issue}</p>}
      {entry?.outcome === 'recorded' && result && <p className="today-result" role="status">{result.qualified ? 'Your configured success rule is met.' : 'Saved. The configured success rule is not met yet.'}</p>}
      <div className="today-actions">
        <button className="button button-primary button-medium" disabled={saving} onClick={() => void submit('recorded')}>{saving ? 'Saving…' : entry?.outcome === 'recorded' ? 'Update check-in' : 'Save check-in'}</button>
        <button className="button button-quiet button-medium" disabled={saving} onClick={() => void submit('skipped')}>Skip today</button>
        {entry && <button className="button button-quiet button-medium" disabled={saving} onClick={() => void onClear(tracker)}>Clear check-in</button>}
      </div>
    </Surface>
  )
}

type CustomFieldProps = { field: StoredTrackerDefinition['customFields'][number]; value: TrackerValue | undefined; setValue: (value: TrackerValue | undefined) => void }
function CustomField({ field, value, setValue }: CustomFieldProps) {
  const label = <span>{field.name}{field.required ? <em> · required</em> : <em> · optional</em>}</span>
  if (field.type === 'boolean') return <label className="form-check today-check"><input type="checkbox" checked={value === true} onChange={(event) => setValue(event.target.checked)} /> {field.name}{field.required && <em> · required</em>}</label>
  if (field.type === 'multi-select') return <fieldset className="today-checklist"><legend>{field.name}{field.required ? ' · required' : ''}</legend>{field.options?.map((option) => {
    const selected = Array.isArray(value) && value.includes(option)
    return <label className="form-check today-check" key={option}><input type="checkbox" checked={selected} onChange={(event) => setValue(event.target.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value.filter((item) => item !== option) : []))} /> <span>{option}</span></label>
  })}</fieldset>
  const select = field.type === 'single-select'
  const multiline = field.type === 'long-text'
  const type = field.type === 'integer' || field.type === 'decimal' || field.type === 'duration' || field.type === 'rating' || field.type === 'quantity' ? 'number' : field.type === 'date' || field.type === 'time' ? field.type : field.type === 'url' ? 'url' : 'text'
  const textValue = typeof value === 'string' ? value : ''
  const numberValue = typeof value === 'number' ? value : ''
  return <label className="form-field"><span>{label}{field.unit ? <em> · {field.unit}</em> : null}</span>{select ? <select className="auth-input" value={textValue} onChange={(event) => setValue(event.target.value || undefined)}><option value="">Choose…</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select> : multiline ? <textarea className="auth-input tracker-textarea" value={textValue} onChange={(event) => setValue(event.target.value || undefined)} /> : <input className="auth-input" type={type} step={field.type === 'integer' || field.type === 'rating' || field.type === 'duration' ? '1' : 'any'} value={type === 'number' ? numberValue : textValue} onChange={(event) => setValue(type === 'number' ? event.target.value === '' ? undefined : Number(event.target.value) : event.target.value || undefined)} />}</label>
}
