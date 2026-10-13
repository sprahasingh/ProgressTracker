import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, insightsSectionTabs } from '../../components/ui/SectionTabs'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import type { CalendarDate } from '../../db/models'
import { calculateTrackerAnalytics, type TrackerAnalytics } from '../../domain/trackers/analytics'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useAuth } from '../auth/AuthProvider'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { TrackerFilter, useTrackerFilter } from '../shared/TrackerFilter'
import { InfoButton } from '../../components/ui/InfoButton'

type AnalyticsSnapshot = { workspaceKey: string; summaries: TrackerAnalytics[]; holidayCount: number }
type RangeLength = 7 | 30 | 90

export function AnalyticsPage() {
  const { status: authStatus, user, workspaceStatus, workspaceUserId, sessionTransitionPending } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [range, setRange] = useState<RangeLength>(30)
  const startDate = shiftCalendarDate(today, -(range - 1)) as CalendarDate
  const expectedOwner = authStatus === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && authStatus !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === expectedOwner
  const workspaceKey = workspaceReady ? expectedOwner ?? 'guest' : null
  const workspaceRef = useRef({ key: workspaceKey, ready: workspaceReady })
  workspaceRef.current = { key: workspaceKey, ready: workspaceReady }
  const generationRef = useRef(0)
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ workspaceKey: string; message: string } | null>(null)
  const allSummaries = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.summaries : []
  const holidayCount = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.holidayCount : 0
  const visibleError = workspaceKey && error?.workspaceKey === workspaceKey ? error.message : ''
  const visibleLoading = loading || !workspaceReady || Boolean(workspaceKey && snapshot?.workspaceKey !== workspaceKey)
  const trackerFilter = useTrackerFilter(expectedOwner, allSummaries.map((summary) => summary.tracker), !visibleLoading)
  const selectedTracker = allSummaries.find((summary) => summary.tracker.id === trackerFilter.selectedId)?.tracker ?? null
  const summaries = selectedTracker ? allSummaries.filter((summary) => summary.tracker.id === selectedTracker.id) : allSummaries

  const refresh = useCallback(async () => {
    const currentWorkspace = workspaceRef.current
    if (!currentWorkspace.ready || !currentWorkspace.key) return
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const [trackers, entries, holidays] = await Promise.all([
        localRepository.listTrackers(true),
        localRepository.listTrackerEntriesBetween(startDate, today),
        localRepository.listAccountHolidays(startDate, today),
      ])
      const holidayDates = new Set(holidays.map((holiday) => holiday.date))
      const summaries = trackers.filter((tracker) => tracker.deletedAt === null).map((tracker) =>
        calculateTrackerAnalytics(tracker, entries, startDate, today, holidayDates, timeZone),
      )
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setSnapshot({ workspaceKey: currentWorkspace.key, summaries, holidayCount: holidays.length })
      }
    } catch {
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setError({ workspaceKey: currentWorkspace.key, message: 'Your analytics could not be loaded from this device.' })
      }
    } finally {
      if (generationRef.current === generation) setLoading(false)
    }
  }, [startDate, today, timeZone])

  useEffect(() => {
    if (!workspaceReady || !workspaceKey) {
      setLoading(true)
      return () => { generationRef.current += 1 }
    }
    void refresh()
    return () => { generationRef.current += 1 }
  }, [refresh, workspaceKey, workspaceReady])
  useWorkspaceDataChanges(expectedOwner, workspaceReady, refresh)

  const activeScheduled = summaries.filter((item) => item.scheduledCount !== null)
  const scheduledCount = activeScheduled.reduce((sum, item) => sum + (item.scheduledCount ?? 0), 0)
  const qualifiedScheduled = activeScheduled.reduce((sum, item) => sum + (item.scheduledQualifiedCount ?? 0), 0)
  const entriesCount = summaries.reduce((sum, item) => sum + item.entryCount, 0)
  const qualifiedCount = summaries.reduce((sum, item) => sum + item.qualifiedCount, 0)
  const consistency = scheduledCount ? Math.round(qualifiedScheduled / scheduledCount * 100) : null

  return <section className="tracker-page analytics-page" aria-labelledby="analytics-title">
    <PageHeader headingId="analytics-title" eyebrow="YOUR PATTERNS" title="Analytics" description="Review current consistency and saved activity. Archived trackers remain labeled in historical reports." help={{ title: 'Analytics', summary: 'Statistics follow the tracker selector and selected date range.', description: 'All Trackers adds comparable counts such as check-ins and eligible opportunities while keeping metric values separate because units can differ. Individual Tracker recalculates counts and trends using only that tracker. Scheduled opportunities and consistency include active trackers only. Archived tracker cards show retained historical values and saved check-ins, but do not contribute to current completion or opportunity statistics. Holidays and rest days are excluded in Standard Mode and required in Strict Mode.' }} />
    <SectionTabs label="Insights sections" items={insightsSectionTabs} />
    <p className="insights-progression-link">Confirmed XP, pending rewards, and achievement progress are in <Link to="/achievements">Wins</Link>.</p>
      <div className="analytics-toolbar">
      <TrackerFilter trackers={allSummaries.map((summary) => summary.tracker)} selectedId={trackerFilter.selectedId} onChange={trackerFilter.select} label="Tracker" />
      <label className="history-filter"><span>Period</span><select className="auth-input" value={range} onChange={(event) => setRange(Number(event.target.value) as RangeLength)}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></label>
      <span className="analytics-range">{calendarDateLabel(startDate, { month: 'short', day: 'numeric' })} – {calendarDateLabel(today, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
    </div>
    {visibleError && <div role="alert" className="form-alert">{visibleError}</div>}
    {visibleLoading ? <p role="status" className="tracker-loading">Loading your analytics…</p> : visibleError ? <Surface><EmptyState title="Your activity is still saved" description="This device could not open your workspace analytics." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : summaries.length === 0 ? <Surface><EmptyState title="Analytics start with your first tracker" description="Create a tracker and log activity to see consistency and metric trends here." action={<Link className="button button-primary button-medium" to="/trackers/new">Create a tracker</Link>} /></Surface> : <>
      <div className="dashboard-stats" role="group" aria-label="Activity summary">
        <AnalyticsStat label="Check-ins" value={entriesCount} detail={`${range} day period`} help="Counts saved recorded and intentionally skipped entries for the selected tracker, or all displayed trackers. In All Trackers, counts are added across trackers." />
        <AnalyticsStat label="Success rules met" value={qualifiedCount} detail="among recorded check-ins" help="Counts recorded entries that met each tracker’s configured success rule. A day can have a saved entry that does not meet its rule." />
        <AnalyticsStat label="Scheduled opportunities" value={scheduledCount} detail="active trackers only" help="Counts elapsed eligible days in the period. Standard Mode excludes holidays and rest days; Strict Mode requires every calendar day in the tracker’s active date range. An unlogged today is still open." />
        <AnalyticsStat label="Holidays" value={holidayCount} detail="days paused across this account" help="Counts account holidays in this period. They pause Standard Mode streaks; Strict Mode still requires qualifying activity on those dates." />
        <AnalyticsStat label="Consistency" value={consistency === null ? '—' : `${consistency}%`} detail={consistency === null ? 'no active scheduled days' : `${qualifiedScheduled} of ${scheduledCount} scheduled days met`} help="Qualified eligible days divided by elapsed opportunities. All Trackers adds each tracker’s own numerator and denominator; a tracker’s policy does not change another tracker’s schedule." />
      </div>
      <div className="analytics-trackers">
        {summaries.map((summary) => <Surface className="analytics-tracker" key={summary.tracker.id}>
          <header className="analytics-tracker-heading"><div><span className="tracker-kind-chip">{summary.tracker.status}</span><h2>{summary.tracker.name}</h2></div><span>{summary.recordedCount} recorded · {summary.skippedCount} skipped{summary.historicalCount ? ` · ${summary.historicalCount} historical entries excluded` : ''}</span></header>
          {summary.scheduledCount !== null && <p className="analytics-consistency">{summary.consistencyPercent === null ? 'No scheduled dates in this period.' : `${summary.scheduledQualifiedCount} of ${summary.scheduledCount} scheduled days met the success rule · ${summary.consistencyPercent}% consistency.`}</p>}
          {summary.metrics.length > 0 && <div className="analytics-metrics">
            {summary.metrics.map((metricSummary) => {
              const { metric, observations } = metricSummary
              const visibleObservations = observations.slice(-14)
              const maxValue = Math.max(1, ...visibleObservations.map((item) => item.value))
              const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
              const latest = metricSummary.latestValue
              return <section className="analytics-metric" key={metric.id} aria-label={`${metric.name} analysis`}>
                <div className="analytics-metric-heading"><h3>{metric.name}</h3><span>{metricSummary.observationCount} values{metricSummary.averageValue === null ? '' : ` · average ${formatTrackerNumber(metricSummary.averageValue)}${unit}`}</span></div>
                {visibleObservations.length === 0 ? <p className="analytics-empty-metric">No values recorded in this period.</p> : <>
                  <p className="analytics-latest">Latest: {latest === null ? '—' : metric.valueType === 'boolean' ? latest : formatTrackerNumber(latest)}{latest === null ? '' : unit}{metric.valueType === 'boolean' && latest !== null ? latest === 1 ? ' · yes' : ' · no' : ''}</p>
                  <div className="analytics-value-chart" aria-hidden="true">
                    {visibleObservations.map((item) => <span key={item.date} style={{ height: `${Math.max(5, item.value / maxValue * 100)}%` }} />)}
                  </div>
                  <p className="analytics-chart-caption">Each bar is one day’s value; the latest {visibleObservations.length} values are listed below. The chart does not add values across dates.</p>
                  <MetricDailyValues metricName={metric.name} valueType={metric.valueType} unit={unit} observations={visibleObservations} />
                </>}
              </section>
            })}
          </div>}
        </Surface>)}
      </div>
    </>}
  </section>
}

function MetricDailyValues({ metricName, valueType, unit, observations }: {
  metricName: string
  valueType: string
  unit: string
  observations: Array<{ date: string; value: number }>
}) {
  const id = useId()
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const selected = observations.find((item) => item.date === selectedDate)
  const dateLabel = (date: string) => calendarDateLabel(date, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const valueLabel = (value: number) => valueType === 'boolean' ? value === 1 ? 'Yes' : 'No' : `${formatTrackerNumber(value)}${unit}`

  return <details className="analytics-daily-values">
    <summary aria-controls={id} aria-label={`View ${observations.length} daily ${observations.length === 1 ? 'value' : 'values'} for ${metricName}`}>View {observations.length} daily {observations.length === 1 ? 'value' : 'values'}</summary>
    <div id={id}>
      <ul>
        {observations.map((item) => <li key={item.date}>
          <button type="button" aria-pressed={selectedDate === item.date} aria-label={`${dateLabel(item.date)}: ${valueLabel(item.value)}`} onClick={() => setSelectedDate(item.date)}>
            <span>{dateLabel(item.date)}</span><strong>{valueLabel(item.value)}</strong>
          </button>
        </li>)}
      </ul>
      {selected && <p className="analytics-daily-value-status" role="status">{metricName} · {dateLabel(selected.date)}: {valueLabel(selected.value)}</p>}
    </div>
  </details>
}

function AnalyticsStat({ label, value, detail, help }: { label: string; value: number | string; detail: string; help: string }) {
  return <Surface className="dashboard-stat"><span className="dashboard-stat-label">{label}<InfoButton title={label} summary={detail} description={help} /></span><strong>{value}</strong><small>{detail}</small></Surface>
}
