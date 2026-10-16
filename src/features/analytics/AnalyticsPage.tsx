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
import { activeAchievementOccurrences, getProgressionOverview, type ProgressionOverview } from '../../services/supabase/progressionRepository'

type AnalyticsSnapshot = { workspaceKey: string; summaries: TrackerAnalytics[]; entries: Awaited<ReturnType<typeof localRepository.listAllTrackerEntries>>; holidayCount: number; progression: ProgressionOverview | null }
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
  const allEntries = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.entries : []
  const holidayCount = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.holidayCount : 0
  const progression = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.progression : null
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
      const [trackers, allEntries, holidays, progression] = await Promise.all([
        localRepository.listTrackers(true),
        localRepository.listAllTrackerEntries(),
        localRepository.listAccountHolidays(startDate, today),
        expectedOwner ? getProgressionOverview(expectedOwner).catch(() => null) : Promise.resolve(null),
      ])
      const holidayDates = new Set(holidays.map((holiday) => holiday.date))
      const summaries = trackers.filter((tracker) => tracker.deletedAt === null).map((tracker) =>
        calculateTrackerAnalytics(tracker, allEntries, startDate, today, holidayDates, timeZone, allEntries),
      )
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setSnapshot({ workspaceKey: currentWorkspace.key, summaries, entries: allEntries, holidayCount: holidays.length, progression })
      }
    } catch {
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setError({ workspaceKey: currentWorkspace.key, message: 'Your analytics could not be loaded from this device.' })
      }
    } finally {
      if (generationRef.current === generation) setLoading(false)
    }
  }, [startDate, today, timeZone, expectedOwner])

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
  const recordedCount = summaries.reduce((sum, item) => sum + item.recordedCount, 0)
  const qualifiedCount = summaries.reduce((sum, item) => sum + item.qualifiedCount, 0)
  const streakQualifiedCount = summaries.reduce((sum, item) => sum + item.streakQualifiedCount, 0)
  const consistency = scheduledCount ? Math.round(qualifiedScheduled / scheduledCount * 100) : null
  const successRate = recordedCount ? Math.round(qualifiedCount / recordedCount * 100) : null
  const periodEvents = progression?.scoreHistory.filter((event) => event.effectiveDate >= startDate && event.effectiveDate <= today) ?? []
  const periodProvisional = progression?.provisionalRewards.filter((reward) => reward.effectiveDate >= startDate && reward.effectiveDate <= today) ?? []
  const entriesById = new Map(allEntries.map((entry) => [entry.id, entry]))
  const accountXp = progression ? periodEvents.reduce((sum, event) => sum + event.xpDelta, 0) + periodProvisional.reduce((sum, reward) => sum + reward.xpDelta, 0) : null
  const trackerAttributedXp = progression ? periodEvents.filter((event) => event.trackerId !== null).reduce((sum, event) => sum + event.xpDelta, 0) + periodProvisional.filter((reward) => entriesById.get(reward.id.replace(/^check-in:/, ''))?.trackerId).reduce((sum, reward) => sum + reward.xpDelta, 0) : null
  const selectedSummary = selectedTracker ? summaries.find((summary) => summary.tracker.id === selectedTracker.id) : null
  const selectedTrackerXp = progression && selectedTracker ? periodEvents.filter((event) => event.trackerId === selectedTracker.id).reduce((sum, event) => sum + event.xpDelta, 0) + periodProvisional.filter((reward) => entriesById.get(reward.id.replace(/^check-in:/, ''))?.trackerId === selectedTracker.id).reduce((sum, reward) => sum + reward.xpDelta, 0) : null
  const otherAccountXp = accountXp === null || trackerAttributedXp === null ? null : accountXp - trackerAttributedXp
  const earnedBadges = progression ? selectedTracker ? progression.achievements.reduce((count, achievement) => {
    const active = activeAchievementOccurrences(achievement.history)
    const attributed = active.filter((event) => event.sourceEventId && progression.scoreHistory.some((score) => score.id === event.sourceEventId && score.trackerId === selectedTracker.id))
    return count + attributed.length
  }, 0) : progression.achievements.filter((achievement) => achievement.earned).length : null

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
        <AnalyticsStat label="Success rate" value={successRate === null ? '—' : `${successRate}%`} detail={recordedCount ? `${qualifiedCount} of ${recordedCount} recorded entries` : 'no recorded entries'} help="Success Rule matches divided by recorded check-ins. Streak-only dates do not count as successes." />
        <AnalyticsStat label="Streak-qualified days" value={streakQualifiedCount} detail="in the selected period" help="Counts dates that met each tracker’s Streak Rule on an eligible streak opportunity. This is separate from Success Rule matches and success rate." />
        <AnalyticsStat label="Scheduled opportunities" value={scheduledCount} detail={selectedTracker ? 'selected tracker' : 'active trackers only'} help="Counts elapsed eligible days in the period. Standard Mode excludes holidays and rest days; Strict Mode requires every calendar day in the tracker’s active date range. An unlogged today is still open." />
        <AnalyticsStat label={selectedTracker ? 'Account holidays' : 'Holidays'} value={holidayCount} detail="account-wide in this period" help="Marked holidays are account-wide settings. They pause Standard Mode streaks; Strict Mode still requires qualifying activity on those dates." />
        <AnalyticsStat label="Consistency" value={consistency === null ? '—' : `${consistency}%`} detail={consistency === null ? 'no scheduled opportunities' : `${qualifiedScheduled} of ${scheduledCount} scheduled days met success`} help="Success Rule matches divided by elapsed scheduled opportunities. Rest days are excluded in Standard Mode; Strict Mode uses every in-period calendar date. A streak-only day does not inflate consistency." />
        {selectedSummary && <>
          <AnalyticsStat label="Current Streak" value={selectedSummary.currentStreak} detail={`${selectedTracker?.name} · Streak Rule`} help="Uses only this tracker’s Streak Rule and scheduling policy. Success Rule-only dates do not advance it." />
          <AnalyticsStat label="Longest Streak" value={selectedSummary.longestStreak} detail={`${selectedTracker?.name} · all saved history`} help="The longest run of this tracker’s Streak Rule across its active dates. Historical edits are reflected after local and server reconciliation." />
        </>}
        {progression && <>
          {selectedTracker
            ? <AnalyticsStat label="Tracker XP" value={selectedTrackerXp ?? '—'} detail="net XP attributed to this tracker" help="Includes confirmed and pending rewards with a source linked to this tracker. Account-wide and older unattributed rewards are not assigned to it." />
            : <>
              <AnalyticsStat label="Tracker-attributed XP" value={trackerAttributedXp ?? '—'} detail="net XP with a tracker source" help="Sums rewards whose ledger source identifies a tracker. Account-wide and unattributed rewards remain separate." />
              <AnalyticsStat label="Account-wide and unattributed XP" value={otherAccountXp ?? '—'} detail="net account XP without a tracker source" help="Includes account-wide rewards and older rewards that do not have reliable tracker attribution. These are not assigned to individual trackers." />
            </>}
          <AnalyticsStat label="Account XP" value={accountXp ?? '—'} detail="net XP across all sources in this period" help="Includes tracker-attributed, account-wide, and unattributed ledger events, plus pending rewards." />
          <AnalyticsStat label={selectedTracker ? 'Badges attributed to tracker' : 'Earned badges'} value={earnedBadges ?? '—'} detail={selectedTracker ? 'unlock events with a linked tracker source' : 'active account awards'} help={selectedTracker ? 'Only badge unlock records linked to a reward event from this tracker are counted. Account-wide badges are not assigned to it.' : 'Counts active earned achievement awards for the account. Badge history and progress are available in Wins.'} />
        </>}
      </div>
      <div className="analytics-trackers">
        {summaries.map((summary) => <Surface className="analytics-tracker" key={summary.tracker.id}>
          <header className="analytics-tracker-heading"><div><span className="tracker-kind-chip">{summary.tracker.status}</span><h2>{summary.tracker.name}</h2></div><span>{summary.recordedCount} recorded · {summary.skippedCount} skipped · {summary.currentStreak} current / {summary.longestStreak} longest streak{summary.historicalCount ? ` · ${summary.historicalCount} historical entries excluded` : ''}</span></header>
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
