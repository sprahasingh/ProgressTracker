import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, insightsSectionTabs } from '../../components/ui/SectionTabs'
import { InfoButton } from '../../components/ui/InfoButton'
import { SectionHeader } from '../../components/ui/SectionHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import { useAuth } from '../auth/AuthProvider'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry, isScheduledDate } from '../../domain/trackers/planning'
import { calculateProgressRewards, calculateStreak } from '../../domain/trackers/progression'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { ACTIVITY_STATUS_PRESENTATION, getTrackerActivityStatus } from '../../domain/trackers/activityStatus'

type DashboardData = { trackers: StoredTrackerDefinition[]; entries: StoredTrackerEntry[]; holidays: string[] }

export function DashboardPage() {
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const owner = status === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === owner
  const workspaceKey = owner ?? 'guest'
  const workspaceRef = useRef({ key: workspaceKey, ready: workspaceReady })
  workspaceRef.current = { key: workspaceKey, ready: workspaceReady }
  const [data, setData] = useState<DashboardData>({ trackers: [], entries: [], holidays: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refreshGeneration = useRef(0)

  const refresh = useCallback(async () => {
    if (!workspaceRef.current.ready) return
    const requestWorkspace = workspaceRef.current.key
    const generation = ++refreshGeneration.current
    setLoading(true)
    setError('')
    try {
      const trackers = (await localRepository.listTrackers(true)).filter((tracker) => tracker.status === 'active' && tracker.deletedAt === null)
      const earliest = trackers.reduce<CalendarDate>((date, tracker) => {
        const created = (tracker.startDate ?? tracker.createdAt.slice(0, 10)) as CalendarDate
        return created < date ? created : date
      }, today)
      const [entries, holidays] = await Promise.all([
        trackers.length ? localRepository.listTrackerEntriesBetween(earliest, today) : Promise.resolve([]),
        localRepository.listAccountHolidays(earliest, today),
      ])
      const ids = new Set(trackers.map((tracker) => tracker.id))
      if (refreshGeneration.current === generation && workspaceRef.current.ready && workspaceRef.current.key === requestWorkspace) setData({ trackers, entries: entries.filter((entry) => ids.has(entry.trackerId)), holidays: holidays.map((holiday) => holiday.date) })
    } catch {
      if (refreshGeneration.current === generation && workspaceRef.current.key === requestWorkspace) setError('Your overview could not be loaded from this device.')
    } finally {
      if (refreshGeneration.current === generation && workspaceRef.current.key === requestWorkspace) setLoading(false)
    }
  }, [today])

  useEffect(() => {
    if (workspaceReady) void refresh()
    else setLoading(true)
    return () => { refreshGeneration.current += 1 }
  }, [refresh, workspaceReady, workspaceKey])
  useWorkspaceDataChanges(owner, workspaceReady, refresh)
  const entryById = useMemo(() => new Map(data.trackers.map((tracker) => [tracker.id, tracker])), [data.trackers])
  const streakByTracker = useMemo(() => new Map(data.trackers.map((tracker) => {
    const trackerEntries = data.entries.filter((entry) => entry.trackerId === tracker.id)
    return [tracker.id, calculateStreak(tracker, trackerEntries, today, new Set(data.holidays))] as const
  })), [data.trackers, data.entries, data.holidays, today])
  const rewardPoints = [...streakByTracker.values()].reduce((sum, streak) => sum + calculateProgressRewards(streak).totalPoints, 0)
  const weekStart = shiftCalendarDate(today, -6)
  const weekEntries = data.entries.filter((entry) => entry.date >= weekStart && entry.date <= today)
  const qualifiedWeek = weekEntries.filter((entry) => {
    const tracker = entryById.get(entry.trackerId)
    return entry.outcome === 'recorded' && tracker !== undefined && !data.holidays.includes(entry.date) && isScheduledDate(tracker, entry.date) && evaluateTrackerEntry(tracker, entry).qualified
  })
  const scheduledWeek = data.trackers.reduce((count, tracker) => {
    for (let day = weekStart; day <= today; day = shiftCalendarDate(day, 1)) if (!data.holidays.includes(day) && isScheduledDate(tracker, day)) count += 1
    return count
  }, 0)
  const completionPercent = scheduledWeek ? Math.round(qualifiedWeek.length / scheduledWeek * 100) : 0

  return (
    <section className="tracker-page dashboard-page" aria-labelledby="dashboard-title">
      <PageHeader headingId="dashboard-title" eyebrow="YOUR PROGRESS" title="Insights" description={`Patterns and wins from your saved activity · ${calendarDateLabel(today, { month: 'long', day: 'numeric' })}`} help={{ title: 'Insights', summary: 'See recent consistency, trends, and wins from your active trackers.', description: 'These summaries are calculated from saved check-ins in this workspace and use its time zone. Reward points and streaks summarize qualifying scheduled activity; they are not separate records or a measure of your personal worth.' }} action={<Link className="button button-primary button-medium" to="/">Go to today</Link>} />
      <SectionTabs label="Insights sections" items={insightsSectionTabs} />
      {error && <div role="alert" className="form-alert">{error}</div>}
      {loading ? <p role="status" className="tracker-loading">Loading your progress…</p> : error ? <Surface><EmptyState title="Your progress is still here" description="This device could not open local storage. Try loading the overview again." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : data.trackers.length === 0 ? <Surface><EmptyState title="Your overview starts with a tracker" description="Once you create a tracker and log check-ins, this page will summarize your real activity." action={<Link className="button button-primary button-medium" to="/trackers/new">Create a tracker</Link>} /></Surface> : <>
        <div className="dashboard-stats" role="group" aria-label="Recent progress summary">
          <StatCard label="Active trackers" value={String(data.trackers.length)} detail="ready for your next check-in" help="Counts active trackers in this workspace. Archived items and Bin items are not included." />
          <StatCard label="Successes · 7 days" value={String(qualifiedWeek.length)} detail={`${scheduledWeek} scheduled check-ins`} help="Counts recorded check-ins that met their success rule on scheduled days during the last seven calendar days, including today." />
          <StatCard label="Weekly consistency" value={scheduledWeek ? `${completionPercent}%` : '—'} detail={scheduledWeek ? 'of scheduled opportunities' : 'nothing scheduled this week'} help="Qualified scheduled check-ins divided by scheduled opportunities over the last seven days. Rest days are excluded. A dash means no opportunities were scheduled." />
          <StatCard label="Reward points" value={String(rewardPoints)} detail="active trackers · from saved check-ins" help="A playful summary of points earned from active tracker streaks and qualifying check-ins. It does not change your records or goals." />
        </div>
        <section className="dashboard-tracker-section" aria-labelledby="progress-heading">
            <SectionHeader className="dashboard-section-heading dashboard-tracker-title" eyebrow={<><span className="eyebrow-line" /> KEEP GOING</>} title="Your trackers" headingId="progress-heading" help={{ title: 'Tracker progress cards', summary: 'See streaks and the latest saved check-in for each active tracker.', description: 'A current streak counts consecutive scheduled dates that qualified; rest days are skipped. Personal best is the longest qualifying streak recorded. The latest status distinguishes a successful rule, a logged value that did not qualify, and a skipped day. Select a tracker or open Today to record more progress.' }} action={<Link to="/trackers">All trackers <span aria-hidden="true">→</span></Link>} />
            <div className="dashboard-tracker-list">
              {data.trackers.map((tracker) => {
                const history = data.entries.filter((entry) => entry.trackerId === tracker.id)
                const streak = streakByTracker.get(tracker.id)!
                const latest = history[0]
                const latestResult = latest?.outcome === 'recorded' ? evaluateTrackerEntry(tracker, latest).qualified : false
                const status = getTrackerActivityStatus({ tracker, entry: latest, date: latest?.date ?? today, today, holidays: new Set(data.holidays) })
                const statusClass = latest?.outcome === 'skipped' ? 'skipped' : status
                return <Surface key={tracker.id} className={`dashboard-tracker-card status-card status-${statusClass}`}><div className="dashboard-tracker-card-top"><span className="tracker-kind-chip">{tracker.kind}</span><span>{latest ? calendarDateLabel(latest.date) : 'Ready when you are'}</span></div><h3>{tracker.name}</h3>{streak.current > 0 || streak.longest > 0 ? <div className="dashboard-tracker-stats"><span><strong>{streak.current}</strong><small>current streak</small></span><span><strong>{streak.longest}</strong><small>personal best</small></span></div> : <p className="dashboard-first-action">Your pattern starts with one check-in.</p>}<div className="dashboard-latest-state">{latest ? <><span className={`history-outcome ${statusClass}`}>{latest.outcome === 'skipped' ? 'Skipped · neutral' : `${ACTIVITY_STATUS_PRESENTATION[status].label}${latestResult ? ' · success rule met' : ''}`}</span><span>{latest.outcome === 'recorded' ? summarizeValues(tracker, latest) : 'No values recorded'}</span></> : <><span className={`history-outcome ${status}`}>{ACTIVITY_STATUS_PRESENTATION[status].label}</span><Link to="/">Make your first check-in →</Link></>}</div></Surface>
              })}
            </div>
          </section>
      </>}
    </section>
  )
}

function StatCard({ label, value, detail, help }: { label: string; value: string; detail: string; help: string }) {
  return <Surface className="dashboard-stat"><span className="dashboard-stat-label">{label}<InfoButton title={label} summary={detail} description={help} /></span><strong>{value}</strong><small>{detail}</small></Surface>
}

function summarizeValues(tracker: StoredTrackerDefinition, entry: StoredTrackerEntry): string {
  const values = tracker.metrics.flatMap((metric) => {
    const value = entry.values[metric.id]
    if (typeof value === 'number') {
      const unit = metric.unit ? ` ${metric.unit}` : ''
      const target = metric.thresholds?.target
      if (target === undefined) return [`${metric.name}: ${formatTrackerNumber(value)}${unit}`]
      return metric.thresholds?.direction === 'decrease'
        ? [`${metric.name}: ${formatTrackerNumber(value)}${unit} · target ≤ ${formatTrackerNumber(target)}${unit}`]
        : [`${metric.name}: ${formatTrackerNumber(value)} / ${formatTrackerNumber(target)}${unit}`]
    }
    if (typeof value === 'boolean') return value ? [metric.name] : []
    if (metric.valueType === 'checklist' && typeof value === 'object' && value !== null) {
      const done = Object.values(value).filter((checked) => checked === true).length
      return [`${metric.name}: ${done} done`]
    }
    return []
  })
  return values.join(' · ') || (entry.note ? entry.note : 'Check-in recorded')
}
