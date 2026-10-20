import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { IconButton } from '../../components/ui/IconButton'
import { AppIcon } from '../../components/ui/AppIcon'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { ActivityStatusIcon } from '../../components/ui/ActivityStatusIcon'
import { useToast } from '../../components/ui/ToastProvider'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import type { AccountHoliday, CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry, isScheduledDate, isTrackerInActivePeriod } from '../../domain/trackers/planning'
import { getTrackerActivityStatus, ACTIVITY_STATUS_PRESENTATION, type ActivityStatus } from '../../domain/trackers/activityStatus'
import { selectMissingCheckIns } from '../../domain/trackers/missingCheckIns'
import { qualifiesForStreak } from '../../domain/trackers/progression'
import { isActiveTracker } from '../../domain/trackers/lifecycle'
import { activeTrackerMetrics, type TrackerValue } from '../../domain/trackers/types'
import { validateTrackerEntryValues } from '../../domain/trackers/schema'
import { trackerDefinitionForDate } from '../../domain/trackers/ruleVersions'
import { calculateCumulativeMetricPlan, trackerActiveStartDate } from '../../domain/trackers/planning'
import { createCumulativeAllocationPreview } from '../../domain/trackers/allocationPreview'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate, useWorkspaceCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { TrackerEntryFields } from '../shared/TrackerEntryFields'

let historicalProgressNoticeShown = false
import { ClearCheckInAction } from '../shared/ClearCheckInAction'
import { useAuth } from '../auth/AuthProvider'
import { getTodayMetricDetails, TodayRequirements } from './TodayRequirements'
import { mondayFirstWeekday } from '../../db/calendarDate'
import { getWeekRhythmState } from './weekRhythm'
import { scheduleCheckinFeedbackExpiry } from './checkinFeedbackTimer'
import { InfoButton } from '../../components/ui/InfoButton'
import { getChallengeDayDisplay } from '../../domain/trackers/challengeDay'

function emptyStateStorageMessage(authStatus: string, isOnline: boolean, syncStatus: string): string {
  if (authStatus !== 'signed-in') return authStatus === 'signed-out'
    ? 'Saved on this device. Sign in to set up account sync.'
    : 'Your progress is saved on this device.'
  if (syncStatus === 'error') return 'Some account changes still need to sync. Check sync status in Settings.'
  if (!isOnline || syncStatus === 'offline') return 'Changes are saved on this device while your account is offline.'
  if (syncStatus === 'waiting' || syncStatus === 'syncing') return 'Your account changes are waiting to sync.'
  if (syncStatus === 'complete') return 'Account sync is up to date.'
  return 'Progress is saved on this device. Check Settings for account sync status.'
}

function comparableValues(values: Record<string, TrackerValue>): string {
  const normalize = (value: TrackerValue): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key]!)]))
    return value
  }
  return JSON.stringify(normalize(values))
}

export function TodayPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { status: authStatus, user, isOnline, syncStatus } = useAuth()
  const { notify } = useToast()
  const expectedOwner = authStatus === 'signed-in' ? user?.id ?? null : null
  const ownerRef = useRef(expectedOwner)
  ownerRef.current = expectedOwner
  const { timeZone } = useWorkspaceTimeZone()
  const today = useWorkspaceCalendarDate(timeZone)
  const [allTrackers, setAllTrackers] = useState<StoredTrackerDefinition[]>([])
  const [hasDeletedTrackerRecords, setHasDeletedTrackerRecords] = useState(false)
  const [upcomingGoals, setUpcomingGoals] = useState<StoredTrackerDefinition[]>([])
  const [entries, setEntries] = useState<StoredTrackerEntry[]>([])
  const [weekEntries, setWeekEntries] = useState<StoredTrackerEntry[]>([])
  const [goalEntries, setGoalEntries] = useState<StoredTrackerEntry[]>([])
  const [todayHoliday, setTodayHoliday] = useState<AccountHoliday | undefined>()
  const [holidayDates, setHolidayDates] = useState<string[]>([])
  const [trackerHolidayRows, setTrackerHolidayRows] = useState<Awaited<ReturnType<typeof localRepository.listTrackerHolidays>>>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const refreshGeneration = useRef(0)
  const [selectedActivity, setSelectedActivity] = useState<{ trackerId: string; date: CalendarDate } | null>(null)
  const focusedDateRef = useRef<CalendarDate | null>(null)
  focusedDateRef.current = selectedActivity?.date ?? null
  const [showMissed, setShowMissed] = useState(false)
  const cardTriggers = useRef(new Map<string, HTMLButtonElement>())

  const refresh = useCallback(async (showLoading = false) => {
    const generation = ++refreshGeneration.current
    const requestOwner = expectedOwner
    if (showLoading) setLoading(true)
    setLoadError('')
    try {
      const requestedDate = focusedDateRef.current
      const queryStart = requestedDate && requestedDate < shiftCalendarDate(today, -7) ? requestedDate : shiftCalendarDate(today, -7)
      const queryEnd = requestedDate && requestedDate > shiftCalendarDate(today, 6) ? requestedDate : shiftCalendarDate(today, 6)
      const [allTrackers, deletedTrackers, recentEntries, allHolidays, trackerHolidays] = await Promise.all([
        localRepository.listTrackers(true),
        localRepository.listDeletedTrackers(),
        localRepository.listTrackerEntriesBetween(queryStart, queryEnd),
        localRepository.listAccountHolidays(),
        localRepository.listTrackerHolidays(queryStart as CalendarDate, queryEnd as CalendarDate),
      ])
      if (refreshGeneration.current !== generation || ownerRef.current !== requestOwner) return
      const todayEntries = recentEntries.filter((entry) => entry.date === today)
      const activeTrackers = allTrackers.filter(isActiveTracker)
      const goals = activeTrackers.filter((tracker) => tracker.kind === 'goal' && tracker.goalPlanning?.mode === 'cumulative-deadline' && tracker.deadline)
      const earliestGoalDate = goals.reduce<CalendarDate>((earliest, tracker) => {
        const start = trackerActiveStartDate(tracker, timeZone) as CalendarDate
        return start < earliest ? start : earliest
      }, today)
      const historicalGoalEntries = goals.length ? await localRepository.listTrackerEntriesBetween(earliestGoalDate, today) : []
      setAllTrackers(allTrackers)
      setHasDeletedTrackerRecords(deletedTrackers.length > 0)
      setUpcomingGoals(activeTrackers.filter((tracker) => tracker.kind === 'goal' && tracker.deadline && tracker.deadline >= today && tracker.deadline <= shiftCalendarDate(today, 14))
        .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? '')).slice(0, 3))
      setEntries(todayEntries)
      setWeekEntries(recentEntries)
      setGoalEntries(historicalGoalEntries)
      setHolidayDates(allHolidays.map((holiday) => holiday.date))
      setTrackerHolidayRows(trackerHolidays)
      setTodayHoliday(allHolidays.find((holiday) => holiday.date === today))
    } catch {
      if (refreshGeneration.current === generation && ownerRef.current === requestOwner) setLoadError('Today’s check-ins could not be loaded from this device.')
    } finally {
      if (refreshGeneration.current === generation && ownerRef.current === requestOwner) setLoading(false)
    }
  }, [expectedOwner, today])

  useEffect(() => { void refresh(true) }, [refresh])
  useEffect(() => {
    const requested = (location.state as { openActivity?: { trackerId?: unknown; date?: unknown } } | null)?.openActivity
    if (loading || !requested || typeof requested.trackerId !== 'string' || typeof requested.date !== 'string') return
    const date = requested.date
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN
    const validDate = Number.isFinite(parsedDate) && new Date(parsedDate).toISOString().slice(0, 10) === date && date <= today
    const tracker = allTrackers.find((item) => item.id === requested.trackerId && item.status === 'active' && item.deletedAt === null)
    if (!validDate || !tracker || !isTrackerInActivePeriod(tracker, date, timeZone)) {
      navigate(location.pathname, { replace: true, state: null })
      return
    }
    void (async () => {
      const [dateEntries, dateHolidays, dateTrackerHolidays] = await Promise.all([
        localRepository.listTrackerEntriesBetween(date as CalendarDate, date as CalendarDate),
        localRepository.listAccountHolidays(date as CalendarDate, date as CalendarDate),
        localRepository.listTrackerHolidays(date as CalendarDate, date as CalendarDate),
      ])
      setWeekEntries((current) => [...current.filter((entry) => !(entry.trackerId === tracker.id && entry.date === date)), ...dateEntries])
      setHolidayDates((current) => [...new Set([...current, ...dateHolidays.map((holiday) => holiday.date)])])
      setTrackerHolidayRows((current) => [...current.filter((holiday) => holiday.date !== date), ...dateTrackerHolidays])
      setSelectedActivity({ trackerId: tracker.id, date: date as CalendarDate })
      navigate(location.pathname, { replace: true, state: null })
    })()
  }, [location, navigate, loading, allTrackers, today])
  useWorkspaceDataChanges(expectedOwner, authStatus !== 'loading', refresh)
  const activeTrackers = useMemo(() => allTrackers.filter(isActiveTracker), [allTrackers])
  const trackers = useMemo(() => activeTrackers.filter((tracker) => {
    const inActivePeriod = isTrackerInActivePeriod(tracker, today, timeZone)
    return tracker.strictMode === true && inActivePeriod || !todayHoliday && isScheduledDate(tracker, today, timeZone)
  }), [activeTrackers, timeZone, today, todayHoliday])
  const activityTrackers = activeTrackers
  const accountCheckPending = authStatus === 'signed-in' && allTrackers.length === 0 && !hasDeletedTrackerRecords
    && isOnline !== false && ['idle', 'waiting', 'syncing'].includes(syncStatus)
  const accountCheckUnavailable = authStatus === 'signed-in' && allTrackers.length === 0 && !hasDeletedTrackerRecords
    && (isOnline === false || syncStatus === 'offline' || syncStatus === 'error')
  const holidaySet = useMemo(() => new Set(holidayDates), [holidayDates])
  const trackerHolidayDates = (trackerId: string) => new Set(trackerHolidayRows.filter((holiday) => holiday.trackerId === trackerId && holiday.deletedAt === null).map((holiday) => holiday.date))
  const entryByTracker = useMemo(() => new Map(entries.map((entry) => [entry.trackerId, entry])), [entries])
  const loggedCount = trackers.reduce((count, tracker) => count + (entryByTracker.has(tracker.id) ? 1 : 0), 0)
  const completedCount = trackers.filter((tracker) => {
    const entry = entryByTracker.get(tracker.id)
    return getTrackerActivityStatus({ tracker, entry, date: today, today, holidays: holidaySet, trackerHolidays: trackerHolidayDates(tracker.id), timeZone }) === 'completed'
  }).length
  const partialCount = trackers.filter((tracker) => getTrackerActivityStatus({ tracker, entry: entryByTracker.get(tracker.id), date: today, today, holidays: holidaySet, trackerHolidays: trackerHolidayDates(tracker.id), timeZone }) === 'partial').length
  const missedCount = trackers.filter((tracker) => getTrackerActivityStatus({ tracker, entry: entryByTracker.get(tracker.id), date: today, today, holidays: holidaySet, trackerHolidays: trackerHolidayDates(tracker.id), timeZone }) === 'missed').length
  const skippedCount = trackers.filter((tracker) => getTrackerActivityStatus({ tracker, entry: entryByTracker.get(tracker.id), date: today, today, holidays: holidaySet, trackerHolidays: trackerHolidayDates(tracker.id), timeZone }) === 'skipped').length
  const remainingCount = Math.max(0, trackers.length - completedCount - missedCount)
  const allComplete = trackers.length > 0 && completedCount === trackers.length
  const selectedTracker = activityTrackers.find((tracker) => tracker.id === selectedActivity?.trackerId)
  const selectedEntry = selectedActivity ? weekEntries.find((entry) => entry.trackerId === selectedActivity.trackerId && entry.date === selectedActivity.date) : undefined
  const recentMisses = useMemo(() => selectMissingCheckIns({
    trackers: activeTrackers,
    entries: weekEntries,
    holidays: holidaySet,
    dates: Array.from({ length: 7 }, (_, index) => shiftCalendarDate(today, index - 7)),
    today,
    timeZone,
  }), [today, activeTrackers, weekEntries, holidaySet, timeZone])
  const weekStart = shiftCalendarDate(today, -mondayFirstWeekday(today))
  const weekPattern = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = shiftCalendarDate(weekStart, index)
    const scheduled = activeTrackers.filter((tracker) => isScheduledDate(tracker, date, timeZone))
    const isToday = date === today
    const isHoliday = holidayDates.includes(date)
    const strictRequired = activeTrackers.filter((tracker) => tracker.strictMode === true && isTrackerInActivePeriod(tracker, date, timeZone))
    const opportunities = [...new Map([...scheduled.filter(() => !isHoliday), ...strictRequired].map((tracker) => [tracker.id, tracker])).values()]
    const entryFor = (tracker: StoredTrackerDefinition) => weekEntries.find((entry) => entry.trackerId === tracker.id && entry.date === date)
    const statuses = opportunities.map((tracker) => getTrackerActivityStatus({ tracker, entry: entryFor(tracker), date, today, holidays: new Set(holidayDates), trackerHolidays: trackerHolidayDates(tracker.id), timeZone }))
    const strictQualified = strictRequired.filter((tracker) => { const entry = entryFor(tracker); return Boolean(entry && qualifiesForStreak(tracker, entry)) }).length
    const done = opportunities.filter((tracker) => getTrackerActivityStatus({ tracker, entry: entryFor(tracker), date, today, holidays: new Set(holidayDates), trackerHolidays: trackerHolidayDates(tracker.id), timeZone }) === 'completed').length
    const partial = statuses.some((status) => status === 'partial')
    const noProgress = statuses.some((status) => status === 'no-progress')
    const hasSkipped = opportunities.some((tracker) => entryFor(tracker)?.outcome === 'skipped')
    const isRest = !isHoliday && opportunities.length === 0
    const state = isHoliday ? 'holiday' : isRest ? 'rest' : getWeekRhythmState({ isHoliday, scheduled: opportunities.length, done, hasPartial: partial, hasNoProgress: noProgress, hasSkipped, isToday, isFuture: date > today })
    const statusLabel = state === 'complete' ? 'Completed' : state === 'partial' ? 'Partial' : state === 'no-progress' ? 'No progress' : state === 'missed' ? 'Missed' : state === 'skipped' ? 'Skipped' : state === 'holiday' ? 'Holiday' : state === 'rest' ? 'Rest day' : state === 'upcoming' ? 'Upcoming' : 'Pending'
    return { date, scheduled: isHoliday ? 0 : scheduled.length, strictRequired: strictRequired.length, strictQualified, done, isToday, isHoliday, state, statusLabel }
  }), [today, weekStart, activeTrackers, weekEntries, holidayDates, timeZone])

  async function save(tracker: StoredTrackerDefinition, date: CalendarDate, values: Record<string, TrackerValue>, note: string, outcome: 'recorded' | 'skipped') {
    const wasSaved = weekEntries.some((item) => item.trackerId === tracker.id && item.date === date && item.deletedAt === null)
    try {
      await localRepository.saveTrackerEntry({ trackerId: tracker.id, date, outcome, values: outcome === 'skipped' ? {} : values, note })
      await refresh()
      return true
    } catch {
      notify({ kind: 'error', title: wasSaved ? 'Couldn’t update check-in' : 'Couldn’t save check-in', description: 'Your changes were not saved. Please try again.', duration: 0, dedupeKey: `checkin:${tracker.id}:${date}` })
      return false
    }
  }

  async function clear(tracker: StoredTrackerDefinition, date: CalendarDate): Promise<boolean> {
    try {
      await localRepository.deleteTrackerEntry(tracker.id, date)
      await refresh()
      notify({ kind: 'success', title: 'Check-in cleared', description: 'The saved entry was removed from this device.', dedupeKey: `checkin:${tracker.id}:${date}` })
      return true
    } catch {
      notify({ kind: 'error', title: 'Couldn’t clear check-in', description: 'Your saved entry is unchanged. Please try again.', duration: 0, dedupeKey: `checkin:${tracker.id}:${date}` })
      return false
    }
  }

  return (
    <section className="tracker-page today-page" aria-labelledby="today-title">
      <PageHeader headingId="today-title" eyebrow="YOUR DAILY RHYTHM" title="Today" description="Small steps count. Pick up where you are." help={{ title: 'Today', summary: 'Record today’s progress with the least friction.', description: 'Active trackers appear for scheduled opportunities and Strict Mode dates. Strict Mode also allows qualifying voluntary check-ins on holidays and rest days. Standard Mode holidays and rest days remain exempt; voluntary entries are saved without adding a scheduled streak opportunity. The workspace time zone determines today.' }} />
      {todayHoliday && <Surface className="today-holiday-banner"><span className="status-mark holiday"><ActivityStatusIcon status="holiday" /></span><div><strong>Today is a holiday</strong><p>{todayHoliday.reason ? `${todayHoliday.reason[0]!.toUpperCase()}${todayHoliday.reason.slice(1)} · ` : ''}Standard Mode schedule expectations pause. Strict Mode trackers still require qualifying progress. Recorded activity remains saved.</p></div><Link to={`/holidays?date=${today}`}>Manage holidays</Link></Surface>}
      {!loading && !loadError && activityTrackers.length > 0 && <details className="week-rhythm-disclosure"><summary>Your last 7 days</summary><section className="week-rhythm surface" aria-labelledby="week-rhythm-title">
        <header className="week-rhythm-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> YOUR PATTERN</span><h2 id="week-rhythm-title">A week of little wins</h2><InfoButton title="Weekly pattern" summary="The date tile keeps its Holiday or Rest day label even when Strict Mode requires a check-in." description="Standard Mode treats holidays and unscheduled rest days as neutral for streaks. Strict Mode requires qualifying progress on every calendar date, including those days. The accessible day label reports how many strict opportunities qualified. A voluntary check-in does not change the date’s primary status." /></div><span className="week-rhythm-count">{weekPattern.filter((day) => day.done > 0).length}<small> / 7 days</small></span></header>
        <div className="week-rhythm-days" role="list" aria-label="Check-in pattern for the last seven days">
          {weekPattern.map((day) => <div className={`week-rhythm-day ${day.state}${day.isToday ? ' today-date' : ''}`} key={day.date} role="listitem" aria-label={`${calendarDateLabel(day.date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${day.statusLabel}${day.scheduled > 0 ? `, ${day.done} of ${day.scheduled} met their configured success rule` : ''}${day.strictRequired > 0 ? `, ${day.strictQualified} of ${day.strictRequired} Strict Mode opportunities qualified` : ''}${day.isToday ? ', today' : ''}`}>
            <span className="week-rhythm-weekday">{calendarDateLabel(day.date, { weekday: 'short' })}</span>
            <span className="week-rhythm-mark" aria-hidden="true">{day.state === 'holiday' ? <ActivityStatusIcon status="holiday" /> : day.state === 'rest' ? <ActivityStatusIcon status="rest-day" /> : day.state === 'complete' ? <ActivityStatusIcon status="completed" /> : day.state === 'partial' ? <ActivityStatusIcon status="partial" /> : day.state === 'no-progress' ? <ActivityStatusIcon status="no-progress" /> : day.state === 'skipped' ? <ActivityStatusIcon status="skipped" /> : day.state === 'missed' ? <ActivityStatusIcon status="missed" /> : day.state === 'upcoming' ? <ActivityStatusIcon status="upcoming" /> : <ActivityStatusIcon status="pending" />}</span>
            <span className="week-rhythm-date">{Number(day.date.slice(-2))}</span>
          </div>)}
        </div>
        <p className="week-rhythm-caption">Rest days are part of your rhythm too.</p>
      </section></details>}
      {!loading && !loadError && trackers.length > 0 && <section className={`today-overview surface${allComplete ? ' all-handled' : ''}`} aria-label="Today at a glance">
        <div className="today-overview-copy"><span className="eyebrow"><span className="eyebrow-line" /> TODAY AT A GLANCE</span><h2>{remainingCount === 0 ? allComplete ? 'All done for today!' : 'No scheduled activity remains.' : `${remainingCount} ${remainingCount === 1 ? 'activity' : 'activities'} still actionable`}</h2><p>{completedCount} completed · {partialCount} partial · {loggedCount} of {trackers.length} checked in{missedCount ? ` · ${missedCount} missed` : ''}{skippedCount ? ` · ${skippedCount} skipped` : ''}.</p></div>
        <div className="today-progress" role="img" aria-label={`${completedCount} of ${trackers.length} scheduled activities met their success rule`}><span>{completedCount}<small> / {trackers.length}</small></span><div className="today-progress-track"><i style={{ width: `${trackers.length ? completedCount / trackers.length * 100 : 0}%` }} /></div><small>success rules met</small></div>
      </section>}
      {!loading && !loadError && upcomingGoals.length > 0 && <section className="today-upcoming-goals" aria-labelledby="today-upcoming-title">
        <header><div><span className="eyebrow"><span className="eyebrow-line" /> NEXT UP</span><h2 id="today-upcoming-title">Coming up soon</h2></div><Link to="/goals">All goals <span aria-hidden="true">→</span></Link></header>
        <div className="today-upcoming-list">{upcomingGoals.map((goal) => {
          const days = Math.round((Date.parse(`${goal.deadline}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000)
          const deadlineText = days === 0 ? 'Due today' : days === 1 ? '1 day left' : `${days} days left`
          const metric = goal.metrics.find((item) => goal.goalPlanning?.cumulativeTargets[item.id] !== undefined && item.valueType !== 'boolean')
          let recommendation: number | undefined
          let remaining: number | undefined
          let savedAllocation: number | undefined
          if (metric && goal.goalPlanning) {
            const entriesForGoal = goalEntries.filter((entry) => entry.trackerId === goal.id)
            const planningTimeZone = timeZone
            const startDate = trackerActiveStartDate(goal, planningTimeZone)
            const planningToday = localCalendarDate(new Date(), planningTimeZone)
            const total = goal.goalPlanning.cumulativeTargets[metric.id]!
            const holidaySet = new Set(holidayDates)
            if (goal.goalPlanning.progressSemantics[metric.id] === 'incremental') {
              const calculation = calculateCumulativeMetricPlan({ tracker: goal, entries: entriesForGoal, metricId: metric.id, totalTarget: total, startDate, asOfDate: planningToday, progressSemantics: 'incremental', holidays: holidaySet, timeZone: planningTimeZone, allocations: goal.goalPlanning.allocations?.[metric.id], manualAllocations: goal.goalPlanning.manualAllocations?.[metric.id] })
              remaining = calculation.remainingWork
              const preview = createCumulativeAllocationPreview({ tracker: goal, entries: entriesForGoal, metricId: metric.id, totalTarget: total, startDate, asOfDate: planningToday, holidays: holidaySet, timeZone: planningTimeZone })
              const todayPlanDay = preview.days.find((day) => day.date === planningToday)
              recommendation = todayPlanDay?.eligible ? todayPlanDay.amount ?? undefined : undefined
              savedAllocation = todayPlanDay?.eligible && todayPlanDay.manual ? todayPlanDay.amount ?? undefined : undefined
            }
          }
          const unit = metric?.unit ? ` ${metric.unit}` : metric?.valueType === 'checklist' ? ' items' : ''
          return <Link className="today-upcoming-goal" key={goal.id} to="/goals"><span className="tracker-kind-chip">Goal</span><strong>{goal.name}</strong>{recommendation !== undefined && <span>Planned today: {formatTrackerNumber(recommendation)}{unit} · {formatTrackerNumber(remaining ?? 0)}{unit} goal remaining</span>}{savedAllocation !== undefined && <small>Manually planned for today</small>}<span className={days <= 3 ? 'deadline-soon' : ''}>{deadlineText} · {calendarDateLabel(goal.deadline!)}</span></Link>
        })}</div>
      </section>}
      {loadError && <div role="alert" className="form-alert">{loadError}</div>}
      {loading ? <p role="status" className="tracker-loading">Loading today’s trackers…</p> : loadError ? <Surface><EmptyState title="Your check-ins are still here" description="This device could not open local storage. Try loading today’s trackers again." action={<Button variant="secondary" onClick={() => void refresh(true)}>Try again</Button>} /></Surface> : accountCheckPending ? (
        <Surface className="today-context-empty"><p role="status" className="tracker-loading">Checking your account for saved trackers…</p></Surface>
      ) : activityTrackers.length === 0 ? (
        <Surface className="today-context-empty">
          {accountCheckUnavailable ? <EmptyState
            title={isOnline === false || syncStatus === 'offline' ? 'Your account is offline' : 'Couldn’t check your account'}
            description="No trackers are saved on this device yet. Reconnect to check your account, or create a tracker now."
            action={<div className="today-empty-actions"><Link className="button button-secondary button-medium" to="/settings#sync-data">Account sync</Link><Link className="button button-primary button-medium" to="/trackers/new" state={{ returnTo: 'today' }}>Create a tracker</Link></div>}
          /> : allTrackers.length === 0 && !hasDeletedTrackerRecords ? <EmptyState
            title="Start tracking what matters."
            description="Build better habits, work toward your goals, and celebrate progress one day at a time."
            note="Start with one activity. You can customize everything later."
            action={<Link className="button button-primary button-medium" to="/trackers/new" state={{ returnTo: 'today' }}>Create your first tracker</Link>}
            secondary={<p className="today-empty-storage-note">{emptyStateStorageMessage(authStatus, isOnline, syncStatus)}</p>}
          /> : <EmptyState
            title="No active trackers"
            description="Your trackers are currently inactive. Restore an existing tracker or create a new one to get started."
            action={<div className="today-empty-actions"><Link className="button button-primary button-medium" to={allTrackers.length === 0 && hasDeletedTrackerRecords ? '/bin' : '/trackers'}>{allTrackers.length === 0 && hasDeletedTrackerRecords ? 'View Bin' : 'View trackers'}</Link><Link className="button button-secondary button-medium" to="/trackers/new" state={{ returnTo: 'today' }}>Create a tracker</Link></div>}
            secondary={<p className="today-empty-storage-note">{emptyStateStorageMessage(authStatus, isOnline, syncStatus)}</p>}
          />}
        </Surface>
      ) : (
        <>
          {!todayHoliday && trackers.length === 0 && <Surface className="today-context-empty">
            <EmptyState title="Nothing scheduled today" description="You’re all caught up for today. Check your trackers or plan what comes next." action={<Link className="button button-primary button-medium" to="/trackers">View trackers</Link>} />
          </Surface>}
          <div className="today-checkin-list">
          {activityTrackers.map((tracker) => {
            const entry = entryByTracker.get(tracker.id)
            const status = getTrackerActivityStatus({ tracker, entry, date: today, today, holidays: holidaySet, trackerHolidays: trackerHolidayDates(tracker.id), timeZone })
            const focusKey = `${tracker.id}:${today}`
            return <CheckinCard key={tracker.id} tracker={tracker} entry={entry} today={today} timeZone={timeZone} entries={goalEntries} holidays={holidaySet} status={status}
              historical={false} onOpen={() => setSelectedActivity({ trackerId: tracker.id, date: today })} onTrigger={(element) => { if (element) cardTriggers.current.set(focusKey, element); else cardTriggers.current.delete(focusKey) }} />
          })}
          </div>
        </>
      )}
      {recentMisses.length > 0 && <details className="today-missed-disclosure" onToggle={(event) => setShowMissed(event.currentTarget.open)}><summary>Missed opportunities in the last week <span>{recentMisses.length}</span></summary>{showMissed && <div className="today-checkin-list">{recentMisses.map(({ tracker, date }) => {
        const entry = weekEntries.find((item) => item.trackerId === tracker.id && item.date === date)
        const focusKey = `${tracker.id}:${date}`
        return <CheckinCard key={focusKey} tracker={tracker} entry={entry} today={date} timeZone={timeZone} entries={goalEntries} holidays={holidaySet} status="missed" historical
          onOpen={() => setSelectedActivity({ trackerId: tracker.id, date })} onTrigger={(element) => { if (element) cardTriggers.current.set(focusKey, element); else cardTriggers.current.delete(focusKey) }} />
      })}</div>}</details>}
      {selectedTracker && selectedActivity && <CheckinSheet key={`${selectedTracker.id}:${selectedActivity.date}`} tracker={selectedTracker} entry={selectedEntry} today={selectedActivity.date} currentDate={today} timeZone={timeZone} entries={goalEntries} holidays={holidaySet}
        authStatus={authStatus} isOnline={isOnline} syncStatus={syncStatus}
        status={getTrackerActivityStatus({ tracker: selectedTracker, entry: selectedEntry, date: selectedActivity.date, today, holidays: holidaySet, trackerHolidays: trackerHolidayDates(selectedTracker.id), timeZone })}
        canEdit={Boolean(selectedEntry) || selectedTracker.status === 'active' && selectedTracker.deletedAt === null && isTrackerInActivePeriod(selectedTracker, selectedActivity.date, timeZone)}
        historical={selectedActivity.date < today} onSave={save} onClear={clear} onClose={() => { const key = `${selectedTracker.id}:${selectedActivity.date}`; setSelectedActivity(null); window.setTimeout(() => cardTriggers.current.get(key)?.focus(), 0) }} />}
      {todayHoliday && entries.length > 0 && <section className="today-holiday-records" aria-label="Activity recorded on this holiday"><h2>Activity saved on this day</h2>{entries.map((entry) => <p key={entry.id}><strong>{allTrackers.find((tracker) => tracker.id === entry.trackerId)?.name ?? 'Tracker'}</strong> · {entry.outcome === 'skipped' ? 'Skipped · intentionally saved' : 'Progress recorded'}{entry.note ? ` · ${entry.note}` : ''}</p>)}<Link to={`/history?date=${today}`}>View full activity history</Link></section>}
    </section>
  )
}

type CheckinCardProps = {
  tracker: StoredTrackerDefinition; entry?: StoredTrackerEntry; today: CalendarDate; timeZone: string
  entries: readonly StoredTrackerEntry[]; holidays: ReadonlySet<string>; status: ActivityStatus
  historical?: boolean
  onOpen: () => void; onTrigger: (element: HTMLButtonElement | null) => void
}

function CheckinCard({ tracker, entry, today, timeZone, entries, holidays, status, historical = false, onOpen, onTrigger }: CheckinCardProps) {
  const details = getTodayMetricDetails(tracker, entry, today, entries, holidays, timeZone)
  const challengeDay = getChallengeDayDisplay(tracker, today, timeZone, holidays)
  const summaryMetrics = details.slice(0, 2)
  const primary = summaryMetrics[0]
  const progress = primary?.expected && primary.expected > 0 ? Math.min(100, Math.max(0, Number(primary.completed) / primary.expected * 100)) : 0
  const statusInfo = ACTIVITY_STATUS_PRESENTATION[status]
  return <article className={`today-checkin-card status-card status-${status}`}>
    <div className="today-card-main-row">
      <button className="today-activity-open" type="button" onClick={onOpen} ref={onTrigger} aria-label={`Open ${tracker.name}, ${statusInfo.label}${historical ? `, ${calendarDateLabel(today)}` : ''}`}>
        <span className="today-card-heading"><span className="tracker-kind-chip">{tracker.kind}{tracker.strictMode ? ' · Strict' : ''}</span><span className="today-card-title" role="heading" aria-level={2}>{tracker.name}</span><span className={`today-state ${status}`} role="status" aria-label={`Tracker: ${statusInfo.label}`}><ActivityStatusIcon status={status} /> Tracker · {statusInfo.label}</span></span>
        {tracker.description && <span className="today-card-description">{tracker.description}</span>}
        {challengeDay && <span className="challenge-day-label" aria-label={`Challenge ${challengeDay.label}`}>{challengeDay.label}</span>}
        <span className="today-compact-metrics">
          {summaryMetrics.map((metric) => <span className="today-compact-metric" key={metric.id}><span>{metric.name}</span>{metric.expectedLabel && <small className="today-compact-expectation">{historical ? metric.expectedLabel.replace('Today’s', `${calendarDateLabel(today)} ·`) : metric.expectedLabel === 'Today’s suggested allocation' ? 'Suggested today' : metric.expectedLabel === 'Today’s saved allocation' ? 'Saved allocation today' : metric.expectedLabel}</small>}<strong>{metric.isBoolean ? metric.booleanValue === 'true' ? 'Done' : metric.booleanValue === 'false' ? 'Not Done' : 'Unrecorded' : metric.expected !== undefined ? `${formatTrackerNumber(Number(metric.completed))} / ${formatTrackerNumber(metric.expected)}${metric.unit}` : metric.completed ? `${formatTrackerNumber(Number(metric.completed))}${metric.unit} recorded` : 'No progress recorded'}</strong>{metric.remaining !== undefined && <small>{formatTrackerNumber(metric.remaining)}{metric.unit} remaining</small>}</span>)}
          {details.length > 2 && <small className="today-compact-more">+{details.length - 2} more measures</small>}
          {!details.length && <span className="today-compact-metric"><strong>{entry ? 'Activity recorded' : 'Open for details'}</strong></span>}
        </span>
        {primary?.expected !== undefined && primary.expected > 0 && <span className="today-compact-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>}
        <span className="today-open-hint">{entry ? 'View or edit check-in' : historical ? `Open ${calendarDateLabel(today)} activity` : 'Open today’s activity'} <span aria-hidden="true">→</span></span>
      </button>
      <TodayRequirements compactIconOnly historical={historical} tracker={tracker} entry={entry} today={today} timeZone={timeZone} entries={entries} holidays={holidays} />
    </div>
  </article>
}

type CheckinSheetProps = Omit<CheckinCardProps, 'onOpen' | 'onTrigger'> & {
  currentDate: CalendarDate
  canEdit: boolean
  historical: boolean
  authStatus: string
  isOnline: boolean
  syncStatus: string
  onSave: (tracker: StoredTrackerDefinition, date: CalendarDate, values: Record<string, TrackerValue>, note: string, outcome: 'recorded' | 'skipped') => Promise<boolean>
  onClear: (tracker: StoredTrackerDefinition, date: CalendarDate) => Promise<boolean>
  onClose: () => void
}

type CheckinBaseline = { exists: boolean; outcome?: StoredTrackerEntry['outcome']; values: Record<string, TrackerValue>; note: string }
function checkinBaseline(entry?: StoredTrackerEntry): CheckinBaseline {
  return { exists: Boolean(entry), outcome: entry?.outcome, values: entry?.values ?? {}, note: entry?.note ?? '' }
}

function CheckinSheet({ tracker, entry, today, currentDate, timeZone, entries, holidays, status, canEdit, historical, authStatus, isOnline, syncStatus, onSave, onClear, onClose }: CheckinSheetProps) {
  const [showHistoricalNotice] = useState(() => historical && !historicalProgressNoticeShown)
  const [values, setValues] = useState<Record<string, TrackerValue>>(entry?.values ?? {})
  const [baseline, setBaseline] = useState(() => checkinBaseline(entry))
  const [invalidInputs, setInvalidInputs] = useState<Set<string>>(() => new Set())
  const [note, setNote] = useState(entry?.note ?? '')
  const [noteExpanded, setNoteExpanded] = useState(false)
  const [issue, setIssue] = useState('')
  const [saving, setSaving] = useState(false)
  const [skipConfirmationOpen, setSkipConfirmationOpen] = useState(false)
  const [skipConfirmationBusy, setSkipConfirmationBusy] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState<{ heading: string; supportingText: string; sequence: number } | null>(null)
  const entryRef = useRef(entry)
  const closeRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeRequestRef = useRef<() => void>(() => {})
  const dirty = comparableValues(values) !== comparableValues(baseline.values) || note !== baseline.note
  const saved = baseline.exists && baseline.outcome === 'recorded' && !dirty
  const locallySaved = baseline.exists && !dirty
  const syncFeedback = authStatus !== 'signed-in' ? ''
    : isOnline === false || syncStatus === 'offline' ? ' It will sync when your account is online.'
      : ['waiting', 'syncing'].includes(syncStatus) ? ' Account sync is pending.'
        : syncStatus === 'error' ? ' Account sync needs attention in Settings.'
          : syncStatus === 'complete' ? ' Account sync is up to date.'
            : ' Check account sync in Settings.'
  const result = entry?.outcome === 'recorded' ? evaluateTrackerEntry(tracker, entry) : undefined
  const activeMetrics = activeTrackerMetrics(tracker.metrics)
  const completionMetric = activeMetrics.length === 1 && activeMetrics[0]?.valueType === 'boolean' && tracker.customFields.every((field) => field.type === 'boolean') ? activeMetrics[0] : null
  const isBinaryCompletion = completionMetric !== null
  const completionStatus = completionMetric ? (() => {
    if (saveFeedback) return { heading: saveFeedback.heading, supportingText: saveFeedback.supportingText, feedback: true }
    if (!baseline.exists) return { heading: 'Did you complete this today?', supportingText: 'Choose an option to record your progress.' }
    if (baseline.outcome === 'skipped') return { heading: 'Day marked as skipped', supportingText: 'Your skip has been recorded.' }
    if (baseline.values[completionMetric.id] === true) return { heading: today === currentDate ? 'Done for today' : 'Done', supportingText: 'Your check-in is saved.' }
    return { heading: today === currentDate ? 'Not Done today' : 'Not Done', supportingText: 'Your check-in is saved.' }
  })() : null
  const effectiveTracker = trackerDefinitionForDate(tracker, today)
  const expectedDetails = useMemo(() => getTodayMetricDetails(effectiveTracker, entry, today, entries, holidays, timeZone), [effectiveTracker, entry, today, entries, holidays, timeZone])
  const expectedAmounts = Object.fromEntries(expectedDetails.flatMap((metric) => metric.expected === undefined ? [] : [[metric.id, metric.expected]]))
  const expectedLabels = Object.fromEntries(expectedDetails.flatMap((metric) => metric.expected === undefined ? [] : [[metric.id, metric.expectedLabel?.replace(/^Today’s /, '').replace(/ threshold$/, '').toLowerCase() ?? 'target']]))

  useLayoutEffect(() => {
    if (entryRef.current === entry) return
    entryRef.current = entry
    const latest = checkinBaseline(entry)
    setBaseline(latest)
    if (!dirty) { setValues(latest.values); setNote(latest.note) }
  }, [entry, dirty])
  useModalLayer(true, sheetRef, () => closeRequestRef.current())
  useVisualViewportBounds(true, backdropRef)
  useEffect(() => {
    closeRef.current?.focus()
  }, [])
  useEffect(() => () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current) }, [])
  function requestClose() {
    if (saving) return
    if (dirty && !window.confirm('Discard your unsaved check-in changes?')) return
    onClose()
  }
  closeRequestRef.current = requestClose
  const setValue = (key: string, value: TrackerValue | undefined) => setValues((current) => {
    const next = { ...current }; if (value === undefined) delete next[key]; else next[key] = value; return next
  })
  function setInputValidity(key: string, valid: boolean) {
    setInvalidInputs((current) => {
      const next = new Set(current)
      if (valid) next.delete(key); else next.add(key)
      return next
    })
  }
  async function submit(outcome: 'recorded' | 'skipped', payload = values): Promise<boolean> {
    if (saving) return false
    if (outcome === 'recorded' && invalidInputs.size > 0) { setIssue('Finish or correct the highlighted number fields before saving.'); return false }
    const validation = outcome === 'recorded' ? validateTrackerEntryValues(effectiveTracker, payload, { existingValues: baseline.values }) : undefined
    if (validation) { setIssue(validation.replace(/^[^ ]+ is required\.$/, 'Please complete all required fields.')); return false }
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    feedbackTimer.current = null
    setSaveFeedback(null)
    setIssue(''); setSaving(true)
    const didSave = await onSave(tracker, today, payload, note, outcome)
    if (!didSave) { setSaving(false); return false }
    const savedValues = outcome === 'skipped' ? {} : payload
    setValues(savedValues)
    if (outcome === 'skipped') setInvalidInputs(new Set())
    setBaseline({ exists: true, outcome, values: savedValues, note })
    setSaving(false)
    if (outcome === 'recorded' && completionMetric && typeof payload[completionMetric.id] === 'boolean') {
      const done = payload[completionMetric.id] === true
      const sequence = (saveFeedback?.sequence ?? 0) + 1
      setSaveFeedback(done
        ? { heading: 'Nicely done!', supportingText: 'Your check-in has been saved.', sequence }
        : { heading: 'Check-in saved', supportingText: 'Your progress has been recorded.', sequence })
      feedbackTimer.current = scheduleCheckinFeedbackExpiry(() => {
        setSaveFeedback((current) => current?.sequence === sequence ? null : current)
        feedbackTimer.current = null
      })
    }
    return true
  }
  async function confirmSkip() {
    if (skipConfirmationBusy || saving) return
    setSkipConfirmationBusy(true)
    const didSave = await submit('skipped')
    setSkipConfirmationBusy(false)
    if (didSave) setSkipConfirmationOpen(false)
  }
  async function clear(): Promise<boolean> { setSaving(true); const cleared = await onClear(tracker, today); setSaving(false); if (cleared) onClose(); return cleared }
  const challengeDay = getChallengeDayDisplay(tracker, today, timeZone, holidays)

  useEffect(() => {
    if (historical) historicalProgressNoticeShown = true
  }, [historical])

  return createPortal(<div ref={backdropRef} className="modal-backdrop today-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>
    <section className="today-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="today-detail-title" ref={sheetRef} tabIndex={-1}>
      <header className="today-detail-heading"><div><span className="tracker-kind-chip">{tracker.kind}</span><h2 id="today-detail-title">{tracker.name}</h2>{challengeDay && <p className="challenge-day-label">{challengeDay.label}</p>}<p>{calendarDateLabel(today)}{isBinaryCompletion ? '' : ` · ${ACTIVITY_STATUS_PRESENTATION[status].label}${holidays.has(today) && entry?.outcome === 'recorded' ? ' · Progress recorded' : status === 'rest-day' && entry?.outcome === 'recorded' ? ' · Progress recorded' : ''}`}</p>{challengeDay && <p>Starts {calendarDateLabel(trackerActiveStartDate(tracker, timeZone))} · Finish by {calendarDateLabel(tracker.deadline!)}{challengeDay.phase === 'active' ? ` · ${challengeDay.daysRemaining} days remaining` : ''}</p>}</div><IconButton ref={closeRef} className="today-detail-close" label="Close check-in details" onClick={requestClose}><AppIcon name="close" /></IconButton></header>
      <div className="today-detail-content">
        {showHistoricalNotice && historical && <p className="today-detail-notice" role="note">Past entries can update your XP, streaks, and achievements.</p>}
        {tracker.description && <details className="today-description-details"><summary>Activity description</summary><p>{tracker.description}</p></details>}
        {!isBinaryCompletion && <TodayRequirements historical={historical} tracker={tracker} entry={entry} today={today} timeZone={timeZone} entries={entries} holidays={holidays} />}
        {!canEdit ? <p className="today-detail-notice">This tracker is outside its active dates. Existing recorded activity remains available to view.</p> : <>
          {(holidays.has(today) || status === 'rest-day') && !tracker.strictMode && <p className="today-detail-notice">Voluntary check-in · this stays a holiday or rest day and does not change the schedule. Progress is saved and included in applicable metrics without adding a scheduled streak opportunity.</p>}
          {entry?.outcome === 'skipped' && !isBinaryCompletion && <p className="today-detail-notice">This check-in was intentionally skipped. Recording progress will replace the skipped outcome.</p>}
          <TrackerEntryFields tracker={effectiveTracker} values={values} setValue={setValue} date={today} today={today} holidays={holidays} timeZone={timeZone} expectedAmounts={expectedAmounts} expectedLabels={expectedLabels} onInputValidityChange={setInputValidity} showDraftPreview={dirty} completionStatus={completionStatus} />
          <details className="today-note-details" onToggle={(event) => setNoteExpanded(event.currentTarget.open)}><summary aria-expanded={noteExpanded}>{note ? 'Edit note' : 'Add a note'} <span>optional</span></summary><label className="form-field form-field-wide"><span>Note</span><textarea className="auth-input tracker-textarea" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note for this check-in" /></label></details>
          {issue && <p className="today-validation" role="alert">{issue}</p>}
          {!isBinaryCompletion && entry?.outcome === 'recorded' && result && <p className="today-result" role="status">{result.qualified ? 'Your configured success rule is met.' : 'The configured success rule is not met yet.'}</p>}
        </>}
      </div>
      {canEdit && <footer className="today-detail-actions">
        <div className="today-primary-actions">
          <button type="button" className="button button-secondary button-medium" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="button" data-ai-capability="checkins.record" className="button button-primary button-medium" disabled={saving || saved} onClick={() => void submit('recorded')}>{saving ? 'Saving…' : saved ? 'Saved' : entry?.outcome === 'recorded' ? 'Update check-in' : 'Save check-in'}</button>
          {locallySaved && <p className="today-saved-indicator" role="status">Saved on this device.{syncFeedback}</p>}
        </div>
        <div className="today-secondary-actions">
          <button type="button" className="today-secondary-action today-secondary-skip" disabled={saving} onClick={() => setSkipConfirmationOpen(true)}><AppIcon name="calendar-skip" /><span>Skip day</span></button>
          <ClearCheckInAction onClear={clear} saving={saving} holiday={holidays.has(today)} compact available={Boolean(entry)} />
        </div>
      </footer>}
      {skipConfirmationOpen && <ConfirmActionDialog title="Skip this day?" description={status === 'rest-day' || status === 'holiday' ? 'This records an intentional skip. This date is not a required streak opportunity, so it will not break your streak.' : 'This records an intentional skip. On a required opportunity, it will not qualify toward your streak.'} details="A skipped entry is saved separately from an unchecked date and contains no measure values. Scheduled opportunities and Strict Mode settings determine whether the date affects your streak." actionLabel="Confirm skip" actionDisabled={skipConfirmationBusy || saving} cancelDisabled={skipConfirmationBusy || saving} layer="checkin" onCancel={() => { if (!skipConfirmationBusy && !saving) setSkipConfirmationOpen(false) }} onConfirm={() => void confirmSkip()} />}
    </section>
  </div>, document.body)
}
