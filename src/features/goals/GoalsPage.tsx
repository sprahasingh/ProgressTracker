import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry } from '../../domain/trackers/planning'
import { useAuth } from '../auth/AuthProvider'
import { calendarDateLabel, localCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'

type GoalCard = { tracker: StoredTrackerDefinition; entries: StoredTrackerEntry[] }
type Snapshot = { workspaceKey: string; goals: GoalCard[] }

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
  const goals = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.goals : []
  const visibleError = workspaceKey && error?.workspaceKey === workspaceKey ? error.message : ''
  const visibleLoading = loading || !workspaceReady || Boolean(workspaceKey && snapshot?.workspaceKey !== workspaceKey)

  const refresh = useCallback(async () => {
    const currentWorkspace = workspaceRef.current
    if (!currentWorkspace.ready || !currentWorkspace.key) return
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const trackers = await localRepository.listTrackers(true)
      const goalTrackers = trackers.filter((tracker) => tracker.kind === 'goal' && tracker.deletedAt === null)
      const earliest = goalTrackers.reduce<CalendarDate>((date, tracker) => {
        const start = (tracker.startDate ?? tracker.createdAt.slice(0, 10)) as CalendarDate
        return start < date ? start : date
      }, today)
      const entries = goalTrackers.length ? await localRepository.listTrackerEntriesBetween(earliest, today) : []
      const goals = goalTrackers.map((tracker) => ({
        tracker,
        entries: entries.filter((entry) => entry.trackerId === tracker.id),
      }))
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setSnapshot({ workspaceKey: currentWorkspace.key, goals })
      }
    } catch {
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setError({ workspaceKey: currentWorkspace.key, message: 'Your goals could not be loaded from this device.' })
      }
    } finally {
      if (generationRef.current === generation) setLoading(false)
    }
  }, [today])

  useEffect(() => {
    if (!workspaceReady || !workspaceKey) {
      setLoading(true)
      return () => { generationRef.current += 1 }
    }
    void refresh()
    return () => { generationRef.current += 1 }
  }, [refresh, workspaceKey, workspaceReady])

  const activeCount = goals.filter(({ tracker }) => tracker.status === 'active' && (!tracker.deadline || tracker.deadline >= today)).length
  const overdueCount = goals.filter(({ tracker }) => tracker.status === 'active' && Boolean(tracker.deadline && tracker.deadline < today)).length
  const completedCount = goals.filter(({ tracker }) => tracker.status === 'completed').length

  return <section className="tracker-page goals-page" aria-labelledby="goals-title">
    <PageHeader headingId="goals-title" eyebrow="YOUR DIRECTION" title="Goals" description="Keep your longer-term aims and the next useful step in view." action={<Link className="button button-primary button-medium" to="/trackers/new">＋ Create a goal</Link>} />
    {visibleError && <div role="alert" className="form-alert">{visibleError}</div>}
    {visibleLoading ? <p role="status" className="tracker-loading">Loading your goals…</p> : visibleError ? <Surface><EmptyState title="Your goals are still saved" description="This device could not open your goal list. Try loading it again." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : goals.length === 0 ? <Surface><EmptyState title="Choose something worth working toward" description="Goals use the same private, offline-first tracker workspace. Add a deadline, measures, and milestones when you create one." action={<Link className="button button-primary button-medium" to="/trackers/new">Create your first goal</Link>} /></Surface> : <>
      <div className="dashboard-stats" role="group" aria-label="Goal summary">
        <GoalStat label="In progress" value={activeCount} detail="active and within deadline" />
        <GoalStat label="Overdue" value={overdueCount} detail="active goals past their deadline" />
        <GoalStat label="Completed" value={completedCount} detail="goals you have finished" />
        <GoalStat label="All goals" value={goals.length} detail="including paused and archived goals" />
      </div>
      <div className="tracker-card-grid">
        {goals.map(({ tracker, entries: goalEntries }) => {
          const recorded = goalEntries.filter((entry) => entry.outcome === 'recorded')
          const latest = goalEntries[0]
          const overdue = tracker.status === 'active' && Boolean(tracker.deadline && tracker.deadline < today)
          const state = overdue ? 'Overdue' : tracker.status === 'completed' ? 'Completed' : tracker.status === 'paused' ? 'Paused' : tracker.status === 'archived' ? 'Archived' : 'In progress'
          const latestQualified = latest?.outcome === 'recorded' && evaluateTrackerEntry(tracker, latest).qualified
          return <Surface className="goal-card" key={tracker.id}>
            <div className="tracker-card-top"><span className="tracker-kind-chip">{state}</span>{tracker.deadline && <span>{overdue ? 'Was due' : 'Due'} {calendarDateLabel(tracker.deadline)}</span>}</div>
            <h2>{tracker.name}</h2>
            <p className="tracker-card-description">{tracker.description || 'No description yet.'}</p>
            {tracker.metrics.length > 0 && <ul className="goal-metric-list" aria-label={`${tracker.name} measures`}>
              {tracker.metrics.map((metric) => {
                const value = latest?.values[metric.id]
                const target = metric.thresholds?.target
                const valueText = typeof value === 'number' ? `${value}${metric.unit ? ` ${metric.unit}` : ''}` : typeof value === 'boolean' ? (value ? 'Done' : 'Not done') : 'Not recorded yet'
                return <li key={metric.id}><span>{metric.name}</span><strong>{valueText}{target !== undefined ? ` · target ${target}${metric.unit ? ` ${metric.unit}` : ''}` : ''}</strong></li>
              })}
            </ul>}
            {tracker.milestones.length > 0 && <section className="goal-milestones" aria-label={`${tracker.name} milestones`}>
              <h3>Milestones</h3>
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
                  const checkpoint = bestValue === undefined ? 'Not started' : `${bestValue}${metric?.unit ? ` ${metric.unit}` : ''} of ${milestone.targetValue ?? 'target'}`
                  const due = milestone.dueDate ? ` · Due ${calendarDateLabel(milestone.dueDate)}` : ''
                  return <li key={milestone.id}>
                    <span className={`goal-milestone-marker${reached ? ' reached' : ''}`} aria-hidden="true">{reached ? '✓' : '○'}</span>
                    <div><strong>{milestone.title || 'Untitled milestone'}</strong>{milestone.description && <small>{milestone.description}</small>}<small>{reached ? `Reached · best ${checkpoint}` : `${checkpoint}${due}`}</small></div>
                  </li>
                })}
              </ul>
            </section>}
            <div className="goal-card-summary">
              <span>{recorded.length} recorded {recorded.length === 1 ? 'check-in' : 'check-ins'}</span>
              <span>{latest ? `${latestQualified ? 'Latest check-in met its rule · ' : 'Latest check-in · '}${calendarDateLabel(latest.date)}` : 'No check-ins yet'}</span>
            </div>
            <div className="tracker-card-actions">
              <Link className="button button-secondary button-small" to={`/trackers/${encodeURIComponent(tracker.id)}/edit`}>Edit goal</Link>
              <Link className="button button-quiet button-small" to="/history">View history</Link>
            </div>
          </Surface>
        })}
      </div>
    </>}
  </section>
}

function GoalStat({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <Surface className="dashboard-stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></Surface>
}
