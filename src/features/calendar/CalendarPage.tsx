import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionHeader } from '../../components/ui/SectionHeader'
import { ActivityStatusIcon } from '../../components/ui/ActivityStatusIcon'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { ACTIVITY_STATUS_PRESENTATION, getTrackerActivityStatus, type ActivityStatus } from '../../domain/trackers/activityStatus'
import { evaluateTrackerEntry } from '../../domain/trackers/planning'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel, localCalendarDate } from '../shared/localDates'
import { useAuth } from '../auth/AuthProvider'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { mondayFirstWeekday } from '../../db/calendarDate'
import { TrackerFilter, useTrackerFilter } from '../shared/TrackerFilter'
import { calculateStreak } from '../../domain/trackers/progression'
import { InfoButton } from '../../components/ui/InfoButton'
import { isTrackerInActivePeriod, trackerActiveStartDate } from '../../domain/trackers/planning'

type CalendarData = { workspaceKey: string; trackers: StoredTrackerDefinition[]; entries: StoredTrackerEntry[]; holidays: string[] }
type DaySummary = { date: CalendarDate; completed: number; partial: number; missed: number; pending: number; entries: number; holiday: boolean; visualStatus: ActivityStatus }

function isCalendarDate(value: string | null): value is CalendarDate {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

export function CalendarPage() {
  const { status: authStatus, user, workspaceStatus, workspaceUserId, sessionTransitionPending } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [searchParams, setSearchParams] = useSearchParams()
  const initialDate = searchParams.get('date')
  const validInitialDate = isCalendarDate(initialDate) ? initialDate : null
  const [month, setMonth] = useState(() => validInitialDate?.slice(0, 7) ?? today.slice(0, 7))
  const [snapshot, setSnapshot] = useState<CalendarData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const expectedOwner = authStatus === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && authStatus !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === expectedOwner
  const workspaceKey = workspaceReady ? expectedOwner ?? 'guest' : null
  const contextRef = useRef({ workspaceKey, ready: workspaceReady })
  contextRef.current = { workspaceKey, ready: workspaceReady }
  const requestRef = useRef(0)
  const selectedDate = useMemo(() => {
    const candidate = searchParams.get('date')
    if (isCalendarDate(candidate)) return candidate
    return today
  }, [searchParams, today])
  const visibleData = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot : null
  const loadingVisible = loading || !workspaceReady || Boolean(workspaceKey && snapshot?.workspaceKey !== workspaceKey)
  const trackerFilter = useTrackerFilter(expectedOwner, visibleData?.trackers ?? [], !loadingVisible)
  const selectedTracker = visibleData?.trackers.find((tracker) => tracker.id === trackerFilter.selectedId) ?? null
  const displayedTrackers = selectedTracker ? [selectedTracker] : visibleData?.trackers ?? []
  const displayedTrackerIds = new Set(displayedTrackers.map((tracker) => tracker.id))
  const displayedEntries = (visibleData?.entries ?? []).filter((entry) => displayedTrackerIds.has(entry.trackerId))

  const refresh = useCallback(async () => {
    const context = contextRef.current
    if (!context.ready || !context.workspaceKey) return
    const request = ++requestRef.current
    const start = `${month}-01` as CalendarDate
    const monthLast = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) as CalendarDate
    const end = monthLast < today ? monthLast : today
    setLoading(true)
    setError('')
    try {
      const trackers = await localRepository.listTrackers(true)
      const earliest = trackers.reduce<CalendarDate>((minimum, tracker) => {
        const first = trackerActiveStartDate(tracker, timeZone)
        return first < minimum ? first as CalendarDate : minimum
      }, start)
      const [entries, holidays] = await Promise.all([
        earliest <= end ? localRepository.listTrackerEntriesBetween(earliest, end) : Promise.resolve([]),
        localRepository.listAccountHolidays(earliest, monthLast),
      ])
      if (requestRef.current === request && contextRef.current.ready && contextRef.current.workspaceKey === context.workspaceKey) {
        setSnapshot({ workspaceKey: context.workspaceKey, trackers, entries, holidays: holidays.map((holiday) => holiday.date) })
      }
    } catch {
      if (requestRef.current === request && contextRef.current.ready && contextRef.current.workspaceKey === context.workspaceKey) setError('The calendar could not be loaded from this device.')
    } finally {
      if (requestRef.current === request) setLoading(false)
    }
  }, [month, today, timeZone])

  useEffect(() => {
    if (!workspaceReady || !workspaceKey) {
      setLoading(true)
      return () => { requestRef.current += 1 }
    }
    void refresh()
    return () => { requestRef.current += 1 }
  }, [refresh, workspaceKey, workspaceReady])
  useWorkspaceDataChanges(expectedOwner, workspaceReady, refresh)

  const summaries = useMemo(() => {
    const [year, monthNumber] = month.split('-').map(Number)
    const daysInMonth = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate()
    const entries = (visibleData?.entries ?? []).filter((entry) => !selectedTracker || entry.trackerId === selectedTracker.id)
    const trackers = selectedTracker ? [selectedTracker] : visibleData?.trackers ?? []
    const holidays = new Set(visibleData?.holidays ?? [])
    return Array.from({ length: daysInMonth }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, '0')}` as CalendarDate
      let completed = 0; let partial = 0; let missed = 0; let pending = 0
      for (const tracker of trackers) {
        if (tracker.deletedAt !== null || tracker.status !== 'active') continue
        const entry = entries.find((item) => item.trackerId === tracker.id && item.date === date)
        const status = getTrackerActivityStatus({ tracker, entry, date, today, holidays, timeZone })
        if (status === 'completed') completed += 1
        if (status === 'partial') partial += 1
        if (status === 'missed') missed += 1
        if (status === 'pending') pending += 1
      }
      const holiday = holidays.has(date)
      const anyExpected = completed + partial + missed + pending > 0
      const visualStatus: ActivityStatus = holiday ? 'holiday'
        : !anyExpected ? 'unscheduled'
          : missed > 0 ? 'missed'
            : partial > 0 ? 'partial'
              : pending > 0 ? 'pending'
                : 'completed'
      return { date, completed, partial, missed, pending, entries: entries.filter((entry) => entry.date === date).length, holiday, visualStatus }
    })
  }, [month, today, visibleData, selectedTracker, timeZone])
  const selectedSummary = summaries.find((day) => day.date === selectedDate)
  const selectedEntries = displayedEntries.filter((entry) => entry.date === selectedDate)
  const selectedHoliday = visibleData?.holidays.includes(selectedDate) ?? false
  const selectedStreak = selectedTracker ? calculateStreak(selectedTracker, (visibleData?.entries ?? []).filter((entry) => entry.trackerId === selectedTracker.id), today, new Set(visibleData?.holidays ?? []), timeZone) : null
  const selectedTrackers = displayedTrackers.filter((tracker) => tracker.deletedAt === null && (
    selectedEntries.some((entry) => entry.trackerId === tracker.id) || tracker.status === 'active'
  )).map((tracker) => {
    const entry = selectedEntries.find((item) => item.trackerId === tracker.id)
    return { tracker, entry, status: getTrackerActivityStatus({ tracker, entry, date: selectedDate, today, holidays: new Set(visibleData?.holidays ?? []), timeZone }) }
  }).filter(({ tracker, status }) => tracker.status === 'active' || status === 'holiday' || status === 'completed' || status === 'partial' || status === 'missed')

  function selectDate(date: CalendarDate) {
    setSearchParams({ date }, { replace: false })
  }
  function changeMonth(value: string) {
    if (!/^\d{4}-\d{2}$/.test(value)) return
    setMonth(value)
    const day = selectedDate.slice(8, 10)
    const lastDay = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0)).getUTCDate()
    selectDate(`${value}-${String(Math.min(Number(day), lastDay)).padStart(2, '0')}` as CalendarDate)
  }

  return <section className="tracker-page calendar-page" aria-labelledby="calendar-title">
    <PageHeader headingId="calendar-title" eyebrow="YOUR ACTIVITY" title="Calendar" description="See what was scheduled, what you completed, and where you took a break." help={{ title: 'Calendar activity', summary: 'All Trackers shows a combined status and per-tracker counts for each day.', description: 'Select one tracker to see only its activity and streak. Holidays keep their Holiday status across trackers; rest days are based on each tracker’s recurrence. A saved voluntary check-in remains visible on holidays and rest days without changing either classification.' }} action={<Link className="button button-primary button-medium" to="/holidays">Manage holidays</Link>} />
    <div className="calendar-toolbar"><TrackerFilter trackers={visibleData?.trackers ?? []} selectedId={trackerFilter.selectedId} onChange={trackerFilter.select} label="Tracker" /><label className="history-filter"><span>Month</span><input className="auth-input" type="month" max={today.slice(0, 7)} value={month} onChange={(event) => changeMonth(event.target.value)} /></label><Link className="button button-quiet button-small" to={`/calendar?date=${today}`}>Today</Link></div>
    <div className="calendar-legend" aria-label="Activity status legend">{(['pending', 'completed', 'partial', 'missed', 'holiday', 'unscheduled'] as const).map((status) => <span key={status}><i className={`calendar-dot ${status}`} aria-hidden="true"><ActivityStatusIcon status={status} /></i>{ACTIVITY_STATUS_PRESENTATION[status].label}</span>)}</div>
    {error && <div role="alert" className="form-alert">{error}</div>}
    {loadingVisible ? <p className="tracker-loading" role="status">Loading your calendar…</p> : error ? <Surface><EmptyState title="Your activity is still saved" description="This device could not open the calendar." action={<button className="button button-secondary button-medium" onClick={() => void refresh()}>Try again</button>} /></Surface> : <div className="calendar-layout">
      <Surface className="calendar-month-card"><h2>{calendarDateLabel(`${month}-01`, { month: 'long', year: 'numeric' })}</h2><MonthCalendar days={summaries} selected={selectedDate} today={today} onSelect={selectDate} /></Surface>
      <Surface className="calendar-day-details" aria-live="polite">
        <SectionHeader className="calendar-day-heading" eyebrow="SELECTED DAY" title={calendarDateLabel(selectedDate, { weekday: 'long', month: 'long', day: 'numeric' })} action={<Link className="button button-quiet button-small" to={`/holidays?date=${selectedDate}`}>{selectedHoliday ? 'Edit holiday' : 'Mark holiday'}</Link>} />
        {selectedHoliday && <p className="calendar-holiday-note"><span className="status-mark holiday"><ActivityStatusIcon status="holiday" /></span> Holiday · scheduled expectations paused{selectedEntries.length ? ` · ${selectedEntries.length} saved check-in${selectedEntries.length === 1 ? '' : 's'} retained` : ''}</p>}
        {!selectedHoliday && selectedSummary && <p className="calendar-day-summary">{selectedSummary.completed} completed · {selectedSummary.partial} partial · {selectedSummary.pending} pending · {selectedSummary.missed} missed · {selectedSummary.entries} saved check-ins</p>}
        {selectedTracker && selectedStreak && <p className="calendar-selected-streak"><strong>{selectedTracker.name}</strong>: {selectedStreak.current} current · {selectedStreak.longest} longest streak <InfoButton title={`${selectedTracker.name} streaks`} summary="Current and longest streaks are recalculated from saved check-ins." description={selectedTracker.strictMode ? 'Strict Mode requires a qualifying check-in on every calendar day within the tracker period, including holidays and rest days. Today stays open until it ends.' : 'Standard Mode counts qualifying scheduled opportunities. Holidays and rest days preserve continuity without adding to the streak; missed scheduled days break it.'} /></p>}
        {selectedTrackers.length === 0 ? <p className="calendar-no-activity">No scheduled tracker activity for this date.</p> : <ul className="calendar-activity-list">{selectedTrackers.map(({ tracker, entry, status }) => <li key={tracker.id}>
          <span className={`calendar-status-mark ${status}`} aria-label={ACTIVITY_STATUS_PRESENTATION[status].label}><ActivityStatusIcon status={status} /></span>
          <div><strong>{tracker.name}</strong><span>{ACTIVITY_STATUS_PRESENTATION[status].label}{entry?.outcome === 'skipped' ? ' · marked intentionally' : entry ? ` · ${selectedHoliday || status === 'unscheduled' ? 'Progress recorded: ' : ''}${formatEntry(tracker, entry)}` : ''}</span>{entry?.note && <small>{entry.note}</small>}</div>
          {entry ? <Link className="button button-quiet button-small" to={`/history?date=${selectedDate}`}>View history</Link> : tracker.status === 'active' && selectedDate <= today && isTrackerInActivePeriod(tracker, selectedDate, timeZone) ? <Link className="button button-quiet button-small" to="/" state={{ openActivity: { trackerId: tracker.id, date: selectedDate } }}>{status === 'unscheduled' || selectedHoliday ? 'Voluntary check-in' : 'Open check-in'}</Link> : <Link className="button button-quiet button-small" to="/">Open Today</Link>}
        </li>)}</ul>}
      </Surface>
    </div>}
  </section>
}

function MonthCalendar({ days, selected, today, onSelect }: { days: DaySummary[]; selected: string; today: string; onSelect: (date: CalendarDate) => void }) {
  const firstWeekday = mondayFirstWeekday(days[0]!.date)
  const cells: Array<DaySummary | null> = [...Array.from({ length: firstWeekday }, () => null), ...days]
  while (cells.length % 7) cells.push(null)
  const weeks = Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7))
  return <table className="activity-calendar" aria-label="Daily activity calendar"><thead><tr>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <th scope="col" key={day}>{day}</th>)}</tr></thead><tbody>{weeks.map((week, weekIndex) => <tr key={weekIndex}>{week.map((day, index) => day ? <td key={day.date} className={`calendar-day${day.date === selected ? ' calendar-day-selected' : ''}${day.date === today ? ' calendar-day-today' : ''}${day.holiday ? ' calendar-day-holiday' : ''}`}><button type="button" className={`calendar-cell-status ${day.visualStatus}`} aria-pressed={day.date === selected} aria-label={`${calendarDateLabel(day.date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${ACTIVITY_STATUS_PRESENTATION[day.visualStatus].label}${day.holiday ? '' : `; ${day.completed} completed, ${day.partial} partial, ${day.pending} pending, ${day.missed} missed`}${day.entries ? `, ${day.entries} saved check-ins` : ''}`} onClick={() => onSelect(day.date)}><span>{Number(day.date.slice(8, 10))}</span><i className="calendar-cell-mark" aria-hidden="true"><ActivityStatusIcon status={day.visualStatus} /></i></button></td> : <td aria-hidden="true" className="calendar-day calendar-day-empty" key={`empty-${weekIndex}-${index}`} />)}</tr>)}</tbody></table>
}

function formatEntry(tracker: StoredTrackerDefinition, entry: StoredTrackerEntry): string {
  if (entry.outcome === 'skipped') return 'Missed · marked intentionally'
  const values = tracker.metrics.flatMap((metric) => {
    const value = entry.values[metric.id]
    if (typeof value === 'number') return [`${metric.name}: ${formatTrackerNumber(value)}${metric.unit ? ` ${metric.unit}` : ''}`]
    if (typeof value === 'boolean') return value ? [metric.name] : []
    if (metric.valueType === 'checklist' && value && typeof value === 'object') return [`${metric.name}: ${Object.values(value).filter((item) => item === true).length} done`]
    return []
  })
  return values.join(' · ') || (evaluateTrackerEntry(tracker, entry).qualified ? 'Success rule met' : 'Progress recorded')
}
