import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry, isScheduledDate } from '../../domain/trackers/planning'
import type { TrackerValue } from '../../domain/trackers/types'
import { validateTrackerEntryValues } from '../../domain/trackers/schema'
import { calendarDateLabel, localCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { TrackerEntryFields } from '../shared/TrackerEntryFields'

const dateLabel = (value: string) => calendarDateLabel(value, { weekday: 'long', month: 'long', day: 'numeric' })

export function TodayPage() {
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [trackers, setTrackers] = useState<StoredTrackerDefinition[]>([])
  const [entries, setEntries] = useState<StoredTrackerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    setLoadError('')
    try {
      const [allTrackers, todayEntries] = await Promise.all([localRepository.listTrackers(), localRepository.listTrackerEntriesForDate(today)])
      setTrackers(allTrackers.filter((tracker) => isScheduledDate(tracker, today)))
      setEntries(todayEntries)
    } catch {
      setLoadError('Today’s check-ins could not be loaded from this device.')
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
      {loadError && <div role="alert" className="form-alert">{loadError}</div>}
      {loading ? <p role="status" className="tracker-loading">Loading today’s trackers…</p> : loadError ? <Surface><EmptyState title="Your check-ins are still here" description="This device could not open local storage. Try loading today’s trackers again." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : trackers.length === 0 ? (
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

  return (
    <Surface className="today-checkin-card">
      <div className="today-checkin-heading"><div><span className="tracker-kind-chip">{tracker.kind}</span><h2>{tracker.name}</h2>{tracker.description && <p>{tracker.description}</p>}</div>{entry && <span className={`today-state ${entry.outcome}`}>{entry.outcome === 'skipped' ? 'Skipped' : result?.qualified ? 'Success rule met' : 'Logged'}</span>}</div>
      <div>
        <TrackerEntryFields tracker={tracker} values={values} setValue={setValue} />
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
