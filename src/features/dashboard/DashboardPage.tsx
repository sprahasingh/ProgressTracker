import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { evaluateTrackerEntry, isScheduledDate } from '../../domain/trackers/planning'
import { calculateProgressRewards, calculateStreak } from '../../domain/trackers/progression'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'

type DashboardData = { trackers: StoredTrackerDefinition[]; entries: StoredTrackerEntry[] }

export function DashboardPage() {
  const today = useMemo(localCalendarDate, [])
  const [data, setData] = useState<DashboardData>({ trackers: [], entries: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const trackers = (await localRepository.listTrackers(true)).filter((tracker) => tracker.status === 'active' && tracker.deletedAt === null)
      const earliest = trackers.reduce<CalendarDate>((date, tracker) => {
        const created = (tracker.startDate ?? tracker.createdAt.slice(0, 10)) as CalendarDate
        return created < date ? created : date
      }, today)
      const entries = trackers.length ? await localRepository.listTrackerEntriesBetween(earliest, today) : []
      const ids = new Set(trackers.map((tracker) => tracker.id))
      setData({ trackers, entries: entries.filter((entry) => ids.has(entry.trackerId)) })
    } catch {
      setError('Your overview could not be loaded from this device.')
    } finally {
      setLoading(false)
    }
  }, [today])

  useEffect(() => { void refresh() }, [refresh])
  const entryById = useMemo(() => new Map(data.trackers.map((tracker) => [tracker.id, tracker])), [data.trackers])
  const streakByTracker = useMemo(() => new Map(data.trackers.map((tracker) => {
    const trackerEntries = data.entries.filter((entry) => entry.trackerId === tracker.id)
    return [tracker.id, calculateStreak(tracker, trackerEntries, today)] as const
  })), [data.trackers, data.entries, today])
  const rewardPoints = [...streakByTracker.values()].reduce((sum, streak) => sum + calculateProgressRewards(streak).totalPoints, 0)
  const weekStart = shiftCalendarDate(today, -6)
  const weekEntries = data.entries.filter((entry) => entry.date >= weekStart && entry.date <= today)
  const qualifiedWeek = weekEntries.filter((entry) => {
    const tracker = entryById.get(entry.trackerId)
    return entry.outcome === 'recorded' && tracker !== undefined && isScheduledDate(tracker, entry.date) && evaluateTrackerEntry(tracker, entry).qualified
  })
  const scheduledWeek = data.trackers.reduce((count, tracker) => {
    for (let day = weekStart; day <= today; day = shiftCalendarDate(day, 1)) if (isScheduledDate(tracker, day)) count += 1
    return count
  }, 0)
  const completionPercent = scheduledWeek ? Math.round(qualifiedWeek.length / scheduledWeek * 100) : 0
  const calendar = buildMonth(today, data.entries, entryById)

  return (
    <section className="tracker-page dashboard-page" aria-labelledby="dashboard-title">
      <PageHeader headingId="dashboard-title" eyebrow="YOUR PROGRESS" title="Overview" description={`A clear view of what you’ve built so far · ${calendarDateLabel(today, { month: 'long', day: 'numeric' })}`} action={<Link className="button button-primary button-medium" to="/">Go to today</Link>} />
      {error && <div role="alert" className="form-alert">{error}</div>}
      {loading ? <p role="status" className="tracker-loading">Loading your progress…</p> : error ? <Surface><EmptyState title="Your progress is still here" description="This device could not open local storage. Try loading the overview again." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : data.trackers.length === 0 ? <Surface><EmptyState title="Your overview starts with a tracker" description="Once you create a tracker and log check-ins, this page will summarize your real activity." action={<Link className="button button-primary button-medium" to="/trackers/new">Create a tracker</Link>} /></Surface> : <>
        <div className="dashboard-stats" role="group" aria-label="Recent progress summary">
          <StatCard label="Active trackers" value={String(data.trackers.length)} detail="ready for your next check-in" />
          <StatCard label="Successes · 7 days" value={String(qualifiedWeek.length)} detail={`${scheduledWeek} scheduled check-ins`} />
          <StatCard label="Weekly consistency" value={scheduledWeek ? `${completionPercent}%` : '—'} detail={scheduledWeek ? 'of scheduled opportunities' : 'nothing scheduled this week'} />
          <StatCard label="Reward points" value={String(rewardPoints)} detail="active trackers · from saved check-ins" />
        </div>
        <div className="dashboard-columns">
          <Surface className="dashboard-calendar-card">
            <div className="dashboard-section-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> ACTIVITY</span><h2>{calendarDateLabel(today, { month: 'long', year: 'numeric' })}</h2></div><Link to="/history">View history <span aria-hidden="true">→</span></Link></div>
            <MonthCalendar month={calendar} today={today} />
            <div className="calendar-legend"><span><i className="calendar-dot qualified" /> Success</span><span><i className="calendar-dot skipped" /> Skipped or below rule</span></div>
          </Surface>
          <section className="dashboard-tracker-section" aria-labelledby="progress-heading">
            <div className="dashboard-section-heading dashboard-tracker-title"><div><span className="eyebrow"><span className="eyebrow-line" /> KEEP GOING</span><h2 id="progress-heading">Your trackers</h2></div><Link to="/trackers">All trackers <span aria-hidden="true">→</span></Link></div>
            <div className="dashboard-tracker-list">
              {data.trackers.map((tracker) => {
                const history = data.entries.filter((entry) => entry.trackerId === tracker.id)
                const streak = streakByTracker.get(tracker.id)!
                const latest = history[0]
                const latestResult = latest?.outcome === 'recorded' ? evaluateTrackerEntry(tracker, latest).qualified : false
                return <Surface key={tracker.id} className="dashboard-tracker-card"><div className="dashboard-tracker-card-top"><span className="tracker-kind-chip">{tracker.kind}</span><span>{latest ? calendarDateLabel(latest.date) : 'No check-ins yet'}</span></div><h3>{tracker.name}</h3><div className="dashboard-tracker-stats"><span><strong>{streak.current}</strong><small>current streak</small></span><span><strong>{streak.longest}</strong><small>personal best</small></span></div><div className="dashboard-latest-state">{latest ? <><span className={`history-outcome ${latest.outcome === 'skipped' || !latestResult ? 'muted' : 'positive'}`}>{latest.outcome === 'skipped' ? 'Skipped' : latestResult ? 'Success rule met' : 'Logged'}</span><span>{latest.outcome === 'recorded' ? summarizeValues(tracker, latest) : 'No values recorded'}</span></> : <Link to="/">Make your first check-in →</Link>}</div></Surface>
              })}
            </div>
          </section>
        </div>
      </>}
    </section>
  )
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <Surface className="dashboard-stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></Surface>
}

type DaySummary = { date: CalendarDate; entries: number; qualified: number; skippedOrBelow: number }
function buildMonth(today: CalendarDate, entries: StoredTrackerEntry[], trackers: Map<string, StoredTrackerDefinition>): DaySummary[] {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const firstDate = `${today.slice(0, 7)}-01` as CalendarDate
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const summaries: DaySummary[] = Array.from({ length: count }, (_, index) => ({ date: `${today.slice(0, 7)}-${String(index + 1).padStart(2, '0')}` as CalendarDate, entries: 0, qualified: 0, skippedOrBelow: 0 }))
  for (const entry of entries) {
    if (entry.date < firstDate || entry.date > today) continue
    const summary = summaries[Number(entry.date.slice(8, 10)) - 1]
    const tracker = trackers.get(entry.trackerId)
    if (!summary || !tracker) continue
    summary.entries += 1
    if (entry.outcome === 'recorded' && evaluateTrackerEntry(tracker, entry).qualified) summary.qualified += 1
    else summary.skippedOrBelow += 1
  }
  return summaries
}

function MonthCalendar({ month, today }: { month: DaySummary[]; today: string }) {
  const firstWeekday = new Date(`${month[0]?.date}T00:00:00.000Z`).getUTCDay()
  const cells: Array<DaySummary | null> = [...Array.from({ length: firstWeekday }, () => null), ...month]
  while (cells.length % 7) cells.push(null)
  const weeks = Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7))
  return <table className="activity-calendar" aria-label="Check-in activity this month">
    <thead><tr>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <th scope="col" className="calendar-weekday" key={day}>{day}</th>)}</tr></thead>
    <tbody>{weeks.map((week, weekIndex) => <tr key={`week-${weekIndex}`}>{week.map((day, index) => day ? <td className={`calendar-day${day.entries ? ' has-activity' : ''}${day.date === today ? ' calendar-day-today' : ''}`} key={day.date}><span>{Number(day.date.slice(8, 10))}</span><span className="visually-hidden">{calendarDateLabel(day.date, { month: 'long', day: 'numeric' })}: {day.entries} check-ins, {day.qualified} successes</span>{day.qualified > 0 && <i aria-hidden="true" className="calendar-dot qualified" />}{day.skippedOrBelow > 0 && <i aria-hidden="true" className="calendar-dot skipped" />}</td> : <td aria-hidden="true" className="calendar-day calendar-day-empty" key={`empty-${weekIndex}-${index}`} />)}</tr>)}</tbody>
  </table>
}

function summarizeValues(tracker: StoredTrackerDefinition, entry: StoredTrackerEntry): string {
  const values = tracker.metrics.flatMap((metric) => {
    const value = entry.values[metric.id]
    if (typeof value === 'number') {
      const unit = metric.unit ? ` ${metric.unit}` : ''
      const target = metric.thresholds?.target
      if (target === undefined) return [`${metric.name}: ${value}${unit}`]
      return metric.thresholds?.direction === 'decrease'
        ? [`${metric.name}: ${value}${unit} · target ≤ ${target}${unit}`]
        : [`${metric.name}: ${value} / ${target}${unit}`]
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
