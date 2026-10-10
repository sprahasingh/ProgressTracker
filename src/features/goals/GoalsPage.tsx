import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, trackerSectionTabs } from '../../components/ui/SectionTabs'
import { InfoButton } from '../../components/ui/InfoButton'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calculateCumulativeMetricPlan, calculateDailyRecurringMetricPlan, evaluateTrackerEntry } from '../../domain/trackers/planning'
import { createCumulativeAllocationPreview } from '../../domain/trackers/allocationPreview'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { isTrackerSchemaWriteEnabled } from '../../domain/trackers/schemaVersionGate'
import { useAuth } from '../auth/AuthProvider'
import { calendarDateLabel, localCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { CumulativeAllocationPreview } from './CumulativeAllocationPreview'

type GoalCard = { tracker: StoredTrackerDefinition; entries: StoredTrackerEntry[] }
type Snapshot = { workspaceKey: string; goals: GoalCard[]; holidays: string[] }
type GoalProgressSummary = { metricId: string; name: string; value: string; target?: number; remaining?: number; percent?: number; unit: string }

export function GoalsPage() {
  const { status: authStatus, user, workspaceStatus, workspaceUserId, sessionTransitionPending } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
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
  const goals = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.goals : []
  const holidayDates = useMemo(() => new Set(workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.holidays : []), [workspaceKey, snapshot])
  const visibleError = workspaceKey && error?.workspaceKey === workspaceKey ? error.message : ''
  const hasCurrentSnapshot = Boolean(workspaceKey && snapshot?.workspaceKey === workspaceKey)
  const visibleLoading = !workspaceReady || (loading && !hasCurrentSnapshot) || Boolean(workspaceKey && snapshot?.workspaceKey !== workspaceKey)

  async function moveGoalToBin(tracker: StoredTrackerDefinition) {
    if (!window.confirm(`Move “${tracker.name}” to the Bin? You can restore it for 30 days with its progress and plan.`)) return
    try { await localRepository.deleteTracker(tracker.id); await refresh() }
    catch { if (workspaceKey) setError({ workspaceKey, message: 'This goal could not be moved to the Bin. Your saved data is unchanged.' }) }
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
      for (const tracker of goalTrackers) {
        const trackerZone = tracker.schemaVersion >= 3 ? tracker.goalPlanning?.planningTimeZone ?? timeZone : timeZone
        const start = (tracker.startDate ?? localCalendarDate(new Date(tracker.createdAt), trackerZone)) as CalendarDate
        const trackerToday = localCalendarDate(new Date(), trackerZone) as CalendarDate
        if (start < earliest) earliest = start
        if (trackerToday > latest) latest = trackerToday
      }
      const [entries, holidays] = await Promise.all([
        goalTrackers.length ? localRepository.listTrackerEntriesBetween(earliest, latest) : Promise.resolve([]),
        localRepository.listAccountHolidays(earliest, latest),
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

  const activeCount = goals.filter(({ tracker }) => tracker.status === 'active' && (!tracker.deadline || tracker.deadline >= today)).length
  const overdueCount = goals.filter(({ tracker }) => tracker.status === 'active' && Boolean(tracker.deadline && tracker.deadline < today)).length
  const completedCount = goals.filter(({ tracker }) => tracker.status === 'completed').length
  const goalSummaries = useMemo(() => new Map(goals.map(({ tracker, entries }) => [tracker.id, buildGoalProgressSummary(tracker, entries, timeZone, holidayDates)])), [goals, today, timeZone, holidayDates])

  return <section className="tracker-page goals-page" aria-labelledby="goals-title">
    <PageHeader headingId="goals-title" eyebrow="YOUR DIRECTION" title="Goals" description="Keep your longer-term aims and the next useful step in view." action={<Link className="button button-primary button-medium" to="/trackers/new">＋ Create a goal</Link>} />
    <SectionTabs label="Trackers and goals" items={trackerSectionTabs} />
    {visibleError && <div role="alert" className="form-alert">{visibleError}</div>}
    {visibleLoading ? <p role="status" className="tracker-loading">Loading your goals…</p> : visibleError ? <Surface><EmptyState title="Your goals are still saved" description="This device could not open your goal list. Try loading it again." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : goals.length === 0 ? <Surface><EmptyState title="Choose something worth working toward" description="Goals use the same private, offline-first tracker workspace. Add a deadline, measures, and milestones when you create one." action={<Link className="button button-primary button-medium" to="/trackers/new">Create your first goal</Link>} /></Surface> : <>
      <div className="dashboard-stats" role="group" aria-label="Goal summary">
        <GoalStat label="In progress" value={activeCount} detail="active and within deadline" help="Counts active goals whose deadline is today or later, plus active goals without a deadline." />
        <GoalStat label="Overdue" value={overdueCount} detail="active goals past their deadline" help="Counts active goals whose deadline is before today in the goal’s planning time zone." />
        <GoalStat label="Completed" value={completedCount} detail="goals you have finished" help="Counts goals whose status is completed. Their history remains available." />
        <GoalStat label="All goals" value={goals.length} detail="including paused and archived goals" help="Counts every goal in this workspace, including paused and archived goals, but not Bin items." />
      </div>
      <div className="tracker-card-grid">
        {goals.map(({ tracker, entries: goalEntries }) => {
          const planningTimeZone = tracker.schemaVersion >= 3 ? tracker.goalPlanning?.planningTimeZone ?? timeZone : timeZone
          const planningToday = localCalendarDate(new Date(), planningTimeZone)
          const recorded = goalEntries.filter((entry) => entry.outcome === 'recorded')
          const latest = goalEntries[0]
          const overdue = tracker.status === 'active' && Boolean(tracker.deadline && tracker.deadline < planningToday)
          const state = overdue ? 'Overdue' : tracker.status === 'completed' ? 'Completed' : tracker.status === 'paused' ? 'Paused' : tracker.status === 'archived' ? 'Archived' : 'In progress'
          const latestQualified = latest?.outcome === 'recorded' && evaluateTrackerEntry(tracker, latest).qualified
          const startDate = tracker.startDate ?? localCalendarDate(new Date(tracker.createdAt), planningTimeZone)
          const entriesRevision = goalEntries.reduce((latestRevision, entry) => entry.updatedAt > latestRevision ? entry.updatedAt : latestRevision, '')
          const goalStatusColor = overdue ? 'missed' : tracker.status === 'completed' ? 'completed' : tracker.status === 'active' ? 'pending' : 'neutral'
          const expanded = expandedGoals.has(tracker.id)
          const goalDetailId = `goal-details-${encodeURIComponent(tracker.id)}`
          const summaryMetrics = goalSummaries.get(tracker.id) ?? []
          const daysRemaining = tracker.deadline ? Math.ceil((Date.parse(`${tracker.deadline}T00:00:00.000Z`) - Date.parse(`${planningToday}T00:00:00.000Z`)) / 86_400_000) : undefined
          return <Surface className={`goal-card status-card status-${goalStatusColor}`} key={tracker.id}>
            <button className="goal-card-trigger" type="button" aria-expanded={expanded} aria-controls={goalDetailId} onClick={() => {
              setVisitedGoals((current) => new Set(current).add(tracker.id))
              setExpandedGoals((current) => {
                const next = new Set(current); if (next.has(tracker.id)) next.delete(tracker.id); else next.add(tracker.id); return next
              })
            }}>
              <span className="goal-card-summary-top"><span className={`tracker-kind-chip status-badge ${goalStatusColor}`}>{state}</span>{tracker.deadline && <span className="goal-card-deadline">{overdue ? `${Math.abs(daysRemaining ?? 0)} days overdue` : daysRemaining === 0 ? 'Due today' : (daysRemaining ?? 0) > 0 ? `${daysRemaining} days remaining` : 'Deadline passed'} · {calendarDateLabel(tracker.deadline)}</span>}</span>
              <span className="goal-card-summary-name" role="heading" aria-level={2}>{tracker.name}</span>
              <span className="goal-card-summary-metrics">{summaryMetrics.map((metricSummary) => <span className="goal-card-summary-metric" key={metricSummary.metricId}><span>{metricSummary.name}</span><strong>{metricSummary.value}</strong>{metricSummary.target !== undefined && <><span className="goal-card-progress" role="img" aria-label={`${metricSummary.name}: ${metricSummary.percent ?? 0}% complete`}><i style={{ width: `${metricSummary.percent ?? 0}%` }} /></span>{metricSummary.remaining !== undefined && <small>{formatTrackerNumber(metricSummary.remaining)}{metricSummary.unit} remaining · {Math.round(metricSummary.percent ?? 0)}%</small>}</>}</span>)}</span>
              <span className="goal-card-expand-hint">{expanded ? 'Hide details' : 'View goal details'} <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></span>
            </button>
            <div className="goal-expanded-details" id={goalDetailId} hidden={!expanded}>
            {visitedGoals.has(tracker.id) && <>
            {tracker.description && <p className="tracker-card-description">{tracker.description}</p>}
            {tracker.metrics.length > 0 && <ul className="goal-metric-list" aria-label={`${tracker.name} measures`}>
              {tracker.metrics.map((metric) => {
                const value = latest?.values[metric.id]
                const target = metric.thresholds?.target
                const valueText = typeof value === 'number' ? `${formatTrackerNumber(value)}${metric.unit ? ` ${metric.unit}` : ''}` : typeof value === 'boolean' ? (value ? 'Done' : 'Not done') : 'Not recorded yet'
                return <li key={metric.id}><span>{metric.name}</span><strong>{valueText}{target !== undefined ? ` · target ${formatTrackerNumber(target)}${metric.unit ? ` ${metric.unit}` : ''}` : ''}</strong></li>
              })}
            </ul>}
            {tracker.schemaVersion >= 2 && tracker.goalPlanning && <LazyDisclosure className="goal-plan-disclosure" summary="View daily plan"><section className="goal-plan-visualization" aria-label={`${tracker.name} ${tracker.goalPlanning.mode} plan`}>
              <div className="goal-plan-heading"><h3>{tracker.goalPlanning.mode === 'daily-recurring' ? 'Daily plan' : 'Deadline plan'}</h3><InfoButton title={tracker.goalPlanning.mode === 'daily-recurring' ? 'Daily recurring plan' : 'Cumulative deadline plan'} summary={tracker.goalPlanning.mode === 'daily-recurring' ? 'See which scheduled days met the metric target and your consistency over time.' : 'Compare actual progress with expected progress and the pace needed to reach the total.'} description={tracker.goalPlanning.mode === 'daily-recurring' ? 'A day is counted only when it is scheduled. Rest days are neutral. Met, below-target, skipped, missed, rest, and upcoming dates have distinct markers. This plan target is independent of the check-in minimum, target, and stretch thresholds.' : 'Actual progress sums only saved entries whose metric is configured as incremental; snapshots are not added. Expected progress follows scheduled dates and the deadline. Remaining is the target minus actual progress, and required pace divides remaining work across remaining scheduled days. Each metric is calculated separately in its own unit.'} /></div>
              {tracker.goalPlanning.mode === 'daily-recurring' ? Object.entries(tracker.goalPlanning.dailyTargets).length === 0
                ? <p>No daily planning targets are configured.</p>
                : <div className="goal-daily-plans">{Object.entries(tracker.goalPlanning.dailyTargets).map(([metricId, target]) => {
                  const metric = tracker.metrics.find((item) => item.id === metricId)
                  if (!metric) return null
                  const plan = calculateDailyRecurringMetricPlan({ tracker, entries: goalEntries, metricId, target, asOfDate: planningToday, startDate, holidays: holidayDates })
                  const todayEntry = goalEntries.find((entry) => entry.date === planningToday && entry.deletedAt === null)
                  const todayValue = goalMetricValue(metric, todayEntry)
                  const missed = plan.days.filter((day) => ['missed', 'skipped', 'below-target'].includes(day.state)).length
                  return <div className="goal-daily-metric" key={metricId}>
                    <div className="goal-plan-metric-heading"><strong>{metric.name}</strong><span>{formatTrackerNumber(target)}{metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''} per scheduled day</span></div>
                    <dl className="goal-today-plan-summary"><div><dt>Today’s target</dt><dd>{formatTrackerNumber(target)}{metric.unit ? ` ${metric.unit}` : ''}</dd></div><div><dt>Completed today</dt><dd>{formatTrackerNumber(todayValue)}{metric.unit ? ` ${metric.unit}` : ''}</dd></div>{metric.thresholds?.direction !== 'decrease' && <div><dt>Remaining today</dt><dd>{formatTrackerNumber(Math.max(0, target - todayValue))}{metric.unit ? ` ${metric.unit}` : ''}</dd></div>}<div><dt>Scheduled days remaining</dt><dd>{plan.scheduledDaysRemaining}</dd></div></dl>
                    <p>{plan.consistencyPercent === null ? 'No completed scheduled opportunities yet' : `${plan.metCount} of ${plan.elapsedOpportunities} scheduled days met target · ${plan.consistencyPercent}% consistency`}{missed ? ` · ${missed} missed or below target` : ''} · {plan.scheduledDaysRemaining} scheduled days remaining in this view</p>
                    <GoalPlanDayList days={plan.days} metricName={metric.name} />
                    <div className="goal-plan-legend"><span>Met</span><span>Below / missed</span><span>Rest</span><span>Upcoming</span></div>
                  </div>
                })}</div>
                : Object.entries(tracker.goalPlanning.cumulativeTargets).length === 0
                  ? <p>No cumulative totals are configured.</p>
                  : <div className="goal-cumulative-plans">{Object.entries(tracker.goalPlanning.cumulativeTargets).map(([metricId, totalTarget]) => {
                    const metric = tracker.metrics.find((item) => item.id === metricId)
                    if (!metric || tracker.goalPlanning?.progressSemantics[metricId] !== 'incremental') return null
                    const plan = calculateCumulativeMetricPlan({ tracker, entries: goalEntries, metricId, totalTarget, asOfDate: planningToday, startDate, progressSemantics: 'incremental', holidays: holidayDates })
                    const todayPreview = createCumulativeAllocationPreview({ tracker, entries: goalEntries, metricId, totalTarget, startDate, asOfDate: planningToday, holidays: holidayDates })
                    const todaySuggestion = todayPreview.days.find((day) => day.date === planningToday && day.eligible)?.amount
                    const todaySaved = tracker.goalPlanning?.allocations?.[metricId]?.[planningToday]
                    const todayValue = goalMetricValue(metric, goalEntries.find((entry) => entry.date === planningToday && entry.deletedAt === null))
                    const todaysAllocation = todaySaved ?? todaySuggestion
                    const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
                    const format = formatTrackerNumber
                    const actualPercent = totalTarget === 0 ? 100 : Math.min(100, plan.actualProgress / totalTarget * 100)
                    const expectedPercent = totalTarget === 0 ? 100 : Math.min(100, plan.expectedProgress / totalTarget * 100)
                    return <div className="goal-cumulative-metric" key={metricId}>
                      <div className="goal-plan-metric-heading"><strong>{metric.name}</strong><span>{format(totalTarget)}{unit} total</span></div>
                      <div className="goal-plan-bars" role="img" aria-label={`${metric.name}: actual ${format(plan.actualProgress)}${unit} of ${format(totalTarget)}${unit}; expected ${format(plan.expectedProgress)}${unit}`}>
                        <div><span>Actual</span><div className="goal-plan-bar"><i className="actual" style={{ width: `${actualPercent}%` }} /></div></div>
                        <div><span>Expected by today</span><div className="goal-plan-bar"><i className="expected" style={{ width: `${expectedPercent}%` }} /></div></div>
                      </div>
                      <dl className="goal-plan-facts"><div><dt>Actual progress</dt><dd>{format(plan.actualProgress)}{unit}</dd></div><div><dt>Expected progress</dt><dd>{format(plan.expectedProgress)}{unit}</dd></div><div><dt>Remaining</dt><dd>{format(plan.remainingWork)}{unit}</dd></div><div><dt>Required pace</dt><dd>{plan.requiredDailyPace === null ? 'No scheduled days remain' : `${format(plan.requiredDailyPace)}${unit} / scheduled day`}</dd></div></dl>
                      <dl className="goal-today-plan-summary"><div><dt>{todaySaved === undefined ? 'Suggested allocation today' : 'Saved allocation today'}</dt><dd>{todaysAllocation == null ? 'No scheduled allocation' : `${format(todaysAllocation)}${unit}`}</dd></div><div><dt>Completed today</dt><dd>{format(todayValue)}{unit}</dd></div>{todaysAllocation != null && <div><dt>Remaining today</dt><dd>{format(Math.max(0, todaysAllocation - todayValue))}{unit}</dd></div>}<div><dt>Scheduled days remaining</dt><dd>{plan.scheduledDaysRemaining}</dd></div></dl>
                      <p className={`goal-plan-status ${plan.paceStatus}`}>{cumulativeStatusLabel(plan.status, plan.paceStatus)} · {plan.scheduledDaysRemaining} scheduled days remain</p>
                      {tracker.status === 'active' && <CumulativeAllocationPreview
                        key={`${tracker.id}:${metricId}:${planningToday}:${plan.actualProgress}:${tracker.updatedAt}:${entriesRevision}`}
                        tracker={tracker} entries={goalEntries} metricId={metricId} startDate={startDate} asOfDate={planningToday} timeZone={planningTimeZone}
                        v3WritesEnabled={isTrackerSchemaWriteEnabled(tracker.schemaVersion === 4 || metric.precision ? 4 : 3)} holidays={holidayDates}
                        onSave={async (updated) => { await localRepository.saveTracker(updated); await refresh() }}
                      />}
                    </div>
                  })}</div>}
            </section></LazyDisclosure>}
            {tracker.milestones.length > 0 && <details className="goal-milestone-disclosure"><summary>Milestones <span>{tracker.milestones.length}</span></summary><section className="goal-milestones" aria-label={`${tracker.name} milestones`}>
              <ul>
                {tracker.milestones.map((milestone) => {
                  const metric = tracker.metrics.find((item) => item.id === milestone.metricId)
                  const observed = metric && milestone.targetValue !== undefined
                    ? goalEntries.flatMap((entry) => {
                      const value = entry.values[metric.id]
                      return entry.outcome === 'recorded' && typeof value === 'number' ? [value] : []
                    })
                    : []
                  const bestValue = observed.length === 0 ? undefined : metric?.thresholds?.direction === 'decrease'
                    ? observed.reduce((best, value) => Math.min(best, value), Number.POSITIVE_INFINITY)
                    : observed.reduce((best, value) => Math.max(best, value), Number.NEGATIVE_INFINITY)
                  const reached = bestValue !== undefined && milestone.targetValue !== undefined &&
                    (metric?.thresholds?.direction === 'decrease' ? bestValue <= milestone.targetValue : bestValue >= milestone.targetValue)
                  const checkpoint = bestValue === undefined ? 'Not started' : `${formatTrackerNumber(bestValue)}${metric?.unit ? ` ${metric.unit}` : ''} of ${milestone.targetValue === undefined ? 'target' : formatTrackerNumber(milestone.targetValue)}`
                  const due = milestone.dueDate ? ` · Due ${calendarDateLabel(milestone.dueDate)}` : ''
                  return <li key={milestone.id}>
                    <span className={`goal-milestone-marker${reached ? ' reached' : ''}`} aria-hidden="true">{reached ? '✓' : '○'}</span>
                    <div><strong>{milestone.title || 'Untitled milestone'}</strong>{milestone.description && <small>{milestone.description}</small>}<small>{reached ? `Reached · best ${checkpoint}` : `${checkpoint}${due}`}</small></div>
                  </li>
                })}
              </ul>
            </section></details>}
            <details className="goal-history-disclosure"><summary>History and activity</summary><div className="goal-card-summary">
              <span>{recorded.length} recorded {recorded.length === 1 ? 'check-in' : 'check-ins'}</span>
              <span>{latest ? `${latestQualified ? 'Latest check-in met its rule · ' : 'Latest check-in · '}${calendarDateLabel(latest.date)}` : 'No check-ins yet'}</span>
            </div></details>
            <div className="tracker-card-actions">
              <Link className="button button-secondary button-small" to={`/trackers/${encodeURIComponent(tracker.id)}/edit`}>Edit goal</Link>
              <Link className="button button-quiet button-small" to="/history">View history</Link>
              <Button variant="destructive" size="small" onClick={() => void moveGoalToBin(tracker)}>Delete</Button>
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
  const planningTimeZone = tracker.schemaVersion >= 3 ? tracker.goalPlanning?.planningTimeZone ?? fallbackTimeZone : fallbackTimeZone
  const asOfDate = localCalendarDate(new Date(), planningTimeZone)
  const startDate = tracker.startDate ?? localCalendarDate(new Date(tracker.createdAt), planningTimeZone)
  const cumulativeTargets = tracker.goalPlanning?.mode === 'cumulative-deadline' ? tracker.goalPlanning.cumulativeTargets : {}
  const latestRecorded = entries.find((entry) => entry.outcome === 'recorded')
  return tracker.metrics.map((metric) => {
    const target = cumulativeTargets[metric.id]
    if (target !== undefined && tracker.goalPlanning?.progressSemantics[metric.id] === 'incremental') {
      const plan = calculateCumulativeMetricPlan({ tracker, entries, metricId: metric.id, totalTarget: target, asOfDate, startDate, progressSemantics: 'incremental', holidays })
      const percent = target === 0 ? 100 : Math.min(100, Math.max(0, plan.actualProgress / target * 100))
      const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
      return { metricId: metric.id, name: metric.name, value: `${formatTrackerNumber(plan.actualProgress)} / ${formatTrackerNumber(target)}${unit}`, target, remaining: plan.remainingWork, percent, unit }
    }
    const value = latestRecorded?.values[metric.id]
    const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
    const valueText = typeof value === 'number' ? `${formatTrackerNumber(value)}${unit}` : typeof value === 'boolean' ? (value ? 'Complete' : 'Not complete') : value && typeof value === 'object' ? `${Object.values(value).filter((item) => item).length} items` : 'No progress recorded'
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
  if (status === 'met') return 'completed'
  if (status === 'below-target') return 'partially completed'
  if (status === 'missed') return 'missed'
  if (status === 'holiday') return 'holiday'
  if (status === 'rest') return 'rest day'
  if (status === 'pending' || status === 'future') return 'pending'
  return 'skipped; no miss counted'
}

function GoalStat({ label, value, detail, help }: { label: string; value: number; detail: string; help: string }) {
  return <Surface className="dashboard-stat"><span className="dashboard-stat-label">{label}<InfoButton title={label} summary={detail} description={help} /></span><strong>{value}</strong><small>{detail}</small></Surface>
}

function LazyDisclosure({ className, summary, children }: { className: string; summary: string; children: ReactNode }) {
  const [visited, setVisited] = useState(false)
  return <details className={className} onToggle={(event) => { if (event.currentTarget.open) setVisited(true) }}>
    <summary>{summary}</summary>
    {visited && <div className="goal-disclosure-content">{children}</div>}
  </details>
}

function GoalPlanDayList({ days, metricName }: { days: ReturnType<typeof calculateDailyRecurringMetricPlan>['days']; metricName: string }) {
  const [pageStart, setPageStart] = useState(() => Math.max(0, days.length - 14))
  useEffect(() => setPageStart((current) => Math.min(current, Math.max(0, days.length - 14))), [days.length])
  const pageDays = days.slice(pageStart, pageStart + 14)
  return <>
    {days.length > 14 && <nav className="allocation-page-controls" aria-label={`${metricName} daily history pages`}><button className="button button-secondary button-small" type="button" disabled={pageStart === 0} onClick={() => setPageStart((current) => Math.max(0, current - 14))}>Earlier dates</button><span>Dates {pageStart + 1}–{Math.min(days.length, pageStart + pageDays.length)} of {days.length}</span><button className="button button-secondary button-small" type="button" disabled={pageStart + pageDays.length >= days.length} onClick={() => setPageStart((current) => Math.min(days.length - 14, current + 14))}>Later dates</button></nav>}
    <ol className="goal-plan-days">{pageDays.map((day) => <li key={day.date} className={`goal-plan-day ${day.state === 'met' ? 'completed' : day.state === 'below-target' ? 'partial' : day.state === 'missed' ? 'missed' : day.state === 'holiday' || day.state === 'rest' ? 'holiday' : day.state === 'pending' || day.state === 'future' ? 'pending' : 'skipped'}`} aria-label={`${calendarDateLabel(day.date, { month: 'short', day: 'numeric' })}: ${goalDayStatusLabel(day.state)}${day.value === null ? '' : `, ${formatTrackerNumber(day.value)}`}`} title={`${calendarDateLabel(day.date)} · ${goalDayStatusLabel(day.state)}`}><span>{Number(day.date.slice(8, 10))}</span></li>)}</ol>
  </>
}
