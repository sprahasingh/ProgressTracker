import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, insightsSectionTabs } from '../../components/ui/SectionTabs'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { CalendarDate } from '../../db/models'
import { calculateTrackerAnalytics, type TrackerAnalytics } from '../../domain/trackers/analytics'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useAuth } from '../auth/AuthProvider'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'

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
  const summaries = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.summaries : []
  const holidayCount = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.holidayCount : 0
  const visibleError = workspaceKey && error?.workspaceKey === workspaceKey ? error.message : ''
  const visibleLoading = loading || !workspaceReady || Boolean(workspaceKey && snapshot?.workspaceKey !== workspaceKey)

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
        calculateTrackerAnalytics(tracker, entries, startDate, today, holidayDates),
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
  }, [startDate, today])

  useEffect(() => {
    if (!workspaceReady || !workspaceKey) {
      setLoading(true)
      return () => { generationRef.current += 1 }
    }
    void refresh()
    return () => { generationRef.current += 1 }
  }, [refresh, workspaceKey, workspaceReady])

  const activeScheduled = summaries.filter((item) => item.scheduledCount !== null)
  const scheduledCount = activeScheduled.reduce((sum, item) => sum + (item.scheduledCount ?? 0), 0)
  const qualifiedScheduled = activeScheduled.reduce((sum, item) => sum + (item.scheduledQualifiedCount ?? 0), 0)
  const entriesCount = summaries.reduce((sum, item) => sum + item.entryCount, 0)
  const qualifiedCount = summaries.reduce((sum, item) => sum + item.qualifiedCount, 0)
  const consistency = scheduledCount ? Math.round(qualifiedScheduled / scheduledCount * 100) : null

  return <section className="tracker-page analytics-page" aria-labelledby="analytics-title">
    <PageHeader headingId="analytics-title" eyebrow="YOUR PATTERNS" title="Analytics" description="Review consistency and each measure’s own logged values. All figures come from this workspace’s saved activity." help={{ title: 'Analytics', summary: 'Explore patterns in your saved tracker activity.', description: 'Consistency uses scheduled opportunities and each tracker’s qualification rule. Metric charts preserve each measure’s unit rather than combining unrelated values. Figures reflect retained check-ins in this workspace and can change when history is edited or removed.' }} />
    <SectionTabs label="Insights sections" items={insightsSectionTabs} />
    <div className="analytics-toolbar">
      <label className="history-filter"><span>Period</span><select className="auth-input" value={range} onChange={(event) => setRange(Number(event.target.value) as RangeLength)}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></label>
      <span className="analytics-range">{calendarDateLabel(startDate, { month: 'short', day: 'numeric' })} – {calendarDateLabel(today, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
    </div>
    {visibleError && <div role="alert" className="form-alert">{visibleError}</div>}
    {visibleLoading ? <p role="status" className="tracker-loading">Loading your analytics…</p> : visibleError ? <Surface><EmptyState title="Your activity is still saved" description="This device could not open your workspace analytics." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : summaries.length === 0 ? <Surface><EmptyState title="Analytics start with your first tracker" description="Create a tracker and log activity to see consistency and metric trends here." action={<Link className="button button-primary button-medium" to="/trackers/new">Create a tracker</Link>} /></Surface> : <>
      <div className="dashboard-stats" role="group" aria-label="Activity summary">
        <AnalyticsStat label="Check-ins" value={entriesCount} detail={`${range} day period`} />
        <AnalyticsStat label="Success rules met" value={qualifiedCount} detail="among recorded check-ins" />
        <AnalyticsStat label="Scheduled opportunities" value={scheduledCount} detail="active trackers only" />
        <AnalyticsStat label="Holidays" value={holidayCount} detail="days paused across this account" />
        <AnalyticsStat label="Consistency" value={consistency === null ? '—' : `${consistency}%`} detail={consistency === null ? 'no active scheduled days' : `${qualifiedScheduled} of ${scheduledCount} scheduled days met`} />
      </div>
      <div className="analytics-trackers">
        {summaries.map((summary) => <Surface className="analytics-tracker" key={summary.tracker.id}>
          <header className="analytics-tracker-heading"><div><span className="tracker-kind-chip">{summary.tracker.status}</span><h2>{summary.tracker.name}</h2></div><span>{summary.recordedCount} recorded · {summary.skippedCount} skipped</span></header>
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
                  <div className="analytics-value-chart" role="img" aria-label={`${metric.name} daily logged values, shown separately in ${metric.unit || (metric.valueType === 'checklist' ? 'items' : 'values')}`}>
                    {visibleObservations.map((item) => <span key={item.date} title={`${calendarDateLabel(item.date)}: ${formatTrackerNumber(item.value)}${unit}`} aria-label={`${item.date}: ${formatTrackerNumber(item.value)}${unit}`} style={{ height: `${Math.max(5, item.value / maxValue * 100)}%` }} />)}
                  </div>
                  <p className="analytics-chart-caption">Each bar is one day’s value; this chart does not add values across dates.</p>
                </>}
              </section>
            })}
          </div>}
        </Surface>)}
      </div>
    </>}
  </section>
}

function AnalyticsStat({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return <Surface className="dashboard-stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></Surface>
}
