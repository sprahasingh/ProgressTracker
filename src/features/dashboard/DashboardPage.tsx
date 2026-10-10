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
import { evaluateTrackerEntry, isScheduledDate, isTrackerInActivePeriod } from '../../domain/trackers/planning'
import { calculateProgressRewards, calculateStreak, qualifiesForStreak } from '../../domain/trackers/progression'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { ACTIVITY_STATUS_PRESENTATION, getTrackerActivityStatus } from '../../domain/trackers/activityStatus'
import { TrackerFilter, useTrackerFilter } from '../shared/TrackerFilter'
import { calculateActivityHeatmap } from '../../domain/trackers/activityHeatmap'
import { ActivityHeatmap } from './ActivityHeatmap'
import { availableHeatmapYears, heatmapDateRange, type HeatmapDateRangeOption, type HeatmapRangeSelection, isHistoricalHeatmapYear } from './heatmapDateRange'

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
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1024 : window.innerWidth)
  const [rangeSelection, setRangeSelection] = useState<HeatmapRangeSelection>(() => {
    if (typeof window === 'undefined') return 'auto'
    const saved = window.sessionStorage.getItem('insights-heatmap-range')
    return saved === 'last3Months' || saved === 'last6Months' || saved === 'last12Months' || saved === 'year' ? saved : 'auto'
  })
  const [selectedYear, setSelectedYear] = useState(() => {
    if (typeof window === 'undefined') return new Date().getFullYear()
    const saved = Number(window.sessionStorage.getItem('insights-heatmap-year'))
    return Number.isInteger(saved) && saved > 0 ? saved : Number(today.slice(0, 4))
  })
  const refreshGeneration = useRef(0)

  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateWidth)
    return () => window.removeEventListener('resize', updateWidth)
  }, [])

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
  const trackerFilter = useTrackerFilter(owner, data.trackers, !loading && workspaceReady)
  const selectedTracker = data.trackers.find((tracker) => tracker.id === trackerFilter.selectedId) ?? null
  const visibleTrackers = selectedTracker ? [selectedTracker] : data.trackers
  const visibleIds = new Set(visibleTrackers.map((tracker) => tracker.id))
  const visibleEntries = data.entries.filter((entry) => visibleIds.has(entry.trackerId))
  const effectiveRange: HeatmapDateRangeOption = rangeSelection === 'auto' ? (viewportWidth < 768 ? 'last6Months' : 'last12Months') : rangeSelection
  const yearOptions = availableHeatmapYears(data.trackers, today)
  const effectiveYear = yearOptions.includes(selectedYear) ? selectedYear : Number(today.slice(0, 4))
  const { startDate: heatmapStart, endDate: heatmapEnd } = heatmapDateRange(today, effectiveRange, effectiveYear)
  const heatmapDays = useMemo(() => calculateActivityHeatmap({ trackers: visibleTrackers, entries: visibleEntries, startDate: heatmapStart, endDate: heatmapEnd, holidays: new Set(data.holidays) }), [visibleTrackers, visibleEntries, heatmapStart, heatmapEnd, data.holidays])
  const selectHeatmapRange = (selection: HeatmapDateRangeOption) => {
    setRangeSelection(selection)
    window.sessionStorage.setItem('insights-heatmap-range', selection)
    if (selection === 'year') {
      const currentYear = Number(today.slice(0, 4))
      setSelectedYear(currentYear)
      window.sessionStorage.setItem('insights-heatmap-year', String(currentYear))
    }
  }
  const selectHeatmapYear = (year: number) => {
    setSelectedYear(year)
    window.sessionStorage.setItem('insights-heatmap-year', String(year))
  }
  const entryById = useMemo(() => new Map(visibleTrackers.map((tracker) => [tracker.id, tracker])), [visibleTrackers])
  const streakByTracker = useMemo(() => new Map(visibleTrackers.map((tracker) => {
    const trackerEntries = visibleEntries.filter((entry) => entry.trackerId === tracker.id)
    return [tracker.id, calculateStreak(tracker, trackerEntries, today, new Set(data.holidays))] as const
  })), [visibleTrackers, visibleEntries, data.holidays, today])
  const rewardPoints = [...streakByTracker.values()].reduce((sum, streak) => sum + calculateProgressRewards(streak).totalPoints, 0)
  const weekStart = shiftCalendarDate(today, -6)
  const weekEntries = visibleEntries.filter((entry) => entry.date >= weekStart && entry.date <= today)
  const hasOpportunity = (tracker: StoredTrackerDefinition | undefined, date: string) => Boolean(tracker && (tracker.strictMode
    ? isTrackerInActivePeriod(tracker, date)
    : !data.holidays.includes(date) && isScheduledDate(tracker, date)))
  const successfulWeek = weekEntries.filter((entry) => {
    const tracker = entryById.get(entry.trackerId)
    return entry.outcome === 'recorded' && hasOpportunity(tracker, entry.date) && evaluateTrackerEntry(tracker!, entry).qualified
  })
  const consistencyQualified = weekEntries.filter((entry) => {
    const tracker = entryById.get(entry.trackerId)
    return entry.outcome === 'recorded' && hasOpportunity(tracker, entry.date) && qualifiesForStreak(tracker!, entry)
  })
  const scheduledWeek = visibleTrackers.reduce((count, tracker) => {
    for (let day = weekStart; day <= today; day = shiftCalendarDate(day, 1)) {
      const opportunity = hasOpportunity(tracker, day)
      const openToday = day === today && !weekEntries.some((entry) => entry.trackerId === tracker.id && entry.date === day)
      if (opportunity && !openToday) count += 1
    }
    return count
  }, 0)
  const completionPercent = scheduledWeek ? Math.round(consistencyQualified.length / scheduledWeek * 100) : 0

  return (
    <section className="tracker-page dashboard-page" aria-labelledby="dashboard-title">
      <PageHeader headingId="dashboard-title" eyebrow="YOUR PROGRESS" title="Insights" description={`Patterns and wins from your saved activity · ${calendarDateLabel(today, { month: 'long', day: 'numeric' })}`} help={{ title: 'Insights', summary: 'See recent consistency, tracker-specific streaks, and long-term activity.', description: 'Use the tracker selector to switch between a combined view and one tracker. All Trackers adds eligible opportunities and results across trackers; their streaks remain separate. The heatmap normalizes each day by that day’s eligible opportunities and applies each tracker’s Standard or Strict Mode policy.' }} action={<Link className="button button-primary button-medium" to="/">Go to today</Link>} />
      <SectionTabs label="Insights sections" items={insightsSectionTabs} />
      {error && <div role="alert" className="form-alert">{error}</div>}
      {loading ? <p role="status" className="tracker-loading">Loading your progress…</p> : error ? <Surface><EmptyState title="Your progress is still here" description="This device could not open local storage. Try loading the overview again." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : data.trackers.length === 0 ? <Surface><EmptyState title="Your overview starts with a tracker" description="Once you create a tracker and log check-ins, this page will summarize your real activity." action={<Link className="button button-primary button-medium" to="/trackers/new">Create a tracker</Link>} /></Surface> : <>
        <div className="insights-filter-toolbar"><TrackerFilter trackers={data.trackers} selectedId={trackerFilter.selectedId} onChange={trackerFilter.select} label="Show activity for" /></div>
        <ActivityHeatmap days={heatmapDays} trackerName={selectedTracker?.name ?? null} rangeSelection={effectiveRange} year={effectiveYear} years={yearOptions} onRangeChange={selectHeatmapRange} onYearChange={selectHeatmapYear} scrollToStart={effectiveRange === 'year' && isHistoricalHeatmapYear(effectiveYear, today)} />
        <div className="dashboard-stats" role="group" aria-label="Recent progress summary">
          <StatCard label={selectedTracker ? 'Selected tracker' : 'Active trackers'} value={String(visibleTrackers.length)} detail={selectedTracker ? selectedTracker.name : 'ready for your next check-in'} help="Counts active trackers in this workspace. Archived items and Bin items are not included." />
          <StatCard label="Successes · 7 days" value={String(successfulWeek.length)} detail={`${scheduledWeek} elapsed opportunities`} help="Counts recorded check-ins that met their success rule on a day eligible under that tracker’s policy during the last seven calendar days." />
          <StatCard label="Weekly consistency" value={scheduledWeek ? `${completionPercent}%` : '—'} detail={scheduledWeek ? 'of eligible opportunities' : 'nothing eligible this week'} help="Streak-qualified check-ins divided by elapsed opportunities over the last seven calendar days. Each tracker uses its own streak qualification and policy. Holidays and rest days are excluded in Standard Mode and required in Strict Mode. Today remains open until it ends." />
          <StatCard label="Reward points" value={String(rewardPoints)} detail="active trackers · from saved check-ins" help="A playful summary of points earned from active tracker streaks and qualifying check-ins. It does not change your records or goals." />
        </div>
        <section className="dashboard-tracker-section" aria-labelledby="progress-heading">
            <SectionHeader className="dashboard-section-heading dashboard-tracker-title" eyebrow={<><span className="eyebrow-line" /> KEEP GOING</>} title="Your trackers" headingId="progress-heading" help={{ title: 'Tracker progress cards', summary: 'See streaks and the latest saved check-in for each active tracker.', description: 'Standard Mode counts qualifying scheduled dates; holidays and rest days preserve continuity without adding to the count. Strict Mode counts every calendar date, including holidays and rest days. Missed or unqualified elapsed opportunities break a streak. Streaks are recalculated from saved entries and the current policy.' }} action={<Link to="/trackers">All trackers <span aria-hidden="true">→</span></Link>} />
            <div className="dashboard-tracker-list">
              {visibleTrackers.map((tracker) => {
                const history = visibleEntries.filter((entry) => entry.trackerId === tracker.id)
                const streak = streakByTracker.get(tracker.id)!
                const latest = history[0]
                const latestResult = latest?.outcome === 'recorded' ? evaluateTrackerEntry(tracker, latest).qualified : false
                const status = getTrackerActivityStatus({ tracker, entry: latest, date: latest?.date ?? today, today, holidays: new Set(data.holidays) })
                const statusClass = status
                return <Surface key={tracker.id} className={`dashboard-tracker-card status-card status-${statusClass}`}><div className="dashboard-tracker-card-top"><span className="tracker-kind-chip">{tracker.kind}{tracker.strictMode ? ' · Strict' : ''}</span><span>{latest ? calendarDateLabel(latest.date) : 'Ready when you are'}</span></div><h3>{tracker.name}</h3>{streak.current > 0 || streak.longest > 0 ? <div className="dashboard-tracker-stats"><span><strong>{streak.current}</strong><small>current streak <InfoButton title="Current streak" summary="Consecutive qualifying opportunities up to today." description={tracker.strictMode ? 'Strict Mode counts every calendar day from tracker start through deadline, including holidays and rest days. A recorded entry must meet this tracker’s streak qualification. Today remains open until it ends.' : 'Standard Mode counts qualifying scheduled days. Missed scheduled days break the streak, while holidays and rest days preserve it without adding to the count. Today remains open until it ends.'} /></small></span><span><strong>{streak.longest}</strong><small>personal best <InfoButton title="Longest streak" summary="The longest uninterrupted run of qualifying days in this tracker’s saved history." description={tracker.strictMode ? 'This uses every calendar day within the tracker period, including holidays and rest days. Changing Strict Mode recalculates the value from saved entries; entries are not changed.' : 'This counts qualifying scheduled days. Missed scheduled days break the run; holidays and rest days pause it. Changing Strict Mode recalculates the value from saved entries; entries are not changed.'} /></small></span></div> : <p className="dashboard-first-action">Your pattern starts with one check-in.</p>}<div className="dashboard-latest-state">{latest ? <><span className={`history-outcome ${statusClass}`}>{ACTIVITY_STATUS_PRESENTATION[status].label}{latest.outcome === 'skipped' ? ' · marked intentionally' : latestResult ? ' · success rule met' : ''}</span><span>{latest.outcome === 'recorded' ? summarizeValues(tracker, latest) : 'No values recorded'}</span></> : <><span className={`history-outcome ${status}`}>{ACTIVITY_STATUS_PRESENTATION[status].label}</span><Link to="/">Make your first check-in →</Link></>}</div></Surface>
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
