import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { AppIcon } from '../../components/ui/AppIcon'
import { SectionTabs, insightsSectionTabs } from '../../components/ui/SectionTabs'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import { useAuth } from '../auth/AuthProvider'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calculateProgressRewards, calculateStreak, DEFAULT_REWARD_POLICY } from '../../domain/trackers/progression'
import { localCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { TrackerFilter, useTrackerFilter } from '../shared/TrackerFilter'
import { InfoButton } from '../../components/ui/InfoButton'

type AchievementData = { trackers: StoredTrackerDefinition[]; entries: StoredTrackerEntry[]; holidays: string[] }

export function AchievementsPage() {
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending } = useAuth()
  const owner = status === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === owner
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [data, setData] = useState<AchievementData>({ trackers: [], entries: [], holidays: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refreshGeneration = useRef(0)
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    setLoading(true)
    setError('')
    try {
      const trackers = await localRepository.listTrackers(true)
      const earliest = trackers.reduce<CalendarDate>((date, tracker) => {
        const anchor = (tracker.startDate ?? tracker.createdAt.slice(0, 10)) as CalendarDate
        return anchor < date ? anchor : date
      }, today)
      const [entries, holidays] = await Promise.all([
        trackers.length ? localRepository.listTrackerEntriesBetween(earliest, today) : Promise.resolve([]),
        localRepository.listAccountHolidays(earliest, today),
      ])
      const trackerIds = new Set(trackers.map((tracker) => tracker.id))
      if (refreshGeneration.current === generation) setData({ trackers, entries: entries.filter((entry) => trackerIds.has(entry.trackerId)), holidays: holidays.map((holiday) => holiday.date) })
    } catch {
      if (refreshGeneration.current === generation) setError('Your achievements could not be loaded from this device.')
    } finally {
      if (refreshGeneration.current === generation) setLoading(false)
    }
  }, [today])
  useEffect(() => { if (workspaceReady) void refresh() }, [refresh, workspaceReady])
  useWorkspaceDataChanges(owner, workspaceReady, refresh)

  const trackerFilter = useTrackerFilter(owner, data.trackers, !loading && workspaceReady)
  const selectedTracker = data.trackers.find((tracker) => tracker.id === trackerFilter.selectedId) ?? null
  const visibleTrackers = selectedTracker ? [selectedTracker] : data.trackers
  const achievements = useMemo(() => visibleTrackers.map((tracker) => {
    const history = data.entries.filter((entry) => entry.trackerId === tracker.id)
    const streak = calculateStreak(tracker, history, today, new Set(data.holidays))
    const rewards = calculateProgressRewards(streak)
    const nextMilestone = DEFAULT_REWARD_POLICY.streakMilestones.find((milestone) => milestone > streak.longest)
    return { tracker, streak, rewards, nextMilestone }
  }), [visibleTrackers, data.entries, data.holidays, today])
  const totalPoints = achievements.reduce((sum, item) => sum + item.rewards.totalPoints, 0)
  const totalQualifiedEntries = achievements.reduce((sum, item) => sum + item.rewards.qualifyingEntries, 0)
  const totalMilestones = achievements.reduce((sum, item) => sum + item.rewards.earnedMilestones.length, 0)

  return <section className="tracker-page achievements-page" aria-labelledby="achievements-title">
    <PageHeader headingId="achievements-title" eyebrow="YOUR WINS" title="Achievements" description="A record of the consistency and milestones you’ve earned from your saved check-ins." help={{ title: 'Achievements', summary: 'Celebrate tracker-specific streaks and milestones derived from saved activity.', description: 'Standard Mode counts qualifying scheduled days; holidays and rest days pause streaks. Strict Mode requires qualifying progress every calendar date within the tracker period. In All Trackers, points and milestones are aggregated, but different tracker streak lengths are never added together.' }} action={<Link className="button button-secondary button-medium" to="/dashboard">View overview</Link>} />
    <SectionTabs label="Insights sections" items={insightsSectionTabs} />
    {error && <div role="alert" className="form-alert">{error}</div>}
    {loading ? <p role="status" className="tracker-loading">Calculating your achievements…</p> : error ? <Surface><EmptyState title="Your progress is still here" description="This device could not open local storage. Try again when it is available." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : data.trackers.length === 0 ? <Surface><EmptyState title="Your first win starts with a tracker" description="Create a tracker and log check-ins to build your personal streaks and milestones." action={<Link className="button button-primary button-medium" to="/trackers/new">Create a tracker</Link>} /></Surface> : <>
      <div className="insights-filter-toolbar"><TrackerFilter trackers={data.trackers} selectedId={trackerFilter.selectedId} onChange={trackerFilter.select} label="Show achievements for" /></div>
      <div className="dashboard-stats achievement-stats" role="group" aria-label="Achievement summary">
        <StatCard label="Reward points" value={String(totalPoints)} detail="derived from retained check-ins" help="Points are calculated per tracker from qualified entries and longest streak milestones. In All Trackers, totals add points across trackers without combining their streaks." />
        <StatCard label="Qualified check-ins" value={String(totalQualifiedEntries)} detail={selectedTracker ? selectedTracker.name : 'across your trackers'} help="Counts check-ins that met each tracker’s streak qualification. In All Trackers, counts are added across eligible trackers." />
        <StatCard label="Streak milestones" value={String(totalMilestones)} detail="earned personal bests" help="Counts milestones reached by each tracker’s own personal best. Streaks remain separate per tracker." />
      </div>
      <section className="achievement-list" aria-label="Tracker achievements">
        {achievements.map(({ tracker, streak, rewards, nextMilestone }) => <Surface key={tracker.id} className="achievement-card">
          <div className="achievement-card-heading"><div><span className="tracker-kind-chip">{tracker.kind}</span><h2>{tracker.name}</h2></div>{tracker.status === 'archived' && <span className="tracker-kind-chip">Archived</span>}</div>
          <div className="achievement-stats-row"><div><strong>{streak.current}</strong><span>current streak <InfoButton title="Current streak" summary="Consecutive qualifying opportunities up to today." description={tracker.strictMode ? 'Strict Mode counts every calendar day within the tracker period, including holidays and rest days. Today remains open until it ends.' : 'Standard Mode counts qualifying scheduled days; missed days break the run while holidays and rest days preserve continuity.'} /></span></div><div><strong>{streak.longest}</strong><span>personal best <InfoButton title="Longest streak" summary="The longest uninterrupted qualifying run in this tracker’s history." description={tracker.strictMode ? 'Strict Mode uses every calendar day in the tracker period, including holidays and rest days. Changing mode recalculates this from saved entries.' : 'Standard Mode counts scheduled opportunities and lets holidays and rest days preserve continuity. Changing mode recalculates this from saved entries.'} /></span></div><div><strong>{rewards.totalPoints}</strong><span>points</span></div></div>
          {rewards.earnedMilestones.length > 0 ? <div className="earned-milestones" aria-label="Earned streak milestones">{rewards.earnedMilestones.map((milestone) => <span className="earned-milestone" key={milestone.id}><AppIcon name="spark" /> {milestone.streak}-check-in streak <small>+{milestone.points} points</small></span>)}</div> : <p className="achievement-note">No streak milestones yet. Each qualified scheduled check-in adds {DEFAULT_REWARD_POLICY.pointsPerQualifiedEntry} points.</p>}
          {nextMilestone && <p className="achievement-note">Next personal-best milestone: {nextMilestone} scheduled check-ins{streak.longest > 0 ? ` · ${nextMilestone - streak.longest} to go` : ''}.</p>}
        </Surface>)}
      </section>
    </>}
    <p className="achievement-disclaimer">Points and milestones are calculated from current local history, not stored in a separate ledger. Editing history can recalculate these totals. Deleted or unavailable records cannot contribute.</p>
  </section>
}

function StatCard({ label, value, detail, help }: { label: string; value: string; detail: string; help: string }) {
  return <Surface className="dashboard-stat"><span className="dashboard-stat-label">{label}<InfoButton title={label} summary={detail} description={help} /></span><strong>{value}</strong><small>{detail}</small></Surface>
}
