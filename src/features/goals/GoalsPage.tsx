import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, trackerSectionTabs } from '../../components/ui/SectionTabs'
import { InfoButton } from '../../components/ui/InfoButton'
import { AppIcon } from '../../components/ui/AppIcon'
import { ActivityStatusIcon } from '../../components/ui/ActivityStatusIcon'
import { Surface } from '../../components/ui/Surface'
import { useToast } from '../../components/ui/ToastProvider'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calculateCumulativeMetricPlan, calculateDailyRecurringMetricPlan, evaluateTrackerEntry, isTrackerInActivePeriod, trackerActiveStartDate, type GoalPlanDayState } from '../../domain/trackers/planning'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { formatElapsedMonthsAndDays } from '../../domain/trackers/elapsedProgress'
import { isTrackerSchemaWriteEnabled } from '../../domain/trackers/schemaVersionGate'
import { useAuth } from '../auth/AuthProvider'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { CumulativeAllocationPreview } from './CumulativeAllocationPreview'
import { countScheduledActivityDays, effectiveDayNumber, nextEligibleDate, schedulingMode } from '../../domain/trackers/scheduling'
import { MilestoneProgressList } from '../trackers/MilestoneProgressList'

type GoalCard = { tracker: StoredTrackerDefinition; entries: StoredTrackerEntry[] }
type Snapshot = { workspaceKey: string; goals: GoalCard[]; holidays: string[] }
type GoalProgressSummary = { metricId: string; name: string; value: string; target?: number; remaining?: number; expected?: number; requiredPace?: number | null; paceLabel?: string; percent?: number; unit: string }

export function GoalsPage() {
  const { notify } = useToast()
  const { status: authStatus, user, workspaceStatus, workspaceUserId, sessionTransitionPending, isOnline } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const [today, setToday] = useState(() => localCalendarDate(new Date(), timeZone))
  useEffect(() => {
    const refreshLocalDate = () => {
      const currentDate = localCalendarDate(new Date(), timeZone)
      setToday((previous) => previous === currentDate ? previous : currentDate)
    }
    refreshLocalDate()
    const interval = window.setInterval(refreshLocalDate, 30_000)
    window.addEventListener('focus', refreshLocalDate)
    document.addEventListener('visibilitychange', refreshLocalDate)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshLocalDate)
      document.removeEventListener('visibilitychange', refreshLocalDate)
    }
  }, [timeZone])
  const expectedOwner = authStatus === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && authStatus !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === expectedOwner
  const workspaceKey = workspaceReady ? expectedOwner ?? 'guest' : null
  const workspaceRef = useRef({ key: workspaceKey, ready: workspaceReady })
  workspaceRef.current = { key: workspaceKey, ready: workspaceReady }
  const generationRef = useRef(0)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ workspaceKey: string; message: string } | null>(null)
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(() => new Set())
  const [visitedGoals, setVisitedGoals] = useState<Set<string>>(() => new Set())
  const [goalFilter, setGoalFilter] = useState<'active' | 'completed' | 'all'>('active')
  const goals = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.goals : []
  const holidayDates = useMemo(() => new Set(workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.holidays : []), [workspaceKey, snapshot])
  const visibleError = workspaceKey && error?.workspaceKey === workspaceKey ? error.message : ''
  const hasCurrentSnapshot = Boolean(workspaceKey && snapshot?.workspaceKey === workspaceKey)
  const visibleLoading = !workspaceReady || (loading && !hasCurrentSnapshot) || Boolean(workspaceKey && snapshot?.workspaceKey !== workspaceKey)

  async function moveGoalToBin(tracker: StoredTrackerDefinition) {
    if (!window.confirm(`Move “${tracker.name}” to the Bin? You can restore it for 30 days with its progress and plan.`)) return
    try { await localRepository.deleteTracker(tracker.id); await refresh(); notify({ kind: 'success', title: 'Goal moved to the Bin', description: 'Its progress and plan can be restored for 30 days.', dedupeKey: `tracker:${tracker.id}` }) }
    catch { notify({ kind: 'error', title: 'Couldn’t move goal to the Bin', description: 'Your goal is unchanged. Please try again.', duration: 0, dedupeKey: `tracker:${tracker.id}` }) }
  }

  const refresh = useCallback(async () => {
    const currentWorkspace = workspaceRef.current
    if (!currentWorkspace.ready || !currentWorkspace.key) return
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const trackers = await localRepository.listTrackers(true)
      const goalTrackers = trackers.filter((tracker) => tracker.kind === 'goal' && tracker.deletedAt === null)
      let earliest: CalendarDate = today
      let latest: CalendarDate = today
      let holidayLatest: CalendarDate = shiftCalendarDate(today, 14)
      for (const tracker of goalTrackers) {
        // Fetch from an earlier configured start when present so older saved
        // observations remain available to milestone summaries. Domain plans
        // separately clamp opportunities and progress to the active start.
        const start = trackerActiveStartDate(tracker, timeZone) as CalendarDate
        const trackerToday = localCalendarDate(new Date(), timeZone) as CalendarDate
        if (start < earliest) earliest = start
        if (trackerToday > latest) latest = trackerToday
        const trackerHorizon = (tracker.deadline && tracker.deadline > shiftCalendarDate(trackerToday, 14) ? tracker.deadline : shiftCalendarDate(trackerToday, 14)) as CalendarDate
        if (trackerHorizon > holidayLatest) holidayLatest = trackerHorizon
      }
      const [entries, holidays] = await Promise.all([
        goalTrackers.length ? localRepository.listTrackerEntriesBetween(earliest, latest) : Promise.resolve([]),
        localRepository.listAccountHolidays(earliest, holidayLatest),
      ])
      const goals = goalTrackers.map((tracker) => ({
        tracker,
        entries: entries.filter((entry) => entry.trackerId === tracker.id),
      }))
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setSnapshot({ workspaceKey: currentWorkspace.key, goals, holidays: holidays.map((holiday) => holiday.date) })
      }
    } catch {
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setError({ workspaceKey: currentWorkspace.key, message: 'Your goals could not be loaded from this device.' })
      }
    } finally {
      if (generationRef.current === generation) setLoading(false)
    }
  }, [today, timeZone])

  useEffect(() => {
    if (!workspaceReady || !workspaceKey) {
      setLoading(true)
      return () => { generationRef.current += 1 }
    }
    void refresh()
    return () => { generationRef.current += 1 }
  }, [refresh, workspaceKey, workspaceReady])

  useWorkspaceDataChanges(expectedOwner, workspaceReady, refresh)

  const activeCount = goals.filter(({ tracker }) => tracker.status === 'active').length
  const overdueCount = goals.filter(({ tracker }) => tracker.status === 'active' && Boolean(tracker.deadline && tracker.deadline < today)).length
  const completedCount = goals.filter(({ tracker }) => tracker.status === 'completed').length
  const filteredGoals = goals.filter(({ tracker }) => goalFilter === 'all' || (goalFilter === 'completed' ? tracker.status === 'completed' : tracker.status === 'active'))
  const goalSummaries = useMemo(() => new Map(goals.map(({ tracker, entries }) => [tracker.id, buildGoalProgressSummary(tracker, entries, timeZone, holidayDates)])), [goals, today, timeZone, holidayDates])

  return <section className="tracker-page goals-page" aria-labelledby="goals-title">
    <PageHeader headingId="goals-title" eyebrow="YOUR DIRECTION" title="Goals" description="Keep your longer-term aims and the next useful step in view." action={<Link className="button button-primary button-medium" to="/trackers/new">＋ Create a goal</Link>} />
    <SectionTabs label="Trackers and goals" items={trackerSectionTabs} />
    {visibleError && <div role="alert" className="form-alert">{visibleError}</div>}
    {visibleLoading ? <p role="status" className="tracker-loading">Loading your goals…</p> : visibleError ? <Surface><EmptyState title="Your goals are still saved" description="This device could not open your goal list. Try loading it again." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : goals.length === 0 ? <Surface><EmptyState title="Choose something worth working toward" description="Goals use the same private, offline-first tracker workspace. Add a deadline, measures, and milestones when you create one." action={<Link className="button button-primary button-medium" to="/trackers/new">Create your first goal</Link>} /></Surface> : <>
      <div className="goals-toolbar">
        <div className="goals-filter" role="group" aria-label="Filter goals">
          {([['active', `In progress${activeCount ? ` · ${activeCount}` : ''}`], ['completed', `Completed${completedCount ? ` · ${completedCount}` : ''}`], ['all', `All goals · ${goals.length}`]] as const).map(([filter, label]) => <button key={filter} type="button" className={`goals-filter-option${goalFilter === filter ? ' selected' : ''}`} aria-pressed={goalFilter === filter} onClick={() => setGoalFilter(filter)}>{label}</button>)}
        </div>
        {overdueCount > 0 && <span className="goals-overdue-note">{overdueCount} past deadline</span>}
      </div>
      <div className="tracker-card-grid">
        {filteredGoals.length === 0 ? <Surface className="goals-filter-empty"><p>{goalFilter === 'completed' ? 'Completed goals will appear here.' : 'No goals in progress. Choose one goal to focus on next.'}</p>{goalFilter === 'active' && <Link className="button button-secondary button-small" to="/trackers/new">Create a goal</Link>}</Surface> : filteredGoals.map(({ tracker, entries: goalEntries }) => {
          const planningTimeZone = timeZone
          const planningToday = localCalendarDate(new Date(), planningTimeZone)
          const recorded = goalEntries.filter((entry) => entry.outcome === 'recorded')
          const latest = goalEntries[0]
          const historicalEntryCount = goalEntries.filter((entry) => !isTrackerInActivePeriod(tracker, entry.date, planningTimeZone)).length
          const overdue = tracker.status === 'active' && Boolean(tracker.deadline && tracker.deadline < planningToday)
          const state = overdue ? 'Overdue' : tracker.status === 'completed' ? 'Completed' : tracker.status === 'paused' ? 'Paused' : tracker.status === 'archived' ? 'Archived' : 'In progress'
          const latestInPeriod = Boolean(latest && isTrackerInActivePeriod(tracker, latest.date, planningTimeZone))
          const latestQualified = latestInPeriod && latest?.outcome === 'recorded' && evaluateTrackerEntry(tracker, latest).qualified
          const startDate = trackerActiveStartDate(tracker, planningTimeZone)
          const elapsedEndDate = tracker.deadline && tracker.deadline < planningToday ? tracker.deadline : planningToday
          const elapsedProgress = tracker.deadline && planningToday > startDate ? formatElapsedMonthsAndDays(startDate, elapsedEndDate) : null
          const goalStatusColor = overdue ? 'missed' : tracker.status === 'completed' ? 'completed' : tracker.status === 'active' ? 'pending' : 'neutral'
          const expanded = expandedGoals.has(tracker.id)
          const goalDetailId = `goal-details-${encodeURIComponent(tracker.id)}`
          const summaryMetrics = (goalSummaries.get(tracker.id) ?? []).slice(0, 1)
          const daysRemaining = tracker.deadline ? Math.ceil((Date.parse(`${tracker.deadline}T00:00:00.000Z`) - Date.parse(`${planningToday}T00:00:00.000Z`)) / 86_400_000) : undefined
          const plannedActivityDays = tracker.scheduling?.mode === 'effective' && tracker.deadline ? countScheduledActivityDays({ tracker, startDate, endDate: tracker.deadline, holidays: holidayDates, timeZone: tracker.scheduling.planningTimeZone ?? planningTimeZone }) : 0
          const effectiveDay = tracker.scheduling?.mode === 'effective' ? effectiveDayNumber({ tracker, date: planningToday, holidays: holidayDates, timeZone: tracker.scheduling.planningTimeZone ?? planningTimeZone }) : null
          const nextEffectiveDate = tracker.scheduling?.mode === 'effective' && effectiveDay === null ? nextEligibleDate({ tracker, afterDate: planningToday, holidays: holidayDates, timeZone: tracker.scheduling.planningTimeZone ?? planningTimeZone }) : null
          return <Surface className={`goal-card status-card status-${goalStatusColor}`} key={tracker.id}>
            <button className="goal-card-trigger" type="button" aria-expanded={expanded} aria-controls={goalDetailId} onClick={() => {
              setVisitedGoals((current) => new Set(current).add(tracker.id))
              setExpandedGoals((current) => {
                const next = new Set(current); if (next.has(tracker.id)) next.delete(tracker.id); else next.add(tracker.id); return next
              })
            }}>
              <span className="goal-card-summary-top"><span className={`tracker-kind-chip status-badge ${goalStatusColor}`}>{state}</span>{tracker.deadline && <span className="goal-card-deadline">{overdue ? `${Math.abs(daysRemaining ?? 0)} days overdue` : daysRemaining === 0 ? 'Due today' : (daysRemaining ?? 0) > 0 ? `${daysRemaining} days remaining` : 'Deadline passed'} · {calendarDateLabel(tracker.deadline)}</span>}</span>
              {schedulingMode(tracker) === 'effective' && tracker.scheduling && <span className="goal-card-schedule-day">{effectiveDay !== null ? `Effective Day ${effectiveDay} of ${tracker.scheduling.effectiveDays}` : nextEffectiveDate ? `Paused · next eligible day ${calendarDateLabel(nextEffectiveDate)}` : `Effective day target · ${tracker.scheduling.effectiveDays}`} · {plannedActivityDays} planned workdays</span>}
              <span className="goal-card-summary-name" role="heading" aria-level={2}>{tracker.name}</span>
              {elapsedProgress && <small className="goal-card-elapsed" aria-label={`Elapsed goal period: ${elapsedProgress} completed`}>{elapsedProgress} completed</small>}
              <span className="goal-card-summary-metrics">{summaryMetrics.map((metricSummary) => <span className="goal-card-summary-metric" key={metricSummary.metricId}><span>{metricSummary.name}</span><strong>{metricSummary.value}</strong>{metricSummary.target !== undefined && <><span className="goal-card-progress" role="img" aria-label={`${metricSummary.name}: ${metricSummary.percent ?? 0}% complete`}><i style={{ width: `${metricSummary.percent ?? 0}%` }} /></span>{metricSummary.remaining !== undefined && <small>{formatTrackerNumber(metricSummary.remaining)}{metricSummary.unit} remaining · {Math.round(metricSummary.percent ?? 0)}%</small>}{metricSummary.expected !== undefined && <small>Expected by today {formatTrackerNumber(metricSummary.expected)}{metricSummary.unit}{metricSummary.requiredPace === null ? ' · No Auto days remain' : metricSummary.requiredPace !== undefined ? ` · ${formatTrackerNumber(metricSummary.requiredPace)}${metricSummary.unit}/Auto day` : ''}{metricSummary.paceLabel ? ` · ${metricSummary.paceLabel}` : ''}</small>}</>}</span>)}</span>
              <span className="goal-card-expand-hint">{expanded ? 'Close details' : 'View progress details'} <AppIcon className="goal-card-expand-icon" name="chevron-down" style={{ transform: expanded ? 'rotate(180deg)' : undefined }} /></span>
            </button>
            <div className="goal-card-primary-action"><Link className="button button-primary button-small" to={`/trackers/${encodeURIComponent(tracker.id)}/edit`}>Open plan</Link></div>
            <div className="goal-expanded-details" id={goalDetailId} hidden={!expanded}>
            {visitedGoals.has(tracker.id) && <>
            {tracker.description && <p className="tracker-card-description">{tracker.description}</p>}
            {tracker.metrics.length > 0 && <ul className="goal-metric-list" aria-label={`${tracker.name} measures`}>
              {tracker.metrics.map((metric) => {
                const value = latest?.values[metric.id]
                const target = metric.thresholds?.target
                const valueText = typeof value === 'number' ? `${formatTrackerNumber(value)}${metric.unit ? ` ${metric.unit}` : ''}` : typeof value === 'boolean' ? (value ? 'Done' : 'Not Done') : 'Not recorded yet'
                return <li key={metric.id}><span>{metric.name}</span><strong>{valueText}{target !== undefined ? ` · target ${formatTrackerNumber(target)}${metric.unit ? ` ${metric.unit}` : ''}` : ''}</strong></li>
              })}
            </ul>}
            {tracker.schemaVersion >= 2 && tracker.goalPlanning && <LazyDisclosure className="goal-plan-disclosure" summary="View daily plan"><section className="goal-plan-visualization" aria-label={`${tracker.name} ${tracker.goalPlanning.mode} plan`}>
              <div className="goal-plan-heading"><h3>{tracker.goalPlanning.mode === 'daily-recurring' ? 'Daily plan' : 'Deadline plan'}</h3><InfoButton title={tracker.goalPlanning.mode === 'daily-recurring' ? 'Daily recurring plan' : 'Cumulative deadline plan'} summary={tracker.goalPlanning.mode === 'daily-recurring' ? 'See which scheduled days met the metric target and your consistency over time.' : 'Compare completed progress with the historical benchmark and the current plan.'} description={tracker.goalPlanning.mode === 'daily-recurring' ? 'A day is counted only when it is scheduled. Rest days are neutral. Met, below-target, missed, skipped, rest, and upcoming dates have distinct markers. This plan target is independent of the check-in minimum, target, and stretch thresholds.' : 'Completed is actual saved incremental work. Expected by today uses saved historical Manual or legacy planned values where available; otherwise it uses an even-pace benchmark. Generated Auto suggestions are not saved as history. Remaining is target minus completed. Required Auto pace divides outstanding work by eligible Auto dates after future Manual reservations. Reaching the target does not automatically mark the goal completed.'} /></div>
              {tracker.goalPlanning.mode === 'daily-recurring' ? Object.entries(tracker.goalPlanning.dailyTargets).length === 0
                ? <p>No daily planning targets are configured.</p>
                : <div className="goal-daily-plans">{Object.entries(tracker.goalPlanning.dailyTargets).map(([metricId, target]) => {
                  const metric = tracker.metrics.find((item) => item.id === metricId)
                  if (!metric) return null
                  const plan = calculateDailyRecurringMetricPlan({ tracker, entries: goalEntries, metricId, target, asOfDate: planningToday, startDate, holidays: holidayDates, timeZone: planningTimeZone })
                  const todayEntry = goalEntries.find((entry) => entry.date === planningToday && entry.deletedAt === null)
                  const todayValue = goalMetricValue(metric, todayEntry)
                  const missed = plan.days.filter((day) => day.state === 'missed').length
                  const skipped = plan.days.filter((day) => day.state === 'skipped').length
                  const belowTarget = plan.days.filter((day) => day.state === 'below-target').length
                  return <div className="goal-daily-metric" key={metricId}>
                    <div className="goal-plan-metric-heading"><strong>{metric.name}</strong><span>{formatTrackerNumber(target)}{metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''} per scheduled day</span></div>
                    <dl className="goal-today-plan-summary"><div><dt>Today’s target</dt><dd>{formatTrackerNumber(target)}{metric.unit ? ` ${metric.unit}` : ''}</dd></div><div><dt>Completed today</dt><dd>{formatTrackerNumber(todayValue)}{metric.unit ? ` ${metric.unit}` : ''}</dd></div>{metric.thresholds?.direction !== 'decrease' && <div><dt>Remaining today</dt><dd>{formatTrackerNumber(Math.max(0, target - todayValue))}{metric.unit ? ` ${metric.unit}` : ''}</dd></div>}<div><dt>Scheduled days remaining</dt><dd>{plan.scheduledDaysRemaining}</dd></div></dl>
                    <p>{plan.consistencyPercent === null ? 'No completed scheduled opportunities yet' : `${plan.metCount} of ${plan.elapsedOpportunities} scheduled days met target · ${plan.consistencyPercent}% consistency`}{missed ? ` · ${missed} missed` : ''}{belowTarget ? ` · ${belowTarget} below target` : ''}{skipped ? ` · ${skipped} skipped` : ''} · {plan.scheduledDaysRemaining} scheduled days remaining in this view</p>
                    <GoalPlanDayList days={plan.days} metricName={metric.name} />
                    <div className="goal-plan-legend"><span>Met</span><span>Partial · below target</span><span>Missed</span><span>Skipped</span><span>Rest</span><span>Upcoming</span></div>
                  </div>
                })}</div>
                : Object.entries(tracker.goalPlanning.cumulativeTargets).length === 0
                  ? <p>No cumulative totals are configured.</p>
                  : <div className="goal-cumulative-plans">{Object.entries(tracker.goalPlanning.cumulativeTargets).map(([metricId, totalTarget]) => {
                    const metric = tracker.metrics.find((item) => item.id === metricId)
                    if (!metric || tracker.goalPlanning?.progressSemantics[metricId] !== 'incremental') return null
                    const plan = calculateCumulativeMetricPlan({ tracker, entries: goalEntries, metricId, totalTarget, asOfDate: planningToday, startDate, progressSemantics: 'incremental', holidays: holidayDates, timeZone: planningTimeZone, allocations: tracker.goalPlanning.allocations?.[metricId], manualAllocations: tracker.goalPlanning.manualAllocations?.[metricId] })
                    const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
                    const format = formatTrackerNumber
                    const actualPercent = totalTarget === 0 ? 100 : Math.min(100, plan.actualProgress / totalTarget * 100)
                    return <div className="goal-cumulative-metric" key={metricId}>
                      <div className="goal-plan-metric-heading"><strong>{metric.name}</strong><span>{format(totalTarget)}{unit} total</span></div>
                      <div className="goal-plan-bars" role="img" aria-label={`${metric.name}: ${format(plan.actualProgress)}${unit} completed of ${format(totalTarget)}${unit}; expected ${format(plan.expectedProgress)}${unit} by today`}>
                        <div><span>Progress</span><div className="goal-plan-bar"><i className="actual" style={{ width: `${actualPercent}%` }} /></div></div>
                      </div>
                      <dl className="goal-plan-facts"><div><dt>Completed</dt><dd>{format(plan.actualProgress)}{unit}</dd></div><div><dt>Expected by today</dt><dd>{format(plan.expectedProgress)}{unit}</dd></div><div><dt>Remaining</dt><dd>{format(plan.remainingWork)}{unit}</dd></div><div><dt>Required pace</dt><dd>{plan.requiredDailyPace === null ? 'No automatic days remain' : `${format(plan.requiredDailyPace)}${unit} / automatic day`}</dd></div></dl>
                      <p className={`goal-plan-status ${plan.paceStatus}`}>{plan.remainingWork === 0 && tracker.status === 'active' ? 'Target reached · goal still active' : cumulativeStatusLabel(plan.status, plan.paceStatus)} · {plan.scheduledDaysRemaining} scheduled days remain</p>
                      {tracker.status === 'active' && <CumulativeAllocationPreview
                        tracker={tracker} entries={goalEntries} metricId={metricId} startDate={startDate} asOfDate={planningToday} timeZone={planningTimeZone}
                        manualPlanWritesEnabled={isTrackerSchemaWriteEnabled(tracker.schemaVersion >= 7 ? 7 : tracker.schemaVersion >= 6 ? 6 : tracker.schemaVersion === 5 ? 5 : tracker.schemaVersion === 4 || metric.precision ? 4 : 3)} holidays={holidayDates} isOnline={isOnline} signedIn={authStatus === 'signed-in'}
                        onSave={async (updated) => { await localRepository.saveTracker(updated); await refresh(); notify({ kind: 'success', title: 'Daily plan saved', description: 'Your saved allocations were updated on this device.', dedupeKey: `plan:${tracker.id}:${metricId}` }) }}
                      />}
                    </div>
                  })}</div>}
            </section></LazyDisclosure>}
            {tracker.milestones.length > 0 && <details className="goal-milestone-disclosure"><summary>Milestones <span>{tracker.milestones.length}</span></summary><MilestoneProgressList tracker={tracker} entries={goalEntries} asOfDate={planningToday} holidays={holidayDates} timeZone={timeZone} showRewardEligibilityNote /></details>}
            <LazyDisclosure className="goal-history-disclosure" summary="History and activity"><div className="goal-card-summary">
              <span>{recorded.length} recorded {recorded.length === 1 ? 'check-in' : 'check-ins'}{historicalEntryCount ? ` · ${historicalEntryCount} outside current period` : ''}</span>
              <span>{latest ? `${latestInPeriod ? latestQualified ? 'Latest check-in met its rule · ' : 'Latest check-in · ' : 'Latest historical check-in · '}${calendarDateLabel(latest.date)}` : 'No check-ins yet'}</span>
            </div></LazyDisclosure>
            <div className="tracker-card-actions">
              <Link className="button button-secondary button-small" to={`/trackers/${encodeURIComponent(tracker.id)}/edit`}>Edit goal</Link>
              <Link className="button button-quiet button-small" to="/history">View history</Link>
              <Button variant="destructive" size="small" onClick={() => void moveGoalToBin(tracker)}>Delete goal</Button>
            </div>
            </>}
            </div>
          </Surface>
        })}
      </div>
    </>}
  </section>
}

function buildGoalProgressSummary(
  tracker: StoredTrackerDefinition,
  entries: readonly StoredTrackerEntry[],
  fallbackTimeZone: string,
  holidays: ReadonlySet<string>,
): GoalProgressSummary[] {
  const planningTimeZone = fallbackTimeZone
  const asOfDate = localCalendarDate(new Date(), planningTimeZone)
  const startDate = trackerActiveStartDate(tracker, planningTimeZone)
  const cumulativeTargets = tracker.goalPlanning?.mode === 'cumulative-deadline' ? tracker.goalPlanning.cumulativeTargets : {}
  const latestRecorded = entries.find((entry) => entry.outcome === 'recorded')
  return tracker.metrics.map((metric) => {
    const target = cumulativeTargets[metric.id]
    if (target !== undefined && tracker.goalPlanning?.progressSemantics[metric.id] === 'incremental') {
      const plan = calculateCumulativeMetricPlan({ tracker, entries, metricId: metric.id, totalTarget: target, asOfDate, startDate, progressSemantics: 'incremental', holidays, timeZone: planningTimeZone, allocations: tracker.goalPlanning.allocations?.[metric.id], manualAllocations: tracker.goalPlanning.manualAllocations?.[metric.id] })
      const percent = target === 0 ? 100 : Math.min(100, Math.max(0, plan.actualProgress / target * 100))
      const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
      const paceLabel = plan.remainingWork === 0 ? 'Target reached' : cumulativeStatusLabel(plan.status, plan.paceStatus)
      return { metricId: metric.id, name: metric.name, value: `${formatTrackerNumber(plan.actualProgress)} / ${formatTrackerNumber(target)}${unit}`, target, remaining: plan.remainingWork, expected: plan.expectedProgress, requiredPace: plan.requiredDailyPace, paceLabel, percent, unit }
    }
    const value = latestRecorded?.values[metric.id]
    const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
    const valueText = typeof value === 'number' ? `${formatTrackerNumber(value)}${unit}` : typeof value === 'boolean' ? (value ? 'Done' : 'Not Done') : value && typeof value === 'object' ? `${Object.values(value).filter((item) => item).length} items` : 'No progress recorded'
    const threshold = metric.thresholds?.target
    return { metricId: metric.id, name: metric.name, value: `${valueText}${threshold === undefined ? '' : ` · target threshold ${formatTrackerNumber(threshold)}${unit}`}`, unit }
  })
}

function goalMetricValue(metric: StoredTrackerDefinition['metrics'][number], entry: StoredTrackerEntry | undefined): number {
  if (!entry || entry.outcome !== 'recorded') return 0
  const value = entry.values[metric.id]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object' && value !== null) return Object.values(value).filter(Boolean).length
  return 0
}

function cumulativeStatusLabel(status: string, paceStatus: string): string {
  if (status === 'not-started') return 'Not started'
  if (status === 'completed') return 'Target complete'
  if (status === 'overdue') return 'Overdue'
  if (status === 'no-scheduled-days') return 'No scheduled work days'
  return paceStatus === 'ahead' ? 'Ahead of expected progress' : paceStatus === 'on-track' ? 'On track' : 'Behind expected progress'
}

function goalDayStatusLabel(status: string): string {
  if (status === 'met') return 'Met'
  if (status === 'below-target') return 'Partial'
  if (status === 'missed') return 'Missed'
  if (status === 'holiday') return 'Holiday'
  if (status === 'rest') return 'Rest day'
  if (status === 'pending') return 'Pending'
  if (status === 'future') return 'Upcoming'
  if (status === 'skipped') return 'Skipped · intentionally saved'
  return status
}

function LazyDisclosure({ className, summary, children }: { className: string; summary: string; children: ReactNode }) {
  const [visited, setVisited] = useState(false)
  const [open, setOpen] = useState(false)
  const contentId = useId()
  return <details className={className} onToggle={(event) => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setVisited(true) }}>
    <summary aria-expanded={open} aria-controls={visited ? contentId : undefined}>{open ? `Hide ${summary.replace(/^View /, '').toLowerCase()}` : summary}</summary>
    {visited && <div className="goal-disclosure-content" id={contentId}>{children}</div>}
  </details>
}

function GoalPlanDayList({ days, metricName }: { days: ReturnType<typeof calculateDailyRecurringMetricPlan>['days']; metricName: string }) {
  const [pageStart, setPageStart] = useState(() => Math.max(0, days.length - 14))
  useEffect(() => setPageStart((current) => Math.min(current, Math.max(0, days.length - 14))), [days.length])
  const pageDays = days.slice(pageStart, pageStart + 14)
  return <>
    {days.length > 14 && <nav className="allocation-page-controls" aria-label={`${metricName} daily history pages`}><button className="button button-secondary button-small" type="button" disabled={pageStart === 0} onClick={() => setPageStart((current) => Math.max(0, current - 14))}>Earlier dates</button><span>Dates {pageStart + 1}–{Math.min(days.length, pageStart + pageDays.length)} of {days.length}</span><button className="button button-secondary button-small" type="button" disabled={pageStart + pageDays.length >= days.length} onClick={() => setPageStart((current) => Math.min(days.length - 14, current + 14))}>Later dates</button></nav>}
    <ol className="goal-plan-days">{pageDays.map((day) => {
      const status = goalPlanActivityStatus(day.state)
      const statusClass = status === 'completed' ? 'completed' : status === 'partial' ? 'partial' : status === 'unscheduled' ? 'rest' : status
      return <li key={day.date} className={`goal-plan-day ${statusClass}`} aria-label={`${calendarDateLabel(day.date, { month: 'short', day: 'numeric' })}: ${goalDayStatusLabel(day.state)}${day.value === null ? '' : `, ${formatTrackerNumber(day.value)}`}`} title={`${calendarDateLabel(day.date)} · ${goalDayStatusLabel(day.state)}`}><span>{Number(day.date.slice(8, 10))}</span><ActivityStatusIcon status={status} /></li>
    })}</ol>
  </>
}

function goalPlanActivityStatus(state: GoalPlanDayState) {
  if (state === 'met') return 'completed'
  if (state === 'below-target') return 'partial'
  if (state === 'holiday') return 'holiday'
  if (state === 'rest') return 'unscheduled'
  if (state === 'future') return 'upcoming'
  if (state === 'pending') return 'pending'
  if (state === 'skipped') return 'skipped'
  return state
}
