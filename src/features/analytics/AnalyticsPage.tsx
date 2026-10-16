import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
  const selectedTrackerXp = progression && selectedTracker ? periodEvents.filter((event) => event.trackerId === selectedTracker.id).reduce((sum, event) => sum + event.xpDelta, 0) + periodProvisional.filter((reward) => entriesById.get(reward.id.replace(/^check-in:/, ''))?.trackerId === selectedTracker.id).reduce((sum, reward) => sum + reward.xpDelta, 0) : null
  const otherAccountXp = accountXp === null || trackerAttributedXp === null ? null : accountXp - trackerAttributedXp
  const accountXpOutsideSelectedTracker = accountXp === null || selectedTrackerXp === null ? null : accountXp - selectedTrackerXp
  const earnedBadges = progression ? selectedTracker ? progression.achievements.reduce((count, achievement) => {
    const active = activeAchievementOccurrences(achievement.history)
    const attributed = active.filter((event) => event.sourceEventId && progression.scoreHistory.some((score) => score.id === event.sourceEventId && score.trackerId === selectedTracker.id))
    return count + attributed.length
  }, 0) : progression.achievements.filter((achievement) => achievement.earned).length : null
  const hasNoCheckIns = entriesCount === 0
  const hasNoOpportunities = scheduledCount === 0
  const hasNoMetricObservations = summaries.every((summary) => summary.metrics.every((metric) => metric.observationCount === 0))

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
      <div className="analytics-summary-groups" role="group" aria-label="Period summary">
        <AnalyticsGroup title="Activity" className="analytics-summary-activity">
          <AnalyticsStat label="Check-ins" value={entriesCount} detail={`${range} day period`} help="Counts the latest saved recorded and intentionally skipped entries in the selected period. In All Trackers, counts are added across trackers; the same date can contribute one entry per tracker." />
          <AnalyticsStat label="Successful check-ins" value={qualifiedCount} detail={recordedCount ? `of ${recordedCount} recorded check-ins` : 'among recorded check-ins'} help="Counts recorded entries that met each tracker’s configured Success Rule. A saved entry can fail that rule. In All Trackers, matching entries are added across trackers." />
          <AnalyticsStat label="Success rate" value={successRate === null ? '—' : `${successRate}%`} detail={recordedCount ? `${qualifiedCount} of ${recordedCount} recorded entries` : 'no recorded entries'} help="Success Rule matches divided by recorded check-ins. When there are no recorded entries, the rate is undefined. Streak-only dates do not count as successes." />
        </AnalyticsGroup>
        <AnalyticsGroup title="Consistency" className="analytics-summary-consistency">
          <AnalyticsStat label="Consistency" value={consistency === null ? '—' : `${consistency}%`} detail={consistency === null ? 'no scheduled opportunities' : `${qualifiedScheduled} of ${scheduledCount} opportunities`} help="Success Rule matches divided by elapsed eligible opportunities in the selected period. All Trackers adds tracker opportunities, so one date may contribute once per tracker. Standard Mode excludes rest days and holidays; Strict Mode requires every in-period calendar date in the active range. An unlogged today remains open. A streak-only day does not raise consistency." />
          <AnalyticsStat label="Streak-qualified days" value={streakQualifiedCount} detail={`${range} day period`} help="Counts tracker-date opportunities on active trackers that met each tracker’s Streak Rule and scheduling policy. In All Trackers, one calendar date can count once for each qualifying tracker. Archived tracker streak history remains in its tracker details. This is separate from Success Rule matches and success rate." />
          <AnalyticsStat label="Scheduled opportunities" value={scheduledCount} detail={selectedTracker ? 'selected tracker' : 'active trackers only'} help="Counts elapsed eligible tracker-date opportunities in the period. Standard Mode excludes holidays and rest days; Strict Mode requires every calendar day in the tracker’s active date range. An unlogged today is still open. Archived trackers do not contribute." />
        </AnalyticsGroup>
        {progression && <AnalyticsGroup title="XP & rewards" className="analytics-summary-rewards">
          {selectedTracker
            ? <>
              <AnalyticsStat label="Selected tracker XP" value={selectedTrackerXp ?? '—'} detail={`${range} day period · net XP`} help="Includes confirmed and pending rewards in this period with a source linked to the selected tracker. Account-wide rewards and rewards linked to other trackers are outside this value." />
              <AnalyticsStat label="Account XP" value={accountXp ?? '—'} detail={`${range} day period · all account sources`} help="Net XP across all account sources in the selected period, including tracker-attributed, account-wide, older unattributed ledger events, and pending rewards." />
              <AnalyticsStat label="XP outside selected tracker" value={accountXpOutsideSelectedTracker ?? '—'} detail="period account total minus selected tracker" help="Account XP not attributed to the selected tracker. It may include rewards from other trackers, account-wide rewards, and older rewards without reliable tracker attribution." />
              <AnalyticsStat label="Tracker badge awards" value={earnedBadges ?? '—'} detail="active linked awards · all time" help="Counts active achievement unlock occurrences linked to reward events from the selected tracker across all time. Account-wide badges and awards linked to other trackers are not included." />
            </>
            : <>
              <AnalyticsStat label="Account XP" value={accountXp ?? '—'} detail={`${range} day period · all account sources`} help="Net XP across all account sources in the selected period, including tracker-attributed, account-wide, older unattributed ledger events, and pending rewards." />
              <AnalyticsStat label="Tracker-attributed XP" value={trackerAttributedXp ?? '—'} detail={`${range} day period · tracker-linked net XP`} help="Sums confirmed and pending rewards in the selected period whose ledger source identifies a tracker. Account-wide and older unattributed rewards remain outside this value." />
              <AnalyticsStat label="Account-wide & unattributed XP" value={otherAccountXp ?? '—'} detail={`${range} day period · no tracker source`} help="Account XP minus tracker-attributed XP. Includes account-wide rewards and older rewards that do not have reliable tracker attribution; it does not combine rewards with tracker sources." />
              <AnalyticsStat label="Badge types earned" value={earnedBadges ?? '—'} detail="active achievement types · all time" help="Counts distinct achievement types with an active earned award for the account. Repeatable award occurrences do not increase this type count. Badge history and progress are available in Wins." />
            </>}
        </AnalyticsGroup>}
      </div>
      <div className="analytics-context-summary" role="group" aria-label="Period context">
        <span>Holidays <strong>{holidayCount}</strong></span>
        <InfoButton title="Holidays" label="About the holiday count" compact summary="Account-wide marked holidays in this period." description="Marked holidays are account-wide settings. They pause Standard Mode streaks; Strict Mode still requires qualifying activity on those dates." />
        {(hasNoCheckIns || hasNoOpportunities || hasNoMetricObservations && recordedCount === 0) && <p role="status">
          {hasNoCheckIns && hasNoOpportunities
            ? `No check-ins or scheduled opportunities in this period.${hasNoMetricObservations ? ' Metric trends will appear after recorded entries include values.' : ''}`
            : hasNoCheckIns
              ? `No check-ins in this period. An unlogged current day remains open; earlier eligible opportunities are counted after they close.${hasNoMetricObservations ? ' Metric trends will appear after recorded entries include values.' : ''}`
              : hasNoOpportunities ? `No scheduled opportunities for active trackers in this period; consistency is undefined.${hasNoMetricObservations && recordedCount === 0 ? ' No recorded metric values are available for this period.' : ''}` : 'No recorded metric values in this period. Trends appear when recorded entries include values.'}
        </p>}
      </div>
      <div className="analytics-trackers">
        {summaries.map((summary) => <Surface className="analytics-tracker" key={summary.tracker.id}>
          <header className="analytics-tracker-heading"><div><span className="tracker-kind-chip">{summary.tracker.status}</span><h2>{summary.tracker.name}</h2></div></header>
          <dl className="analytics-tracker-stats">
            <div><dt>Recorded</dt><dd>{summary.recordedCount}</dd></div>
            <div><dt>Skipped</dt><dd>{summary.skippedCount}</dd></div>
            <div><dt>Current streak <InfoButton title="Current streak" summary="Consecutive qualifying opportunities up to today." description="Uses only this tracker’s Streak Rule and scheduling policy. Success Rule-only dates do not advance it." compact /></dt><dd>{summary.currentStreak}</dd></div>
            <div><dt>Longest streak <InfoButton title="Longest streak" summary="The longest qualifying run in this tracker’s history." description="The longest run of this tracker’s Streak Rule across its active dates. Historical edits are reflected after local and server reconciliation." compact /></dt><dd>{summary.longestStreak}</dd></div>
            <div><dt>Scheduling</dt><dd>{summary.scheduledCount === null ? 'Inactive for consistency' : summary.scheduledCount === 0 ? 'No elapsed opportunities' : `${summary.scheduledCount} elapsed opportunities`}</dd></div>
            {summary.historicalCount > 0 && <div><dt>Historical entries excluded</dt><dd>{summary.historicalCount}</dd></div>}
          </dl>
          {summary.scheduledCount !== null && summary.consistencyPercent !== null && <p className="analytics-consistency">{summary.scheduledQualifiedCount} of {summary.scheduledCount} scheduled days met the Success Rule · {summary.consistencyPercent}% consistency.</p>}
          {summary.metrics.length > 0 && <div className="analytics-metrics">
            {summary.metrics.map((metricSummary) => {
              const { metric, observations } = metricSummary
              const visibleObservations = observations.slice(-14)
              const maxValue = Math.max(1, ...visibleObservations.map((item) => item.value))
              const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
              const latest = metricSummary.latestValue
              return <section className="analytics-metric" key={metric.id} aria-label={`${metric.name} analysis`}>
                <div className="analytics-metric-heading"><h3>{metric.name}</h3><span>{metricSummary.observationCount} values{metricSummary.averageValue === null ? '' : ` · average ${formatTrackerNumber(metricSummary.averageValue)}${unit}`}</span></div>
                {visibleObservations.length === 0 ? hasNoMetricObservations && recordedCount === 0 ? null : <p className="analytics-empty-metric">No values recorded in this period.</p> : <>
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

function AnalyticsGroup({ title, className, children }: { title: string; className: string; children: ReactNode }) {
  const headingId = useId()
  return <Surface role="group" className={`analytics-summary-group ${className}`} aria-labelledby={headingId}>
    <h2 id={headingId}>{title}</h2>
    <div className="analytics-summary-list">{children}</div>
  </Surface>
}

function AnalyticsStat({ label, value, detail, help }: { label: string; value: number | string; detail: string; help: string }) {
  return <div className="analytics-summary-stat">
    <span className="analytics-summary-label">{label}<InfoButton title={label} summary={detail} description={help} compact /></span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </div>
}
