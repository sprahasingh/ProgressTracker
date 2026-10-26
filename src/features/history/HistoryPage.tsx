import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, insightsSectionTabs } from '../../components/ui/SectionTabs'
import { ActivityStatusIcon } from '../../components/ui/ActivityStatusIcon'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import { useAuth } from '../auth/AuthProvider'
import type { AccountHoliday, CalendarDate, StoredTrackerDefinition, StoredTrackerEntry, TrackerHoliday } from '../../db/models'
import { evaluateTrackerEntry, isTrackerInActivePeriod, trackerActiveStartDate } from '../../domain/trackers/planning'
import { ACTIVITY_STATUS_PRESENTATION, getTrackerActivityStatus, type ActivityStatus } from '../../domain/trackers/activityStatus'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { assertDateRange } from '../../db/calendarDate'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { selectMissingCheckIns, type MissingCheckIn } from '../../domain/trackers/missingCheckIns'
import { getChallengeDayDisplay } from '../../domain/trackers/challengeDay'
import { evaluateMilestones } from '../../domain/trackers/milestones'

type HistoryRange = '7' | '30' | '90' | 'custom'

export function HistoryPage() {
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const owner = status === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === owner
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [searchParams] = useSearchParams()
  const initialDate = searchParams.get('date')
  const [range, setRange] = useState<HistoryRange>(initialDate ? 'custom' : '30')
  const [customStart, setCustomStart] = useState<string>(() => initialDate ?? shiftCalendarDate(today, -29))
  const [customEnd, setCustomEnd] = useState<string>(() => initialDate ?? today)
  const [addDate, setAddDate] = useState<string>(() => initialDate ?? today)
  const [trackerFilter, setTrackerFilter] = useState('all')
  const [trackers, setTrackers] = useState<StoredTrackerDefinition[]>([])
  const [entries, setEntries] = useState<StoredTrackerEntry[]>([])
  const [milestoneEntries, setMilestoneEntries] = useState<StoredTrackerEntry[]>([])
  const [holidays, setHolidays] = useState<AccountHoliday[]>([])
  const [trackerHolidayRows, setTrackerHolidayRows] = useState<TrackerHoliday[]>([])
  const [challengeHolidays, setChallengeHolidays] = useState<ReadonlySet<string>>(new Set())
  const [missing, setMissing] = useState<MissingCheckIn[]>([])
  const [loading, setLoading] = useState(true)
  const [existingCheckIn, setExistingCheckIn] = useState<{ key: string; status: 'loading' | 'ready' | 'error'; exists: boolean }>({ key: '', status: 'loading', exists: false })
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

  useEffect(() => {
    if (location.hash !== '#missing-checkins') return
    const frame = window.requestAnimationFrame(() => document.getElementById('missing-checkins')?.scrollIntoView({ block: 'start' }))
    return () => window.cancelAnimationFrame(frame)
  }, [location.hash])

  const refresh = useCallback(async () => {
    const request = ++rangeRequest.current
    if (!workspaceReady) return
    if (rangeIssue) {
      setLoading(false)
      setError('')
      setEntries([])
      setMilestoneEntries([])
      setHolidays([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const missingStart = shiftCalendarDate(today, -7) as CalendarDate
      const missingEnd = shiftCalendarDate(today, -1) as CalendarDate
      const [allTrackers, recentEntries, recentHolidays, missingEntries, missingHolidays, allHolidays, recentTrackerHolidays, missingTrackerHolidays] = await Promise.all([
        localRepository.listTrackers(true),
        localRepository.listTrackerEntriesBetween(startDate, endDate),
        localRepository.listAccountHolidays(startDate, endDate),
        localRepository.listTrackerEntriesBetween(missingStart, missingEnd),
        localRepository.listAccountHolidays(missingStart, missingEnd),
        localRepository.listAccountHolidays(),
        localRepository.listTrackerHolidays(startDate, endDate),
        localRepository.listTrackerHolidays(missingStart, missingEnd),
      ])
      const milestoneHistory = (await Promise.all(allTrackers.filter((tracker) => tracker.milestones.length > 0).map((tracker) => localRepository.listTrackerEntriesForTracker(tracker.id)))).flat()
      if (request !== rangeRequest.current) return
      setTrackers(allTrackers)
      setEntries(recentEntries)
      setMilestoneEntries(milestoneHistory)
      setHolidays(recentHolidays)
      setTrackerHolidayRows(recentTrackerHolidays)
      setChallengeHolidays(new Set(allHolidays.map((holiday) => holiday.date)))
      setMissing(selectMissingCheckIns({ trackers: allTrackers, entries: missingEntries, holidays: new Set(missingHolidays.map((holiday) => holiday.date)), trackerHolidays: missingTrackerHolidays, dates: Array.from({ length: 7 }, (_, index) => shiftCalendarDate(today, -7 + index) as CalendarDate), today, timeZone }))
    } catch {
      if (request !== rangeRequest.current) return
      setError('Your check-in history could not be loaded from this device.')
    } finally {
      if (request === rangeRequest.current) setLoading(false)
    }
  }, [endDate, rangeIssue, startDate, workspaceReady, today, timeZone])

  useEffect(() => {
    if (workspaceReady) void refresh()
    return () => { rangeRequest.current += 1 }
  }, [refresh, workspaceReady])
  useWorkspaceDataChanges(owner, workspaceReady, refresh)
  const trackerMap = useMemo(() => new Map(trackers.map((tracker) => [tracker.id, tracker])), [trackers])
  const visibleEntries = entries.filter((entry) => trackerMap.has(entry.trackerId))
  const filtered = visibleEntries.filter((entry) => trackerFilter === 'all' || entry.trackerId === trackerFilter)
  const grouped = rangeIssue ? [] : groupByDate(filtered)
  const milestoneEvents = useMemo(() => trackers.flatMap((tracker) => {
    if (trackerFilter !== 'all' && tracker.id !== trackerFilter) return []
    const history = milestoneEntries.filter((entry) => entry.trackerId === tracker.id)
    const trackerDates = new Set(trackerHolidayRows.filter((holiday) => holiday.trackerId === tracker.id).map((holiday) => holiday.date))
    return evaluateMilestones({ tracker, entries: history, asOfDate: today, holidays: new Set([...challengeHolidays, ...trackerDates]), timeZone })
      .filter((milestone) => milestone.completed && milestone.reachedDate !== null && milestone.reachedDate >= startDate && milestone.reachedDate <= endDate)
      .map((milestone) => ({ tracker, milestone }))
  }), [trackers, milestoneEntries, trackerFilter, today, challengeHolidays, timeZone, startDate, endDate])
  const qualifiedCount = filtered.filter((entry) => {
    const tracker = trackerMap.get(entry.trackerId)
    return tracker && isTrackerInActivePeriod(tracker, entry.date, timeZone) && entry.outcome === 'recorded' && evaluateTrackerEntry(tracker, entry).qualified
  }).length
  const historicalCount = filtered.filter((entry) => {
    const tracker = trackerMap.get(entry.trackerId)
    return tracker && !isTrackerInActivePeriod(tracker, entry.date, timeZone)
  }).length
  const addTracker = trackerMap.get(trackerFilter)
  const parsedAddDate = Date.parse(`${addDate}T00:00:00.000Z`)
  const addDateValid = /^\d{4}-\d{2}-\d{2}$/.test(addDate) && Number.isFinite(parsedAddDate) && new Date(parsedAddDate).toISOString().slice(0, 10) === addDate && addDate <= today
  const addIssue = !addTracker ? 'Select a tracker to add or edit a check-in.'
    : !addDateValid ? 'Choose a valid date that is today or earlier in this workspace time zone.'
      : addTracker.deletedAt !== null ? 'Deleted trackers cannot receive check-ins.'
        : addTracker.status === 'archived' ? 'Archived trackers are read-only. Restore the tracker to edit its check-ins.'
          : addTracker.status === 'paused' ? 'Paused trackers cannot receive check-ins. Resume the tracker to continue.'
            : addTracker.status === 'completed' ? 'Completed trackers cannot receive new check-ins.'
        : addDate < trackerActiveStartDate(addTracker, timeZone) ? `Choose the tracker start date or later (${calendarDateLabel(trackerActiveStartDate(addTracker, timeZone))}).`
          : addTracker.deadline && addDate > addTracker.deadline ? `Choose a date on or before the tracker deadline (${calendarDateLabel(addTracker.deadline)}).`
            : ''
  const addLookupKey = addTracker && !addIssue ? `${addTracker.id}:${addDate}` : ''
  const addLookupLoading = Boolean(addLookupKey) && (existingCheckIn.key !== addLookupKey || existingCheckIn.status === 'loading')

  useEffect(() => {
    if (!addLookupKey || !addTracker) return
    let active = true
    setExistingCheckIn({ key: addLookupKey, status: 'loading', exists: false })
    void localRepository.getTrackerEntry(addTracker.id, addDate as CalendarDate).then((entry) => {
      if (active) setExistingCheckIn({ key: addLookupKey, status: 'ready', exists: Boolean(entry) })
    }).catch(() => {
      if (active) setExistingCheckIn({ key: addLookupKey, status: 'error', exists: false })
    })
    return () => { active = false }
  }, [addLookupKey, addTracker, addDate])

  return (
    <section className="tracker-page history-page insights-page" aria-labelledby="history-title">
      <PageHeader headingId="history-title" eyebrow="YOUR RECORD" title="History" description="Review and update previous check-ins." help={{ title: 'History', summary: 'Find, review, and correct saved check-ins.', description: 'Use the date range and tracker filters to narrow the timeline. Editing an entry changes that saved entry and may change calculated streaks or goal progress. Deleting a check-in removes that local entry and queues the change for account sync when available.' }} />
      <SectionTabs label="Insights sections" items={insightsSectionTabs} />
      <p className="insights-progression-link">Reward and XP history: <Link to="/achievements">Wins</Link>.</p>
      <section className={`history-missing-section${missing.length === 0 ? ' is-clear' : ''}`} id="missing-checkins" aria-labelledby="missing-checkins-title">
        <div className="history-missing-heading"><div><h2 id="missing-checkins-title">Missing Check-Ins</h2>{missing.length > 0 && <p>Required past dates without a saved check-in.</p>}</div><span className="history-missing-count" aria-label={`${missing.length} unresolved check-ins`}>{missing.length}</span></div>
        {missing.length === 0 ? <p className="history-missing-empty">You’re all caught up for the last seven completed days.</p> : groupMissingByDate(missing).map(([date, dayItems]) => <div className="history-missing-day" key={date}><h3>{calendarDateLabel(date, { weekday: 'long', month: 'long', day: 'numeric' })}</h3><ul>{dayItems.map(({ tracker }) => <li key={tracker.id}><span><strong>{tracker.name}</strong></span><button type="button" className="button button-secondary button-small" onClick={() => navigate('/', { state: { openActivity: { trackerId: tracker.id, date } } })}>Review</button></li>)}</ul></div>)}
        <p className="history-missing-note"><Link to="/calendar">View older dates in Calendar</Link></p>
      </section>
      <section className="history-filters-section" aria-labelledby="history-filters-title">
      <h2 id="history-filters-title" className="history-section-title">Check-in History and Filters</h2>
      <div className="history-toolbar">
        <div className="history-filter history-range-filter"><span>Date range</span><select aria-label="Date range" className="auth-input" value={range} onChange={(event) => setRange(event.target.value as HistoryRange)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select>{range === 'custom' && <div className="history-custom-dates"><label className="history-filter"><span>From</span><input className="auth-input" type="date" max={today} value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label className="history-filter"><span>Through</span><input className="auth-input" type="date" max={today} value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}</div>
        <label className="history-filter"><span>Tracker</span><select className="auth-input" value={trackerFilter} onChange={(event) => setTrackerFilter(event.target.value)}><option value="all">All trackers</option>{trackers.map((tracker) => <option key={tracker.id} value={tracker.id}>{tracker.name}</option>)}</select></label>
        <div className="history-edit-controls"><div className="history-add-checkin"><label className="history-filter"><span>Add or edit a date</span><input className="auth-input" type="date" max={today} value={addDate} onChange={(event) => setAddDate(event.target.value)} /></label><button type="button" className="button button-secondary button-small" disabled={Boolean(addIssue) || loading || addLookupLoading || existingCheckIn.status === 'error'} aria-describedby={loading || addIssue || addLookupLoading || existingCheckIn.status === 'error' ? 'history-edit-guidance' : undefined} onClick={() => addTracker && navigate('/', { state: { openActivity: { trackerId: addTracker.id, date: addDate } } })}>{loading && !addTracker ? 'Loading trackers…' : !addTracker ? 'Select a tracker first' : addIssue || existingCheckIn.status === 'error' ? 'Check-in unavailable' : addLookupLoading ? 'Checking check-in…' : existingCheckIn.exists ? 'Edit check-in' : 'Add check-in'}</button></div>{(loading || addIssue || addLookupLoading || existingCheckIn.status === 'error') && <small id="history-edit-guidance" className="history-edit-guidance" role="status">{loading ? 'Loading tracker and check-in availability…' : addIssue || (addLookupLoading ? 'Checking this date’s saved check-in…' : 'Could not verify this check-in. Try changing the date or tracker and try again.')}</small>}</div>
      </div>
      {!loading && <p className="history-count" role="status" aria-live="polite" aria-atomic="true">{filtered.length} check-ins · {qualifiedCount} met the current success rule{historicalCount ? ` · ${historicalCount} outside the current tracker period` : ''}</p>}
      </section>
      <section className="history-records-section" aria-labelledby="history-records-title">
      <h2 id="history-records-title" className="history-section-title">Historical check-in records</h2>
      {rangeIssue && <div role="alert" className="form-alert">{rangeIssue}</div>}
      {error && <div role="alert" className="form-alert">{error}</div>}
      {holidays.length > 0 && <section className="history-holiday-list" aria-label="Holidays in this date range"><h2>Holidays & breaks</h2>{holidays.map((holiday) => <p key={holiday.id}><span className="status-mark holiday"><ActivityStatusIcon status="holiday" /></span> <strong>{calendarDateLabel(holiday.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong>{holiday.reason ? ` · ${holiday.reason}` : ''} · scheduled opportunities paused; any saved check-ins below remain unchanged.</p>)}</section>}
      {milestoneEvents.length > 0 && <section className="history-milestone-events" aria-labelledby="history-milestone-events-title"><h2 id="history-milestone-events-title">Milestones reached</h2><ul>{milestoneEvents.map(({ tracker, milestone }) => <li key={`${tracker.id}:${milestone.milestoneId}:${milestone.reachedDate}`}><div><strong>{milestone.title}</strong><small>{tracker.name} · {milestone.progressLabel}</small></div><Link to={`/calendar?date=${milestone.reachedDate}`}>{calendarDateLabel(milestone.reachedDate!, { month: 'short', day: 'numeric', year: 'numeric' })}</Link></li>)}</ul></section>}
      {rangeIssue ? null : loading ? <p role="status" className="tracker-loading">Loading your history…</p> : error ? <Surface><EmptyState title="Your history is still here" description="This device could not open local storage. Try loading the history again." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : grouped.length === 0 ? <Surface><EmptyState title="No check-ins in this range" description="Your saved activity will appear here. Nothing is filled in until you log it." action={<Link className="button button-primary button-medium" to="/">Go to today</Link>} /></Surface> : <div className="history-timeline">
        {grouped.map(([date, dayEntries]) => <section className="history-day" key={date} aria-labelledby={`history-${date}`}><header className="history-day-heading"><h2 id={`history-${date}`}>{calendarDateLabel(date, { weekday: 'long', month: 'long', day: 'numeric' })}</h2><span>{dayEntries.length} {dayEntries.length === 1 ? 'check-in' : 'check-ins'}</span></header><div className="history-entry-list">{dayEntries.map((entry) => {
          const tracker = trackerMap.get(entry.trackerId)
          if (!tracker) return null
          const activityStatus = getTrackerActivityStatus({ tracker, entry, date: entry.date, today, holidays: new Set(holidays.map((holiday) => holiday.date)), trackerHolidays: new Set(trackerHolidayRows.filter((holiday) => holiday.trackerId === tracker.id).map((holiday) => holiday.date)), timeZone })
          const qualifies = entry.outcome === 'recorded' && evaluateTrackerEntry(tracker, entry).qualified
          const trackerChallengeHolidays = new Set([...challengeHolidays, ...trackerHolidayRows.filter((holiday) => holiday.trackerId === tracker.id).map((holiday) => holiday.date)])
          return <HistoryEntry key={entry.id} tracker={tracker} entry={entry} qualifies={qualifies} status={activityStatus} timeZone={timeZone} holidays={trackerChallengeHolidays} onEdit={() => navigate('/', { state: { openActivity: { trackerId: tracker.id, date: entry.date } } })} />
        })}</div></section>)}
      </div>}
      </section>
      <p className="history-local-note"><span className="sync-dot" /> Your entries are saved offline on this device and sync to your signed-in account when available. Guest activity stays in its separate workspace.</p>
    </section>
  )
}

function groupByDate(entries: StoredTrackerEntry[]): Array<[string, StoredTrackerEntry[]]> {
  const groups = new Map<string, StoredTrackerEntry[]>()
  for (const entry of entries) groups.set(entry.date, [...(groups.get(entry.date) ?? []), entry])
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a))
}

function groupMissingByDate(items: MissingCheckIn[]): Array<[CalendarDate, MissingCheckIn[]]> {
  const groups = new Map<CalendarDate, MissingCheckIn[]>()
  for (const item of items) groups.set(item.date, [...(groups.get(item.date) ?? []), item])
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a))
}

function HistoryEntry({ tracker, entry, qualifies, status, timeZone, holidays, onEdit }: { tracker: StoredTrackerDefinition; entry: StoredTrackerEntry; qualifies: boolean; status: ActivityStatus; timeZone: string; holidays: ReadonlySet<string>; onEdit: () => void }) {
  const outcomeLabel = `${ACTIVITY_STATUS_PRESENTATION[status].label}${entry.outcome === 'skipped' ? ' · intentionally saved' : qualifies ? ' · success rule met' : entry.outcome === 'recorded' ? ' · progress saved' : ''}`
  const statusClass = status === 'rest-day' || status === 'unscheduled' ? 'rest' : status
  const challengeDay = getChallengeDayDisplay(tracker, entry.date, timeZone, holidays)
  return <Surface className={`history-entry-card status-card status-${statusClass}`}><div className="history-entry-header"><div><span className="tracker-kind-chip">{tracker.kind}</span>{tracker.status === 'archived' && <span className="tracker-archived-chip">Archived history</span>}<h3>{tracker.name}</h3>{challengeDay && <p className="challenge-day-label">{challengeDay.label}</p>}</div><span className={`history-outcome ${statusClass}`}>{outcomeLabel}</span></div>
    <>
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
    </>
    {tracker.status === 'active' && tracker.deletedAt === null
      ? <button className="button button-secondary button-medium" type="button" aria-label={`Edit check-in for ${calendarDateLabel(entry.date, { month: 'long', day: 'numeric' })}`} onClick={onEdit}>Edit check-in</button>
      : <p className="history-entry-note">{tracker.deletedAt !== null ? 'Deleted trackers’ check-ins are read-only.' : tracker.status === 'archived' ? 'Archived trackers’ check-ins are read-only.' : tracker.status === 'paused' ? 'Paused trackers’ check-ins are read-only until the tracker is resumed.' : 'Completed trackers’ check-ins are read-only.'}</p>}
  </Surface>
}

function formatMetric(metric: StoredTrackerDefinition['metrics'][number], value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Done' : 'Not Done'
  if (typeof value === 'number') return formatTrackerNumber(value)
  if (metric.valueType === 'checklist' && Array.isArray(value)) return `${value.filter((item) => item === true).length} items done`
  if (metric.valueType === 'checklist' && typeof value === 'object' && value !== null) return `${Object.values(value).filter((item) => item === true).length} items done`
  if (typeof value === 'string') return value
  return 'Recorded'
}
