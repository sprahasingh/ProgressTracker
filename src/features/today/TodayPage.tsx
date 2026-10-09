import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { AccountHoliday, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry, isScheduledDate } from '../../domain/trackers/planning'
import type { TrackerValue } from '../../domain/trackers/types'
import { validateTrackerEntryValues } from '../../domain/trackers/schema'
import { getTrackerActivityStatus } from '../../domain/trackers/activityStatus'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { TrackerEntryFields } from '../shared/TrackerEntryFields'

export function TodayPage() {
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [allTrackers, setAllTrackers] = useState<StoredTrackerDefinition[]>([])
  const [upcomingGoals, setUpcomingGoals] = useState<StoredTrackerDefinition[]>([])
  const [entries, setEntries] = useState<StoredTrackerEntry[]>([])
  const [weekEntries, setWeekEntries] = useState<StoredTrackerEntry[]>([])
  const [todayHoliday, setTodayHoliday] = useState<AccountHoliday | undefined>()
  const [holidayDates, setHolidayDates] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    setLoadError('')
    try {
      const [allTrackers, recentEntries, holidays] = await Promise.all([
        localRepository.listTrackers(),
        localRepository.listTrackerEntriesBetween(shiftCalendarDate(today, -6), today),
        localRepository.listAccountHolidays(shiftCalendarDate(today, -6), today),
      ])
      const todayEntries = recentEntries.filter((entry) => entry.date === today)
      setAllTrackers(allTrackers)
      setUpcomingGoals(allTrackers.filter((tracker) => tracker.kind === 'goal' && tracker.status === 'active' && tracker.deadline && tracker.deadline >= today && tracker.deadline <= shiftCalendarDate(today, 14))
        .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? '')).slice(0, 3))
      setEntries(todayEntries)
      setWeekEntries(recentEntries)
      setHolidayDates(holidays.map((holiday) => holiday.date))
      setTodayHoliday(holidays.find((holiday) => holiday.date === today))
    } catch {
      setLoadError('Today’s check-ins could not be loaded from this device.')
    } finally {
      setLoading(false)
    }
  }, [today])

  useEffect(() => { void refresh() }, [refresh])
  const trackers = useMemo(() => todayHoliday ? [] : allTrackers.filter((tracker) => isScheduledDate(tracker, today)), [allTrackers, today, todayHoliday])
  const entryByTracker = useMemo(() => new Map(entries.map((entry) => [entry.trackerId, entry])), [entries])
  const loggedCount = trackers.reduce((count, tracker) => count + (entryByTracker.has(tracker.id) ? 1 : 0), 0)
  const recordedCount = trackers.reduce((count, tracker) => count + (entryByTracker.get(tracker.id)?.outcome === 'recorded' ? 1 : 0), 0)
  const remainingCount = Math.max(0, trackers.length - loggedCount)
  const allRecorded = trackers.length > 0 && recordedCount === trackers.length
  const weekPattern = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = shiftCalendarDate(today, index - 6)
    const scheduled = allTrackers.filter((tracker) => isScheduledDate(tracker, date))
    const isToday = date === today
    const isHoliday = holidayDates.includes(date)
    const statuses = scheduled.map((tracker) => getTrackerActivityStatus({ tracker, entry: weekEntries.find((entry) => entry.trackerId === tracker.id && entry.date === date), date, today, holidays: new Set(holidayDates) }))
    const done = isHoliday ? 0 : statuses.filter((status) => status === 'completed').length
    const partial = statuses.some((status) => status === 'partial')
    const state = isHoliday ? 'holiday' : scheduled.length === 0 ? 'rest' : done === scheduled.length ? 'complete' : done > 0 || partial ? 'partial' : isToday ? 'today' : 'missed'
    return { date, scheduled: isHoliday ? 0 : scheduled.length, done, isToday, isHoliday, state }
  }), [today, allTrackers, weekEntries, holidayDates])

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
      <PageHeader headingId="today-title" eyebrow="YOUR DAILY RHYTHM" title="Today" description="Small steps count. Pick up where you are." help={{ title: 'Today', summary: 'Record today’s progress with the least friction.', description: 'Each active tracker appears when today is a scheduled opportunity. Enter its metric values, optional details, and notes, then save the check-in. A skipped day is recorded separately from no activity. Your week pattern marks scheduled completion and rest days; the workspace time zone determines today.' }} />
      <p className="today-storage-note"><span className="sync-dot" /> Saved on this device first. Signed-in workspaces sync when online; guest data stays separate.</p>
      {todayHoliday && <Surface className="today-holiday-banner"><span className="status-mark holiday" aria-hidden="true">☀</span><div><strong>Today is a holiday</strong><p>{todayHoliday.reason ? `${todayHoliday.reason[0]!.toUpperCase()}${todayHoliday.reason.slice(1)} · ` : ''}Your scheduled goals and streaks are paused today. Recorded activity remains saved.</p></div><Link to={`/holidays?date=${today}`}>Manage holidays</Link></Surface>}
      {!loading && !loadError && allTrackers.length > 0 && <section className="week-rhythm surface" aria-labelledby="week-rhythm-title">
        <header className="week-rhythm-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> YOUR PATTERN</span><h2 id="week-rhythm-title">A week of little wins</h2></div><span className="week-rhythm-count">{weekPattern.filter((day) => day.done > 0).length}<small> / 7 days</small></span></header>
        <div className="week-rhythm-days" role="list" aria-label="Check-in pattern for the last seven days">
          {weekPattern.map((day) => <div className={`week-rhythm-day ${day.state}`} key={day.date} role="listitem" aria-label={`${calendarDateLabel(day.date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${day.isHoliday ? 'holiday' : day.scheduled === 0 ? 'rest day' : `${day.done} of ${day.scheduled} check-ins`}${day.isToday ? ', today' : ''}`}>
            <span className="week-rhythm-weekday">{calendarDateLabel(day.date, { weekday: 'short' })}</span>
            <span className="week-rhythm-mark" aria-hidden="true">{day.isHoliday ? '☀' : day.state === 'rest' ? '·' : day.done === day.scheduled && day.scheduled > 0 ? '✓' : day.done > 0 ? '•' : day.isToday ? '＋' : '○'}</span>
            <span className="week-rhythm-date">{Number(day.date.slice(-2))}</span>
          </div>)}
        </div>
        <p className="week-rhythm-caption">Rest days are part of your rhythm too.</p>
      </section>}
      {!loading && !loadError && trackers.length > 0 && <section className={`today-overview surface${allRecorded ? ' all-handled' : ''}`} aria-label="Today at a glance">
        <div className="today-overview-copy"><span className="eyebrow"><span className="eyebrow-line" /> TODAY AT A GLANCE</span><h2>{remainingCount === 0 ? allRecorded ? 'You showed up for yourself today!' : 'Today is wrapped up.' : `${remainingCount} small ${remainingCount === 1 ? 'step' : 'steps'} to go`}</h2><p>{loggedCount} of {trackers.length} scheduled {trackers.length === 1 ? 'activity' : 'activities'} checked in{entries.some((entry) => entry.outcome === 'skipped') ? ' · skipped activities stay neutral' : ''}.</p></div>
        <div className="today-progress" role="img" aria-label={`${loggedCount} of ${trackers.length} scheduled activities logged`}><span>{loggedCount}<small> / {trackers.length}</small></span><div className="today-progress-track"><i style={{ width: `${trackers.length ? loggedCount / trackers.length * 100 : 0}%` }} /></div><small>logged today</small></div>
      </section>}
      {!loading && !loadError && upcomingGoals.length > 0 && <section className="today-upcoming-goals" aria-labelledby="today-upcoming-title">
        <header><div><span className="eyebrow"><span className="eyebrow-line" /> NEXT UP</span><h2 id="today-upcoming-title">Coming up soon</h2></div><Link to="/goals">All goals <span aria-hidden="true">→</span></Link></header>
        <div className="today-upcoming-list">{upcomingGoals.map((goal) => {
          const days = Math.round((Date.parse(`${goal.deadline}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000)
          const deadlineText = days === 0 ? 'Due today' : days === 1 ? '1 day left' : `${days} days left`
          return <Link className="today-upcoming-goal" key={goal.id} to="/goals"><span className="tracker-kind-chip">Goal</span><strong>{goal.name}</strong><span className={days <= 3 ? 'deadline-soon' : ''}>{deadlineText} · {calendarDateLabel(goal.deadline!)}</span></Link>
        })}</div>
      </section>}
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
      {todayHoliday && entries.length > 0 && <section className="today-holiday-records" aria-label="Activity recorded on this holiday"><h2>Activity saved on this day</h2>{entries.map((entry) => <p key={entry.id}><strong>{allTrackers.find((tracker) => tracker.id === entry.trackerId)?.name ?? 'Tracker'}</strong> · {entry.outcome === 'skipped' ? 'Skipped' : 'Progress recorded'}{entry.note ? ` · ${entry.note}` : ''}</p>)}<Link to={`/history?date=${today}`}>View full activity history</Link></section>}
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
  const firstMetric = tracker.metrics[0]
  const quickBooleanMetric = tracker.metrics.length === 1 && firstMetric?.valueType === 'boolean' ? firstMetric : undefined
  const canOneTapComplete = Boolean(quickBooleanMetric) && tracker.customFields.length === 0
  useEffect(() => { setValues(entry?.values ?? {}); setNote(entry?.note ?? '') }, [entry])

  const setValue = (key: string, value: TrackerValue | undefined) => setValues((current) => {
    const next = { ...current }
    if (value === undefined) delete next[key]
    else next[key] = value
    return next
  })

  async function submit(outcome: 'recorded' | 'skipped', valuesToSave = values) {
    const valueIssue = outcome === 'recorded' ? validateTrackerEntryValues(tracker, valuesToSave) : undefined
    if (valueIssue) { setIssue(valueIssue.replace(/^[^ ]+ is required\.$/, 'Please complete all required fields.')); return }
    setIssue('')
    setSaving(true)
    await onSave(tracker, valuesToSave, note, outcome)
    setSaving(false)
  }

  const result = entry?.outcome === 'recorded' ? evaluateTrackerEntry(tracker, entry) : undefined

  return (
    <Surface className={`today-checkin-card${entry?.outcome === 'recorded' ? ' checked-in' : ''}`}>
      <div className="today-checkin-heading"><div><span className="tracker-kind-chip">{tracker.kind}</span><h2>{tracker.name}</h2>{tracker.description && <p>{tracker.description}</p>}</div>{entry && <span className={`today-state ${entry.outcome}`}>{entry.outcome === 'skipped' ? 'Skipped' : result?.qualified ? 'Success rule met' : 'Logged'}</span>}</div>
      <div>
        {!(canOneTapComplete && !entry) && <TrackerEntryFields tracker={tracker} values={values} setValue={setValue} />}
        <details className="today-note-details">
          <summary>{note ? 'Edit note' : 'Add a note'} <span>optional</span></summary>
          <label className="form-field form-field-wide"><span className="visually-hidden">Note</span><textarea className="auth-input tracker-textarea" value={note} onChange={(event) => setNote(event.target.value)} placeholder="A thought for later, if you like." /></label>
        </details>
      </div>
      {issue && <p className="today-validation" role="alert">{issue}</p>}
      {entry?.outcome === 'recorded' && result && <p className="today-result" role="status">{result.qualified ? 'Your configured success rule is met.' : 'Saved. The configured success rule is not met yet.'}</p>}
      <div className="today-actions">
        <button className="button button-primary button-medium" disabled={saving} onClick={() => void submit('recorded', canOneTapComplete && !entry && quickBooleanMetric ? { [quickBooleanMetric.id]: true } : values)}>{saving ? 'Saving…' : entry?.outcome === 'recorded' ? 'Update check-in' : canOneTapComplete ? 'Mark complete' : 'Save check-in'}</button>
        <button className="button button-quiet button-medium" disabled={saving} onClick={() => void submit('skipped')}>Skip today</button>
        {entry && <button className="button button-quiet button-medium" disabled={saving} onClick={() => void onClear(tracker)}>Clear check-in</button>}
      </div>
    </Surface>
  )
}
