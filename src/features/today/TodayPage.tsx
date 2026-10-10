import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { IconButton } from '../../components/ui/IconButton'
import { AppIcon } from '../../components/ui/AppIcon'
import { ActivityStatusIcon } from '../../components/ui/ActivityStatusIcon'
import { useToast } from '../../components/ui/ToastProvider'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import type { AccountHoliday, CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry, isScheduledDate } from '../../domain/trackers/planning'
import { getTrackerActivityStatus, ACTIVITY_STATUS_PRESENTATION, type ActivityStatus } from '../../domain/trackers/activityStatus'
import type { TrackerValue } from '../../domain/trackers/types'
import { validateTrackerEntryValues } from '../../domain/trackers/schema'
import { calculateCumulativeMetricPlan } from '../../domain/trackers/planning'
import { createCumulativeAllocationPreview } from '../../domain/trackers/allocationPreview'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { TrackerEntryFields } from '../shared/TrackerEntryFields'
import { useAuth } from '../auth/AuthProvider'
import { getTodayMetricDetails, TodayRequirements } from './TodayRequirements'
import { mondayFirstWeekday } from '../../db/calendarDate'
import { getWeekRhythmState } from './weekRhythm'

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

export function TodayPage() {
  const { status: authStatus, user, isOnline, syncStatus } = useAuth()
  const { notify } = useToast()
  const expectedOwner = authStatus === 'signed-in' ? user?.id ?? null : null
  const ownerRef = useRef(expectedOwner)
  ownerRef.current = expectedOwner
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [allTrackers, setAllTrackers] = useState<StoredTrackerDefinition[]>([])
  const [hasDeletedTrackerRecords, setHasDeletedTrackerRecords] = useState(false)
  const [upcomingGoals, setUpcomingGoals] = useState<StoredTrackerDefinition[]>([])
  const [entries, setEntries] = useState<StoredTrackerEntry[]>([])
  const [weekEntries, setWeekEntries] = useState<StoredTrackerEntry[]>([])
  const [goalEntries, setGoalEntries] = useState<StoredTrackerEntry[]>([])
  const [todayHoliday, setTodayHoliday] = useState<AccountHoliday | undefined>()
  const [holidayDates, setHolidayDates] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const refreshGeneration = useRef(0)
  const [selectedActivity, setSelectedActivity] = useState<{ trackerId: string; date: CalendarDate } | null>(null)
  const [showMissed, setShowMissed] = useState(false)
  const cardTriggers = useRef(new Map<string, HTMLButtonElement>())

  const refresh = useCallback(async (showLoading = false) => {
    const generation = ++refreshGeneration.current
    const requestOwner = expectedOwner
    if (showLoading) setLoading(true)
    setLoadError('')
    try {
      const [allTrackers, deletedTrackers, recentEntries, holidays] = await Promise.all([
        localRepository.listTrackers(true),
        localRepository.listDeletedTrackers(),
        localRepository.listTrackerEntriesBetween(shiftCalendarDate(today, -6), shiftCalendarDate(today, 6)),
        localRepository.listAccountHolidays(shiftCalendarDate(today, -6), shiftCalendarDate(today, 6)),
      ])
      if (refreshGeneration.current !== generation || ownerRef.current !== requestOwner) return
      const todayEntries = recentEntries.filter((entry) => entry.date === today)
      const goals = allTrackers.filter((tracker) => tracker.status === 'active' && tracker.kind === 'goal' && tracker.goalPlanning?.mode === 'cumulative-deadline' && tracker.deadline)
      const latestGoalDeadline = goals.reduce<CalendarDate>((latest, tracker) => {
        const deadline = tracker.deadline as CalendarDate
        return !latest || deadline > latest ? deadline : latest
      }, today)
      const planningHolidays = goals.length
        ? await localRepository.listAccountHolidays(shiftCalendarDate(today, -6), latestGoalDeadline)
        : holidays
      const earliestGoalDate = goals.reduce<CalendarDate>((earliest, tracker) => {
        const start = (tracker.startDate ?? tracker.createdAt.slice(0, 10)) as CalendarDate
        return start < earliest ? start : earliest
      }, today)
      const historicalGoalEntries = goals.length ? await localRepository.listTrackerEntriesBetween(earliestGoalDate, today) : []
      setAllTrackers(allTrackers)
      setHasDeletedTrackerRecords(deletedTrackers.length > 0)
      setUpcomingGoals(allTrackers.filter((tracker) => tracker.kind === 'goal' && tracker.status === 'active' && tracker.deadline && tracker.deadline >= today && tracker.deadline <= shiftCalendarDate(today, 14))
        .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? '')).slice(0, 3))
      setEntries(todayEntries)
      setWeekEntries(recentEntries)
      setGoalEntries(historicalGoalEntries)
      setHolidayDates(planningHolidays.map((holiday) => holiday.date))
      setTodayHoliday(planningHolidays.find((holiday) => holiday.date === today))
    } catch {
      if (refreshGeneration.current === generation && ownerRef.current === requestOwner) setLoadError('Today’s check-ins could not be loaded from this device.')
    } finally {
      if (refreshGeneration.current === generation && ownerRef.current === requestOwner) setLoading(false)
    }
  }, [expectedOwner, today])

  useEffect(() => { void refresh(true) }, [refresh])
  useWorkspaceDataChanges(expectedOwner, authStatus !== 'loading', refresh)
  const trackers = useMemo(() => todayHoliday ? [] : allTrackers.filter((tracker) => isScheduledDate(tracker, today)), [allTrackers, today, todayHoliday])
  const activityTrackers = useMemo(() => allTrackers.filter((tracker) => tracker.status === 'active' && tracker.deletedAt === null), [allTrackers])
  const accountCheckPending = authStatus === 'signed-in' && allTrackers.length === 0 && !hasDeletedTrackerRecords
    && isOnline !== false && ['idle', 'waiting', 'syncing'].includes(syncStatus)
  const accountCheckUnavailable = authStatus === 'signed-in' && allTrackers.length === 0 && !hasDeletedTrackerRecords
    && (isOnline === false || syncStatus === 'offline' || syncStatus === 'error')
  const holidaySet = useMemo(() => new Set(holidayDates), [holidayDates])
  const entryByTracker = useMemo(() => new Map(entries.map((entry) => [entry.trackerId, entry])), [entries])
  const loggedCount = trackers.reduce((count, tracker) => count + (entryByTracker.has(tracker.id) ? 1 : 0), 0)
  const completedCount = trackers.filter((tracker) => getTrackerActivityStatus({ tracker, entry: entryByTracker.get(tracker.id), date: today, today, holidays: holidaySet }) === 'completed').length
  const partialCount = trackers.filter((tracker) => getTrackerActivityStatus({ tracker, entry: entryByTracker.get(tracker.id), date: today, today, holidays: holidaySet }) === 'partial').length
  const missedCount = trackers.filter((tracker) => getTrackerActivityStatus({ tracker, entry: entryByTracker.get(tracker.id), date: today, today, holidays: holidaySet }) === 'missed').length
  const remainingCount = Math.max(0, trackers.length - completedCount - missedCount)
  const allComplete = trackers.length > 0 && completedCount === trackers.length
  const selectedTracker = activityTrackers.find((tracker) => tracker.id === selectedActivity?.trackerId)
  const selectedEntry = selectedActivity ? weekEntries.find((entry) => entry.trackerId === selectedActivity.trackerId && entry.date === selectedActivity.date) : undefined
  const recentMisses = useMemo(() => Array.from({ length: 6 }, (_, index) => shiftCalendarDate(today, index - 6))
    .filter((date) => !holidaySet.has(date))
    .flatMap((date) => allTrackers.filter((tracker) => tracker.status === 'active' && tracker.deletedAt === null && isScheduledDate(tracker, date))
      .filter((tracker) => getTrackerActivityStatus({ tracker, entry: weekEntries.find((entry) => entry.trackerId === tracker.id && entry.date === date), date, today, holidays: holidaySet }) === 'missed')
      .map((tracker) => ({ tracker, date }))), [today, allTrackers, weekEntries, holidaySet])
  const weekStart = shiftCalendarDate(today, -mondayFirstWeekday(today))
  const weekPattern = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = shiftCalendarDate(weekStart, index)
    const scheduled = allTrackers.filter((tracker) => isScheduledDate(tracker, date))
    const isToday = date === today
    const isHoliday = holidayDates.includes(date)
    const statuses = scheduled.map((tracker) => getTrackerActivityStatus({ tracker, entry: weekEntries.find((entry) => entry.trackerId === tracker.id && entry.date === date), date, today, holidays: new Set(holidayDates) }))
    const done = isHoliday ? 0 : statuses.filter((status) => status === 'completed').length
    const partial = statuses.some((status) => status === 'partial')
    const hasSkipped = scheduled.some((tracker) => weekEntries.some((entry) => entry.trackerId === tracker.id && entry.date === date && entry.outcome === 'skipped'))
    const state = getWeekRhythmState({ isHoliday, scheduled: scheduled.length, done, hasPartial: partial, hasSkipped, isToday, isFuture: date > today })
    const statusLabel = state === 'complete' ? 'completed' : state === 'partial' ? 'partially completed' : state === 'missed' ? 'missed' : state === 'holiday' ? 'holiday' : state === 'rest' ? 'rest day' : 'pending'
    return { date, scheduled: isHoliday ? 0 : scheduled.length, done, isToday, isHoliday, state, statusLabel }
  }), [today, weekStart, allTrackers, weekEntries, holidayDates])

  async function save(tracker: StoredTrackerDefinition, date: CalendarDate, values: Record<string, TrackerValue>, note: string, outcome: 'recorded' | 'skipped') {
    const wasSaved = weekEntries.some((item) => item.trackerId === tracker.id && item.date === date && item.deletedAt === null)
    try {
      await localRepository.saveTrackerEntry({ trackerId: tracker.id, date, outcome, values: outcome === 'skipped' ? {} : values, note })
      await refresh()
      notify({
        kind: authStatus === 'signed-in' && isOnline === false ? 'warning' : 'success',
        title: authStatus === 'signed-in' && isOnline === false ? 'Saved on this device' : outcome === 'skipped' ? 'Marked as missed' : wasSaved ? 'Check-in updated' : 'Check-in saved',
        description: authStatus === 'signed-in' && isOnline === false
          ? 'Saved on this device. It will sync when your account is online.'
          : 'Your progress has been saved on this device.',
        dedupeKey: `checkin:${tracker.id}:${date}`,
      })
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
      <PageHeader headingId="today-title" eyebrow="YOUR DAILY RHYTHM" title="Today" description="Small steps count. Pick up where you are." help={{ title: 'Today', summary: 'Record today’s progress with the least friction.', description: 'Each active tracker appears when today is a scheduled opportunity. Enter its metric values, optional details, and notes, then save the check-in. Marking an activity missed records an intentional missed commitment and breaks its streak. Your week pattern marks scheduled completion and rest days; the workspace time zone determines today.' }} />
      {todayHoliday && <Surface className="today-holiday-banner"><span className="status-mark holiday"><ActivityStatusIcon status="holiday" /></span><div><strong>Today is a holiday</strong><p>{todayHoliday.reason ? `${todayHoliday.reason[0]!.toUpperCase()}${todayHoliday.reason.slice(1)} · ` : ''}Your scheduled goals and streaks are paused today. Recorded activity remains saved.</p></div><Link to={`/holidays?date=${today}`}>Manage holidays</Link></Surface>}
      {!loading && !loadError && activityTrackers.length > 0 && <details className="week-rhythm-disclosure"><summary>Your last 7 days</summary><section className="week-rhythm surface" aria-labelledby="week-rhythm-title">
        <header className="week-rhythm-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> YOUR PATTERN</span><h2 id="week-rhythm-title">A week of little wins</h2></div><span className="week-rhythm-count">{weekPattern.filter((day) => day.done > 0).length}<small> / 7 days</small></span></header>
        <div className="week-rhythm-days" role="list" aria-label="Check-in pattern for the last seven days">
          {weekPattern.map((day) => <div className={`week-rhythm-day ${day.state}${day.isToday ? ' today-date' : ''}`} key={day.date} role="listitem" aria-label={`${calendarDateLabel(day.date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${day.statusLabel}${day.scheduled > 0 ? `, ${day.done} of ${day.scheduled} completed` : ''}${day.isToday ? ', today' : ''}`}>
            <span className="week-rhythm-weekday">{calendarDateLabel(day.date, { weekday: 'short' })}</span>
            <span className="week-rhythm-mark" aria-hidden="true">{day.state === 'holiday' ? <ActivityStatusIcon status="holiday" /> : day.state === 'rest' ? <ActivityStatusIcon status="unscheduled" /> : day.state === 'complete' ? <ActivityStatusIcon status="completed" /> : day.state === 'partial' ? <ActivityStatusIcon status="partial" /> : day.state === 'missed' ? <ActivityStatusIcon status="missed" /> : <ActivityStatusIcon status="pending" />}</span>
            <span className="week-rhythm-date">{Number(day.date.slice(-2))}</span>
          </div>)}
        </div>
        <p className="week-rhythm-caption">Rest days are part of your rhythm too.</p>
      </section></details>}
      {!loading && !loadError && trackers.length > 0 && <section className={`today-overview surface${allComplete ? ' all-handled' : ''}`} aria-label="Today at a glance">
        <div className="today-overview-copy"><span className="eyebrow"><span className="eyebrow-line" /> TODAY AT A GLANCE</span><h2>{remainingCount === 0 ? allComplete ? 'All done for today!' : 'No scheduled activity remains.' : `${remainingCount} ${remainingCount === 1 ? 'activity' : 'activities'} still actionable`}</h2><p>{completedCount} completed · {partialCount} partially complete · {loggedCount} of {trackers.length} checked in{missedCount ? ` · ${missedCount} marked missed` : ''}.</p></div>
        <div className="today-progress" role="img" aria-label={`${completedCount} of ${trackers.length} scheduled activities completed`}><span>{completedCount}<small> / {trackers.length}</small></span><div className="today-progress-track"><i style={{ width: `${trackers.length ? completedCount / trackers.length * 100 : 0}%` }} /></div><small>completed today</small></div>
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
            const startDate = goal.startDate ?? goal.createdAt.slice(0, 10)
            const total = goal.goalPlanning.cumulativeTargets[metric.id]!
            const holidaySet = new Set(holidayDates)
            if (goal.goalPlanning.progressSemantics[metric.id] === 'incremental') {
              const calculation = calculateCumulativeMetricPlan({ tracker: goal, entries: entriesForGoal, metricId: metric.id, totalTarget: total, startDate, asOfDate: today, progressSemantics: 'incremental', holidays: holidaySet })
              remaining = calculation.remainingWork
              savedAllocation = goal.goalPlanning.allocations?.[metric.id]?.[today]
              recommendation = createCumulativeAllocationPreview({ tracker: goal, entries: entriesForGoal, metricId: metric.id, totalTarget: total, startDate, asOfDate: today, holidays: holidaySet }).days.find((day) => day.date === today)?.amount ?? undefined
            }
          }
          const unit = metric?.unit ? ` ${metric.unit}` : metric?.valueType === 'checklist' ? ' items' : ''
          return <Link className="today-upcoming-goal" key={goal.id} to="/goals"><span className="tracker-kind-chip">Goal</span><strong>{goal.name}</strong>{recommendation !== undefined && <span>Updated pace today: {formatTrackerNumber(recommendation)}{unit} · {formatTrackerNumber(remaining ?? 0)}{unit} remaining</span>}{savedAllocation !== undefined && savedAllocation !== recommendation && <small>Saved plan: {formatTrackerNumber(savedAllocation)}{unit} · planner can rebalance it</small>}<span className={days <= 3 ? 'deadline-soon' : ''}>{deadlineText} · {calendarDateLabel(goal.deadline!)}</span></Link>
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
            const status = getTrackerActivityStatus({ tracker, entry, date: today, today, holidays: holidaySet })
            const focusKey = `${tracker.id}:${today}`
            return <CheckinCard key={tracker.id} tracker={tracker} entry={entry} today={today} entries={goalEntries} holidays={holidaySet} status={status}
              historical={false} onOpen={() => setSelectedActivity({ trackerId: tracker.id, date: today })} onTrigger={(element) => { if (element) cardTriggers.current.set(focusKey, element); else cardTriggers.current.delete(focusKey) }} />
          })}
          </div>
        </>
      )}
      {recentMisses.length > 0 && <details className="today-missed-disclosure" onToggle={(event) => setShowMissed(event.currentTarget.open)}><summary>Missed opportunities in the last week <span>{recentMisses.length}</span></summary>{showMissed && <div className="today-checkin-list">{recentMisses.map(({ tracker, date }) => {
        const entry = weekEntries.find((item) => item.trackerId === tracker.id && item.date === date)
        const focusKey = `${tracker.id}:${date}`
        return <CheckinCard key={focusKey} tracker={tracker} entry={entry} today={date} entries={goalEntries} holidays={holidaySet} status="missed" historical
          onOpen={() => setSelectedActivity({ trackerId: tracker.id, date })} onTrigger={(element) => { if (element) cardTriggers.current.set(focusKey, element); else cardTriggers.current.delete(focusKey) }} />
      })}</div>}</details>}
      {selectedTracker && selectedActivity && <CheckinSheet key={`${selectedTracker.id}:${selectedActivity.date}`} tracker={selectedTracker} entry={selectedEntry} today={selectedActivity.date} entries={goalEntries} holidays={holidaySet}
        status={getTrackerActivityStatus({ tracker: selectedTracker, entry: selectedEntry, date: selectedActivity.date, today, holidays: holidaySet })}
        canEdit={isScheduledDate(selectedTracker, selectedActivity.date) && !holidaySet.has(selectedActivity.date) || Boolean(selectedEntry)}
        historical={selectedActivity.date < today} onSave={save} onClear={clear} onClose={() => { const key = `${selectedTracker.id}:${selectedActivity.date}`; setSelectedActivity(null); window.setTimeout(() => cardTriggers.current.get(key)?.focus(), 0) }} />}
      {todayHoliday && entries.length > 0 && <section className="today-holiday-records" aria-label="Activity recorded on this holiday"><h2>Activity saved on this day</h2>{entries.map((entry) => <p key={entry.id}><strong>{allTrackers.find((tracker) => tracker.id === entry.trackerId)?.name ?? 'Tracker'}</strong> · {entry.outcome === 'skipped' ? 'Missed · marked intentionally' : 'Progress recorded'}{entry.note ? ` · ${entry.note}` : ''}</p>)}<Link to={`/history?date=${today}`}>View full activity history</Link></section>}
    </section>
  )
}

type CheckinCardProps = {
  tracker: StoredTrackerDefinition; entry?: StoredTrackerEntry; today: CalendarDate
  entries: readonly StoredTrackerEntry[]; holidays: ReadonlySet<string>; status: ActivityStatus
  historical?: boolean
  onOpen: () => void; onTrigger: (element: HTMLButtonElement | null) => void
}

function CheckinCard({ tracker, entry, today, entries, holidays, status, historical = false, onOpen, onTrigger }: CheckinCardProps) {
  const details = getTodayMetricDetails(tracker, entry, today, entries, holidays)
  const summaryMetrics = details.slice(0, 2)
  const primary = summaryMetrics[0]
  const progress = primary?.expected && primary.expected > 0 ? Math.min(100, Math.max(0, Number(primary.completed) / primary.expected * 100)) : 0
  const statusInfo = ACTIVITY_STATUS_PRESENTATION[status]
  return <article className={`today-checkin-card status-card status-${status}`}>
    <div className="today-card-main-row">
      <button className="today-activity-open" type="button" onClick={onOpen} ref={onTrigger} aria-label={`Open ${tracker.name}, ${statusInfo.label}${historical ? `, ${calendarDateLabel(today)}` : ''}`}>
        <span className="today-card-heading"><span className="tracker-kind-chip">{tracker.kind}</span><span className="today-card-title" role="heading" aria-level={2}>{tracker.name}</span><span className={`today-state ${status}`} role="status" aria-label={statusInfo.label}><ActivityStatusIcon status={status} /> {statusInfo.label}</span></span>
        {tracker.description && <span className="today-card-description">{tracker.description}</span>}
        <span className="today-compact-metrics">
          {summaryMetrics.map((metric) => <span className="today-compact-metric" key={metric.id}><span>{metric.name}</span>{metric.expectedLabel && <small className="today-compact-expectation">{historical ? metric.expectedLabel.replace('Today’s', `${calendarDateLabel(today)} ·`) : metric.expectedLabel === 'Today’s suggested allocation' ? 'Suggested today' : metric.expectedLabel === 'Today’s saved allocation' ? 'Saved allocation today' : metric.expectedLabel}</small>}<strong>{metric.isBoolean ? (metric.completed ? 'Complete' : 'Not complete') : metric.expected !== undefined ? `${formatTrackerNumber(Number(metric.completed))} / ${formatTrackerNumber(metric.expected)}${metric.unit}` : metric.completed ? `${formatTrackerNumber(Number(metric.completed))}${metric.unit} recorded` : 'No progress recorded'}</strong>{metric.remaining !== undefined && <small>{formatTrackerNumber(metric.remaining)}{metric.unit} remaining</small>}</span>)}
          {details.length > 2 && <small className="today-compact-more">+{details.length - 2} more measures</small>}
          {!details.length && <span className="today-compact-metric"><strong>{entry ? 'Activity recorded' : 'Open for details'}</strong></span>}
        </span>
        {primary?.expected !== undefined && primary.expected > 0 && <span className="today-compact-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>}
        <span className="today-open-hint">{entry ? 'View or edit check-in' : historical ? `Open ${calendarDateLabel(today)} activity` : 'Open today’s activity'} <span aria-hidden="true">→</span></span>
      </button>
      <TodayRequirements compactIconOnly historical={historical} tracker={tracker} entry={entry} today={today} entries={entries} holidays={holidays} />
    </div>
  </article>
}

type CheckinSheetProps = Omit<CheckinCardProps, 'onOpen' | 'onTrigger'> & {
  canEdit: boolean
  historical: boolean
  onSave: (tracker: StoredTrackerDefinition, date: CalendarDate, values: Record<string, TrackerValue>, note: string, outcome: 'recorded' | 'skipped') => Promise<boolean>
  onClear: (tracker: StoredTrackerDefinition, date: CalendarDate) => Promise<boolean>
  onClose: () => void
}

function CheckinSheet({ tracker, entry, today, entries, holidays, status, canEdit, historical, onSave, onClear, onClose }: CheckinSheetProps) {
  const [values, setValues] = useState<Record<string, TrackerValue>>(entry?.values ?? {})
  const [invalidInputs, setInvalidInputs] = useState<Set<string>>(() => new Set())
  const [note, setNote] = useState(entry?.note ?? '')
  const [noteExpanded, setNoteExpanded] = useState(false)
  const [issue, setIssue] = useState('')
  const [saving, setSaving] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const closeRequestRef = useRef<() => void>(() => {})
  const originalValues = entry?.values ?? {}
  const dirty = JSON.stringify(values) !== JSON.stringify(originalValues) || note !== (entry?.note ?? '')
  const result = entry?.outcome === 'recorded' ? evaluateTrackerEntry(tracker, entry) : undefined
  const expectedDetails = useMemo(() => getTodayMetricDetails(tracker, entry, today, entries, holidays), [tracker, entry, today, entries, holidays])
  const expectedAmounts = Object.fromEntries(expectedDetails.flatMap((metric) => metric.expected === undefined ? [] : [[metric.id, metric.expected]]))
  const expectedLabels = Object.fromEntries(expectedDetails.flatMap((metric) => metric.expected === undefined ? [] : [[metric.id, metric.expectedLabel?.replace(/^Today’s /, '').replace(/ threshold$/, '').toLowerCase() ?? 'target']]))

  useLayoutEffect(() => { if (!dirty) { setValues(entry?.values ?? {}); setNote(entry?.note ?? '') } }, [entry, dirty])
  useModalLayer(true, sheetRef, () => closeRequestRef.current())
  useVisualViewportBounds(true, backdropRef)
  useEffect(() => {
    closeRef.current?.focus()
  }, [])
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
  async function submit(outcome: 'recorded' | 'skipped', payload = values) {
    if (outcome === 'recorded' && invalidInputs.size > 0) { setIssue('Finish or correct the highlighted number fields before saving.'); return }
    const validation = outcome === 'recorded' ? validateTrackerEntryValues(tracker, payload, { existingValues: entry?.values }) : undefined
    if (validation) { setIssue(validation.replace(/^[^ ]+ is required\.$/, 'Please complete all required fields.')); return }
    setIssue(''); setSaving(true)
    const saved = await onSave(tracker, today, payload, note, outcome)
    if (!saved) return
    setSaving(false)
  }
  async function clear() { setSaving(true); const cleared = await onClear(tracker, today); setSaving(false); if (cleared) onClose() }

  return createPortal(<div ref={backdropRef} className="today-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>
    <section className="today-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="today-detail-title" ref={sheetRef} tabIndex={-1}>
      <header className="today-detail-heading"><div><span className="tracker-kind-chip">{tracker.kind}</span><h2 id="today-detail-title">{tracker.name}</h2><p>{calendarDateLabel(today)} · {ACTIVITY_STATUS_PRESENTATION[status].label}</p></div><IconButton ref={closeRef} className="today-detail-close" label="Close check-in details" onClick={requestClose}><AppIcon name="close" /></IconButton></header>
      <div className="today-detail-content">
        {tracker.description && <details className="today-description-details"><summary>Activity description</summary><p>{tracker.description}</p></details>}
        <TodayRequirements historical={historical} tracker={tracker} entry={entry} today={today} entries={entries} holidays={holidays} />
        {!canEdit ? <p className="today-detail-notice">{holidays.has(today) ? 'Today is a holiday, so this activity cannot be checked in.' : 'Today is not a scheduled day for this activity.'} Existing recorded activity remains available to view.</p> : <>
          {entry?.outcome === 'skipped' && <p className="today-detail-notice">This activity was marked missed intentionally. Recording progress will replace the missed status.</p>}
          <TrackerEntryFields tracker={tracker} values={values} setValue={setValue} date={today} today={today} holidays={holidays} expectedAmounts={expectedAmounts} expectedLabels={expectedLabels} onInputValidityChange={setInputValidity} />
          <details className="today-note-details" onToggle={(event) => setNoteExpanded(event.currentTarget.open)}><summary aria-expanded={noteExpanded}>{note ? 'Edit note' : 'Add a note'} <span>optional</span></summary><label className="form-field form-field-wide"><span>Note</span><textarea className="auth-input tracker-textarea" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note for this check-in" /></label></details>
          {issue && <p className="today-validation" role="alert">{issue}</p>}
          {entry?.outcome === 'recorded' && result && <p className="today-result" role="status">{result.qualified ? 'Your configured success rule is met.' : 'Saved. The configured success rule is not met yet.'}</p>}
        </>}
      </div>
      {canEdit && <footer className="today-detail-actions"><button className="button button-primary button-medium" disabled={saving} onClick={() => void submit('recorded')}>{saving ? 'Saving…' : entry?.outcome === 'recorded' ? 'Update check-in' : 'Save check-in'}</button><div><button className="button button-quiet button-medium" disabled={saving} onClick={() => void submit('skipped')}>Mark as missed (breaks streak)</button><small>This records an intentional missed commitment.</small></div>{entry && <button className="button button-quiet button-medium" disabled={saving} onClick={() => void clear()}>Clear check-in</button>}</footer>}
    </section>
  </div>, document.body)
}
