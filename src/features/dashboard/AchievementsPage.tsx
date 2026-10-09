import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calculateProgressRewards, calculateStreak, DEFAULT_REWARD_POLICY } from '../../domain/trackers/progression'
import { localCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'

type AchievementData = { trackers: StoredTrackerDefinition[]; entries: StoredTrackerEntry[] }

export function AchievementsPage() {
  const { timeZone } = useWorkspaceTimeZone()
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [data, setData] = useState<AchievementData>({ trackers: [], entries: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const trackers = await localRepository.listTrackers(true)
      const earliest = trackers.reduce<CalendarDate>((date, tracker) => {
        const anchor = (tracker.startDate ?? tracker.createdAt.slice(0, 10)) as CalendarDate
        return anchor < date ? anchor : date
      }, today)
      const entries = trackers.length ? await localRepository.listTrackerEntriesBetween(earliest, today) : []
      const trackerIds = new Set(trackers.map((tracker) => tracker.id))
      setData({ trackers, entries: entries.filter((entry) => trackerIds.has(entry.trackerId)) })
    } catch {
      setError('Your achievements could not be loaded from this device.')
    } finally {
      setLoading(false)
    }
  }, [today])
  useEffect(() => { void refresh() }, [refresh])

  const achievements = useMemo(() => data.trackers.map((tracker) => {
    const history = data.entries.filter((entry) => entry.trackerId === tracker.id)
    const streak = calculateStreak(tracker, history, today)
    const rewards = calculateProgressRewards(streak)
    const nextMilestone = DEFAULT_REWARD_POLICY.streakMilestones.find((milestone) => milestone > streak.longest)
    return { tracker, streak, rewards, nextMilestone }
  }), [data, today])
  const totalPoints = achievements.reduce((sum, item) => sum + item.rewards.totalPoints, 0)
  const totalQualifiedEntries = achievements.reduce((sum, item) => sum + item.rewards.qualifyingEntries, 0)
  const totalMilestones = achievements.reduce((sum, item) => sum + item.rewards.earnedMilestones.length, 0)

  return <section className="tracker-page achievements-page" aria-labelledby="achievements-title">
    <PageHeader headingId="achievements-title" eyebrow="YOUR WINS" title="Achievements" description="A record of the consistency and milestones you’ve earned from your saved check-ins." help={{ title: 'Achievements', summary: 'Celebrate streaks and milestones derived from your saved activity.', description: 'Points and streak milestones are calculated from qualifying check-ins and tracker schedules. Rest days do not break streaks. Values are a playful summary and do not affect your goals or records.' }} action={<Link className="button button-secondary button-medium" to="/dashboard">View overview</Link>} />
    {error && <div role="alert" className="form-alert">{error}</div>}
    {loading ? <p role="status" className="tracker-loading">Calculating your achievements…</p> : error ? <Surface><EmptyState title="Your progress is still here" description="This device could not open local storage. Try again when it is available." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : data.trackers.length === 0 ? <Surface><EmptyState title="Your first win starts with a tracker" description="Create a tracker and log check-ins to build your personal streaks and milestones." action={<Link className="button button-primary button-medium" to="/trackers/new">Create a tracker</Link>} /></Surface> : <>
      <div className="dashboard-stats achievement-stats" role="group" aria-label="Achievement summary">
        <StatCard label="Reward points" value={String(totalPoints)} detail="derived from retained check-ins" />
        <StatCard label="Qualified check-ins" value={String(totalQualifiedEntries)} detail="across your trackers" />
        <StatCard label="Streak milestones" value={String(totalMilestones)} detail="earned personal bests" />
      </div>
      <section className="achievement-list" aria-label="Tracker achievements">
        {achievements.map(({ tracker, streak, rewards, nextMilestone }) => <Surface key={tracker.id} className="achievement-card">
          <div className="achievement-card-heading"><div><span className="tracker-kind-chip">{tracker.kind}</span><h2>{tracker.name}</h2></div>{tracker.status === 'archived' && <span className="tracker-kind-chip">Archived</span>}</div>
          <div className="achievement-stats-row"><div><strong>{streak.current}</strong><span>current streak</span></div><div><strong>{streak.longest}</strong><span>personal best</span></div><div><strong>{rewards.totalPoints}</strong><span>points</span></div></div>
          {rewards.earnedMilestones.length > 0 ? <div className="earned-milestones" aria-label="Earned streak milestones">{rewards.earnedMilestones.map((milestone) => <span className="earned-milestone" key={milestone.id}>✦ {milestone.streak}-check-in streak <small>+{milestone.points} points</small></span>)}</div> : <p className="achievement-note">No streak milestones yet. Each qualified scheduled check-in adds {DEFAULT_REWARD_POLICY.pointsPerQualifiedEntry} points.</p>}
          {nextMilestone && <p className="achievement-note">Next personal-best milestone: {nextMilestone} scheduled check-ins{streak.longest > 0 ? ` · ${nextMilestone - streak.longest} to go` : ''}.</p>}
        </Surface>)}
      </section>
    </>}
    <p className="achievement-disclaimer">Points and milestones are calculated from current local history, not stored in a separate ledger. Editing history can recalculate these totals. Deleted or unavailable records cannot contribute.</p>
  </section>
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <Surface className="dashboard-stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></Surface>
}
