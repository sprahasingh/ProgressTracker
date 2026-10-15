import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, insightsSectionTabs } from '../../components/ui/SectionTabs'
import { Surface } from '../../components/ui/Surface'
import { useAuth } from '../auth/AuthProvider'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import type { CalendarDate, StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { PROGRESSION_REWARDS } from '../../domain/trackers/progressionModel'
import { calculateStreak, qualifiesForStreak } from '../../domain/trackers/progression'
import { isActiveTracker, isArchivedTracker } from '../../domain/trackers/lifecycle'
import { isTrackerInActivePeriod, isTrackerScheduledOccurrence, trackerActiveStartDate } from '../../domain/trackers/planning'
import { activeAchievementOccurrences, getProgressionHistory, getProgressionOverview, type AchievementState, type ProgressionEvent, type ProgressionOverview } from '../../services/supabase/progressionRepository'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { achievementDefinition } from './achievementCatalog'
import { ProgressionBadge } from './ProgressionBadge'
import { ProgressionDetailDialog } from './ProgressionDetailDialog'
import { InfoButton } from '../../components/ui/InfoButton'

type PageData = {
  overview: ProgressionOverview
  trackers: StoredTrackerDefinition[]
  entries: StoredTrackerEntry[]
  holidays: Set<string>
}
type Detail = 'consistency' | 'streaks' | 'milestones' | null
type HistoryRange = '7' | '30' | '90' | 'all'
type HistoryPage = { rows: ProgressionEvent[]; hasMore: boolean }
type LocalActivity = { date: string; completed: number; skipped: number; missed: number; exempt: number }
type StreakFilter = 'active' | 'archived'

function progressionFailureMessage(error: unknown): { summary: string; detail: string } {
  const detail = error instanceof Error ? error.message : String(error)
  if (/\b(PGRST205|42P01)\b/.test(detail)) {
    return {
      summary: 'The connected Supabase project does not expose a required progression table. Apply the progression migrations to this project, then retry.',
      detail,
    }
  }
  if (/\b(42501|PGRST301|401|403)\b/i.test(detail)) {
    return {
      summary: 'Supabase rejected a progression read. Check the signed-in account, table grants, and row-level security policies for the progression migrations.',
      detail,
    }
  }
  if (/supabase is not configured/i.test(detail)) {
    return { summary: 'Supabase is not configured for this build. Check the VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY values.', detail }
  }
  return { summary: 'Progression data could not be loaded. The diagnostic below identifies the failed request; correct the configuration or database issue and retry.', detail }
}

const historyPageSize = 30
const historyRanges: Array<{ value: HistoryRange; label: string }> = [
  { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'all', label: 'All time' },
]
const reasonPresentation: Record<string, { label: string; icon: 'check' | 'spark' | 'goal' | 'reset' }> = {
  DAILY_CHECK_IN_COMPLETED: { label: 'Qualifying check-in', icon: 'check' },
  PERFECT_DAY_BONUS: { label: 'Perfect Day', icon: 'spark' },
  STREAK_MILESTONE: { label: 'Streak milestone', icon: 'spark' },
  GOAL_MILESTONE: { label: 'Goal milestone', icon: 'goal' },
  GOAL_COMPLETED: { label: 'Goal completed', icon: 'check' },
  LEGACY_XP_OPENING_BALANCE: { label: 'XP reconstructed from past activity', icon: 'spark' },
  AWARD_REVERSAL: { label: 'Award reversed', icon: 'reset' },
}

const levelThresholds = Array.from({ length: 20 }, (_, index) => ({ level: index + 1, xp: 50 * index * (index + 1) }))

function XpInformation({ overview }: { overview: ProgressionOverview }) {
  const remaining = overview.officialLevel.nextLevelXp - overview.confirmedXp
  return <div className="xp-information">
    <p>Confirmed net XP comes from these server-recorded rewards:</p>
    <ul><li>Qualifying check-in: {PROGRESSION_REWARDS.checkIn} XP</li><li>Perfect Day: {PROGRESSION_REWARDS.perfectDay} XP</li>
      {PROGRESSION_REWARDS.streakMilestones.map((item) => <li key={item.days}>Streak of {item.days}: {item.xp} XP</li>)}
      <li>Goal milestone: {PROGRESSION_REWARDS.goalMilestone} XP</li><li>Completed goal: {PROGRESSION_REWARDS.goalCompleted} XP</li></ul>
    <p>Level threshold formula: 50 × (L − 1) × L total XP. Reversals reduce net XP and can lower your level. Offline XP stays pending until the server confirms it.</p>
    <p>Level {overview.officialLevel.level} · {remaining.toLocaleString()} XP to the next level.</p>
    <div className="xp-threshold-table" role="table" aria-label="Total XP level thresholds">
      {levelThresholds.map(({ level, xp }) => <span role="row" key={level}><strong role="cell">Level {level}</strong><span role="cell">{xp.toLocaleString()} XP</span></span>)}
    </div>
  </div>
}

function eventLabel(event: ProgressionEvent) {
  return reasonPresentation[event.reasonCode]?.label ?? 'Progression activity'
}

function reasonCodeLabel(reasonCode: string | null) {
  return reasonCode ? reasonPresentation[reasonCode]?.label ?? 'Progression activity' : 'Reason unavailable'
}

function eventIcon(event: ProgressionEvent) {
  return reasonPresentation[event.reasonCode]?.icon ?? 'spark'
}

function consistencyProgress(badge: AchievementState) {
  const details = badge.qualificationDetails
  if (!Number.isFinite(details?.eligible_days) || !Number.isFinite(details?.eligible_days_target)) return null
  const adherence = Number.isFinite(details?.adherence_percent) ? `${details!.adherence_percent}%` : 'Unavailable'
  const adherenceTarget = Number.isFinite(details?.adherence_target_percent) ? `${details!.adherence_target_percent}%` : '80%'
  return {
    eligibleDays: `Eligible days: ${details!.eligible_days} / ${details!.eligible_days_target}`,
    adherence: `Adherence: ${adherence} (target: ${adherenceTarget})`,
  }
}

function achievementProgressLabel(badge: AchievementState, progressUnit: string) {
  const progress = Math.floor(badge.progress)
  return progressUnit === '% consistency'
    ? `${progress}% / ${badge.target}%`
    : `${progress} / ${badge.target} ${progressUnit}`
}

function badgeEarnedDate(badge: AchievementState) {
  const occurrences = activeAchievementOccurrences(badge.history)
  const byDate = (event: AchievementState['history'][number]) => event.sourceDate ?? event.recordedAt.slice(0, 10)
  if (!badge.repeatable) return occurrences.map(byDate).sort()[0] ?? badge.firstEarnedAt?.slice(0, 10) ?? badge.unlockedAt?.slice(0, 10) ?? null
  return occurrences.map(byDate).sort().at(-1) ?? badge.lastEarnedAt?.slice(0, 10) ?? badge.unlockedAt?.slice(0, 10) ?? null
}

function formatCalendarDate(date: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00.000Z`))
}

function badgeOccurrencePeriod(badge: AchievementState, event: AchievementState['history'][number]) {
  const reference = event.sourceReference ?? {}
  if (badge.achievementId === 'perfect-month' && typeof reference.month === 'string' && /^\d{4}-\d{2}$/.test(reference.month)) {
    const [year = 0, month = 1] = reference.month.split('-').map(Number)
    return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 15)))
  }
  if (badge.achievementId === 'perfect-week' && typeof reference.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reference.week)) {
    const start = reference.week
    const end = shiftCalendarDate(start as CalendarDate, 6)
    return `${formatCalendarDate(start)} – ${formatCalendarDate(end)}`
  }
  if (badge.achievementId === 'perfect-year' && typeof reference.year === 'number') return String(reference.year)
  return event.sourceDate ? formatCalendarDate(event.sourceDate) : formatCalendarDate(event.recordedAt.slice(0, 10))
}

function BadgeInformation({ badge }: { badge: AchievementState }) {
  const definition = achievementDefinition(badge.achievementId)
  if (!definition) return null
  const details = badge.qualificationDetails ?? {}
  const progress = Number.isFinite(details.progress) ? details.progress! : badge.progress
  const target = Number.isFinite(details.target) && details.target! > 0 ? details.target! : badge.target
  const periodBadge = ['perfect-week', 'perfect-month', 'perfect-year'].includes(badge.achievementId)
  const canShowProgress = !badge.earned && (details.status === 'in_progress' || !periodBadge && badge.target > 0)
  const percentage = canShowProgress ? Math.min(100, Math.floor(progress / target * 100)) : null
  const occurrences = activeAchievementOccurrences(badge.history)
  return <div className="badge-information">
    <p>{definition.description}</p><strong>Unlock requirement</strong><p>{definition.requirement}</p>
    {badge.earned && badge.repeatable && <p>{occurrences.length} active confirmed {occurrences.length === 1 ? 'occurrence' : 'occurrences'}.</p>}
    {badge.earned && occurrences.length > 0 && <ul className="badge-information-dates">{occurrences.map((event) => <li key={event.id}>{badgeOccurrencePeriod(badge, event)}</li>)}</ul>}
    {!badge.earned && details.label && <><strong>{details.label}</strong><p>{details.message ?? qualificationStatusLabel(details.status)}</p></>}
    {!badge.earned && !details.label && (periodBadge ? <p>Qualification progress is awaiting reliable server confirmation for the current calendar period.</p> : <p>Current progress: {progress.toLocaleString()} / {target.toLocaleString()} {definition.progressUnit}.</p>)}
    {canShowProgress && percentage !== null && <><div className="badge-information-progress-label"><span>{progress.toLocaleString()} / {target.toLocaleString()}</span><strong>{percentage}%</strong></div><span className="progression-level-track" role="progressbar" aria-label={`${definition.name} qualification progress`} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={target}><span style={{ width: `${percentage}%` }} /></span></>}
    {periodBadge && details.period_start && details.period_end && <p>Period: {formatCalendarDate(details.period_start)} – {formatCalendarDate(details.period_end)} (account timezone)</p>}
  </div>
}

function qualificationStatusLabel(status: string | undefined) {
  if (status === 'failed' || status === 'ineligible') return 'This period was not achieved.'
  if (status === 'unavailable' || status === 'waiting') return 'Awaiting reliable confirmation.'
  if (status === 'qualified') return 'Period completed and qualified.'
  return 'Current period is still in progress.'
}

function formatRecordedTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function milestoneEvents(events: readonly ProgressionEvent[]) {
  const milestoneIds = new Set(events.filter((event) => ['STREAK_MILESTONE', 'GOAL_MILESTONE', 'GOAL_COMPLETED'].includes(event.reasonCode)).map((event) => event.id))
  return events.filter((event) => ['STREAK_MILESTONE', 'GOAL_MILESTONE', 'GOAL_COMPLETED'].includes(event.reasonCode)
    || event.reasonCode === 'AWARD_REVERSAL' && event.reversesEventId !== null && milestoneIds.has(event.reversesEventId))
    .sort((left, right) => right.effectiveDate.localeCompare(left.effectiveDate) || right.recordedAt.localeCompare(left.recordedAt))
}

function getLocalActivity(data: PageData, trackers: readonly StoredTrackerDefinition[], today: string, timeZone: string): LocalActivity[] {
  return Array.from({ length: 7 }, (_, index) => shiftCalendarDate(today as CalendarDate, index - 7)).map((date) => {
    const activity: LocalActivity = { date, completed: 0, skipped: 0, missed: 0, exempt: 0 }
    for (const tracker of trackers) {
      if (isArchivedTracker(tracker) && tracker.archivedAt && date >= localCalendarDate(new Date(tracker.archivedAt), timeZone)) continue
      const inPeriod = isTrackerInActivePeriod(tracker, date, timeZone)
      const isEligible = inPeriod && (tracker.strictMode === true || (!data.holidays.has(date) && isTrackerScheduledOccurrence(tracker, date, timeZone)))
      if (!isEligible) { activity.exempt += 1; continue }
      const entry = data.entries.find((item) => item.trackerId === tracker.id && item.date === date)
      if (entry?.outcome === 'recorded') activity.completed += 1
      else if (entry?.outcome === 'skipped') activity.skipped += 1
      else activity.missed += 1
    }
    return activity
  })
}

export function ProgressionAchievementsPage() {
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending, isOnline, syncStatus } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const owner = status === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = Boolean(owner) && !sessionTransitionPending && workspaceStatus === 'ready' && workspaceUserId === owner
  const today = useMemo(() => localCalendarDate(new Date(), timeZone), [timeZone])
  const [pageData, setPageData] = useState<PageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRange, setHistoryRange] = useState<HistoryRange>('7')
  const [historyPage, setHistoryPage] = useState<HistoryPage>({ rows: [], hasMore: false })
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [detail, setDetail] = useState<Detail>(null)
  const [streakFilter, setStreakFilter] = useState<StreakFilter>('active')
  const [selectedBadge, setSelectedBadge] = useState<AchievementState | null>(null)
  const [allBadgesOpen, setAllBadgesOpen] = useState(false)
  const refreshGeneration = useRef(0)
  const historyGeneration = useRef(0)

  useEffect(() => {
    historyGeneration.current += 1
    setPageData(null)
    setLoading(Boolean(owner))
    setHistoryOpen(false)
    setHistoryPage({ rows: [], hasMore: false })
    setHistoryError('')
    setDetail(null)
    setSelectedBadge(null)
  }, [owner])

  const refresh = useCallback(async () => {
    if (!owner || !workspaceReady) return
    const generation = ++refreshGeneration.current
    setLoading(true)
    setError('')
    try {
      const trackers = (await localRepository.listTrackers(true)).filter((tracker) => tracker.deletedAt === null && ['active', 'archived'].includes(tracker.status))
      const earliest = trackers.reduce<CalendarDate>((value, tracker) => {
        const start = trackerActiveStartDate(tracker, timeZone) as CalendarDate
        return start < value ? start : value
      }, today as CalendarDate)
      const [overview, entries, holidays] = await Promise.all([
        getProgressionOverview(owner),
        trackers.length ? localRepository.listTrackerEntriesBetween(earliest, today) : Promise.resolve([]),
        localRepository.listAccountHolidays(earliest, today),
      ])
      if (refreshGeneration.current === generation) setPageData({ overview, trackers, entries, holidays: new Set(holidays.map((holiday) => holiday.date)) })
    } catch (cause) {
      if (refreshGeneration.current === generation) setError(progressionFailureMessage(cause).detail)
    } finally {
      if (refreshGeneration.current === generation) setLoading(false)
    }
  }, [owner, today, timeZone, workspaceReady])

  useEffect(() => {
    if (workspaceReady) void refresh()
    else { setLoading(false); setPageData(null) }
    return () => { refreshGeneration.current += 1 }
  }, [refresh, workspaceReady])
  useWorkspaceDataChanges(owner, workspaceReady, refresh, true)

  const streaks = useMemo(() => pageData?.trackers.map((tracker) => ({
    tracker,
    streak: calculateStreak(tracker, pageData.entries.filter((entry) => entry.trackerId === tracker.id), today, pageData.holidays, timeZone),
  })) ?? [], [pageData, today, timeZone])
  const activeTrackers = useMemo(() => pageData?.trackers.filter(isActiveTracker) ?? [], [pageData])
  const archivedTrackers = useMemo(() => pageData?.trackers.filter(isArchivedTracker) ?? [], [pageData])
  const hasQualifiedOpenDay = Boolean(pageData && activeTrackers.some((tracker) => {
    if (!isTrackerInActivePeriod(tracker, today, timeZone) || tracker.strictMode !== true && (pageData.holidays.has(today) || !isTrackerScheduledOccurrence(tracker, today, timeZone))) return false
    const entry = pageData.entries.find((item) => item.trackerId === tracker.id && item.date === today)
    return Boolean(entry && qualifiesForStreak(tracker, entry))
  }))
  const pendingOpenDay = Boolean(pageData?.overview.provisionalRewards.some((reward) => reward.effectiveDate === today))
  const consistencyContext = pageData
    ? pageData.overview.consistency.eligibleDays === 0
      ? activeTrackers.length === 0 ? 'No active trackers are available to measure.'
        : pendingOpenDay ? 'Today’s qualifying check-in is waiting for sync; consistency updates after the date closes.'
          : hasQualifiedOpenDay ? `Today’s eligible activity will count after the date closes in ${timeZone}.`
            : 'Consistency appears after your first completed eligible day closes.'
      : pageData.overview.consistency.eligibleDays < 30
        ? `${pageData.overview.consistency.eligibleDays} closed eligible days; the 30-day view is still building.`
        : `Across ${pageData.overview.consistency.eligibleDays} closed eligible days.`
    : ''
  const visibleStreaks = streakFilter === 'active'
    ? streaks.filter(({ tracker }) => isActiveTracker(tracker))
    : streaks.filter(({ tracker }) => isArchivedTracker(tracker))
  const activity = useMemo(() => pageData ? getLocalActivity(pageData, streakFilter === 'active' ? activeTrackers : archivedTrackers, today, timeZone) : [], [pageData, streakFilter, activeTrackers, archivedTrackers, today, timeZone])
  const milestones = useMemo(() => pageData ? milestoneEvents(pageData.overview.scoreHistory) : [], [pageData])
  const recentUnlocks = useMemo(() => pageData?.overview.achievements.filter((badge) => badge.earned)
    .sort((left, right) => (right.unlockedAt ?? '').localeCompare(left.unlockedAt ?? '')).slice(0, 3) ?? [], [pageData])
  const weekStart = shiftCalendarDate(today as CalendarDate, -6)
  const weeklyXp = pageData?.overview.scoreHistory.filter((event) => event.effectiveDate >= weekStart && event.effectiveDate <= today)
    .reduce((sum, event) => sum + event.xpDelta, 0) ?? 0
  const activeStreakCount = streaks.filter((item) => isActiveTracker(item.tracker) && item.streak.current > 0).length
  const distinctBadgesUnlocked = pageData?.overview.achievements.filter((badge) => badge.earned).length ?? 0

  const fetchHistoryPage = useCallback(async (page: number, replace: boolean) => {
    if (!owner) return
    const generation = ++historyGeneration.current
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const result = await getProgressionHistory(owner, page, historyPageSize)
      if (historyGeneration.current === generation) {
        setHistoryPage((current) => ({ rows: replace ? result.rows : [...current.rows, ...result.rows], hasMore: result.hasMore }))
      }
    } catch (cause) {
      if (historyGeneration.current === generation) setHistoryError(progressionFailureMessage(cause).detail)
    } finally {
      if (historyGeneration.current === generation) setHistoryLoading(false)
    }
  }, [owner])

  const openHistory = () => {
    setHistoryRange('7')
    setHistoryPage({ rows: [], hasMore: false })
    setHistoryOpen(true)
    void fetchHistoryPage(0, true)
  }
  const changeHistoryRange = (range: HistoryRange) => {
    setHistoryRange(range)
    setHistoryPage({ rows: [], hasMore: false })
    void fetchHistoryPage(0, true)
  }

  const visibleHistory = useMemo(() => {
    if (!pageData) return []
    const start = historyRange === 'all' ? null : shiftCalendarDate(today as CalendarDate, -(Number(historyRange) - 1))
    const confirmed = historyPage.rows.filter((event) => event.effectiveDate <= today && (!start || event.effectiveDate >= start))
    const pending = pageData.overview.provisionalRewards.filter((reward) => reward.effectiveDate <= today && (!start || reward.effectiveDate >= start)).map((reward) => {
      const entryId = reward.id.slice('check-in:'.length)
      const entry = pageData.entries.find((item) => item.id === entryId)
      const tracker = entry ? pageData.trackers.find((item) => item.id === entry.trackerId) : undefined
      return { id: reward.id, effectiveDate: reward.effectiveDate, xpDelta: reward.xpDelta, displayName: tracker?.name ?? 'Pending check-in', pending: true as const }
    })
    return [
      ...confirmed.map((event) => ({ ...event, pending: false as const })),
      ...pending,
    ].sort((left, right) => right.effectiveDate.localeCompare(left.effectiveDate))
  }, [historyPage.rows, historyRange, pageData, today])

  if (status === 'loading' || sessionTransitionPending || loading && workspaceReady) {
    return <section className="tracker-page progression-page" aria-labelledby="achievements-title"><PageHeader headingId="achievements-title" eyebrow="YOUR PROGRESS" title="Achievements" /><SectionTabs label="Insights sections" items={insightsSectionTabs} /><p role="status" className="tracker-loading">Loading your confirmed progress…</p></section>
  }

  if (!owner) {
    return <section className="tracker-page progression-page" aria-labelledby="achievements-title"><PageHeader headingId="achievements-title" eyebrow="YOUR PROGRESS" title="Achievements" description="Your rewards and achievements are tied to your account." /><SectionTabs label="Insights sections" items={insightsSectionTabs} /><Surface><EmptyState title="Sign in to view your rewards" description="Confirmed XP and achievement unlocks are securely stored with your account." action={<Link className="button button-primary button-medium" to="/auth">Open account</Link>} /></Surface></section>
  }

  return <section className="tracker-page progression-page" aria-labelledby="achievements-title">
    <PageHeader headingId="achievements-title" eyebrow="YOUR PROGRESS" title="Achievements" description="Your confirmed rewards, steady progress, and milestones." />
    <SectionTabs label="Insights sections" items={insightsSectionTabs} />
    {error && <div role="alert" className="form-alert progression-error"><div><span>{progressionFailureMessage(error).summary}</span><details className="progression-error-details"><summary>Technical details</summary><code>{progressionFailureMessage(error).detail}</code></details></div><Button variant="secondary" size="small" onClick={() => void refresh()}>Try again</Button></div>}
    {!workspaceReady && !error ? <p role="status" className="tracker-loading">Opening your account workspace…</p> : pageData && <>
      <section className="progression-overview" aria-labelledby="progression-overview-title">
        <div className="progression-section-heading"><div><span className="eyebrow">OVERVIEW</span><h2 id="progression-overview-title">Progress at a glance</h2></div><span className="progression-authority"><AppIcon name="privacy" /> Server-confirmed rewards</span></div>
        <div className="progression-overview-grid">
          <div className="progression-level-card-shell">
          <div className="progression-xp-header"><strong>Your Experience</strong><div><span className="progression-level-pill">LEVEL {pageData.overview.officialLevel.level}</span><InfoButton title="How XP and levels work" label="XP and level information" compact content={<XpInformation overview={pageData.overview} />} /></div></div>
          <button type="button" className="progression-level-card" onClick={openHistory} aria-label={`${pageData.overview.confirmedXp} confirmed XP at level ${pageData.overview.officialLevel.level}. Open score history`}>
            <span className="progression-card-label">CONFIRMED XP</span>
            <strong className="progression-xp-total">{pageData.overview.confirmedXp.toLocaleString()} <small>XP</small></strong>
            {pageData.overview.legacyXpStatus === 'reconstructed' && <span className="progression-history-estimate">XP reconstructed from past activity</span>}
            {(pageData.overview.legacyXpStatus === 'unavailable' || pageData.overview.legacyXpStatus === 'legacy_fallback') && <span className="progression-history-unavailable">Historical XP unavailable</span>}
            {pageData.overview.legacyXpStatus === 'pending' && <span className="progression-history-unavailable">Historical XP is being prepared</span>}
            <span className="progression-level-track" role="progressbar" aria-label="Progress to next level" aria-valuenow={pageData.overview.officialLevel.progressXp} aria-valuemin={0} aria-valuemax={pageData.overview.officialLevel.requiredXp}><span style={{ width: `${Math.min(100, pageData.overview.officialLevel.progressXp / pageData.overview.officialLevel.requiredXp * 100)}%` }} /></span>
            <span className="progression-level-caption">{pageData.overview.officialLevel.progressXp.toLocaleString()} of {pageData.overview.officialLevel.requiredXp.toLocaleString()} XP this level · {(pageData.overview.officialLevel.nextLevelXp - pageData.overview.confirmedXp).toLocaleString()} XP to level {pageData.overview.officialLevel.level + 1}</span>
            <span className="progression-milestone-row">Next milestone: Level {([5, 10, 20, 30, 50, 100].find((milestone) => milestone > pageData.overview.officialLevel.level) ?? pageData.overview.officialLevel.level + 1)}</span>
            {pageData.overview.provisionalXp > 0 && <span className="progression-pending-line"><AppIcon name="status-pending" /> +{pageData.overview.provisionalXp.toLocaleString()} XP pending sync</span>}
            {syncStatus === 'error' && <span className="progression-pending-note">Sync needs attention. Pending rewards are not included above.</span>}
            {(pageData.overview.provisionalXp > 0 && (!isOnline || syncStatus === 'offline' || syncStatus === 'waiting')) && <span className="progression-pending-note">Saved on this device; confirmation will follow when synchronization completes.</span>}
          </button>
          </div>
          <button type="button" className="progression-summary-card" onClick={() => setDetail('consistency')} aria-label={`Consistency score ${pageData.overview.consistency.score ?? 'not available'}, view consistency details`}>
            <span className="progression-card-label">CONSISTENCY</span><strong>{pageData.overview.consistency.score === null ? '—' : `${pageData.overview.consistency.score}`}<small>{pageData.overview.consistency.score === null ? '' : ' / 100'}</small></strong>
            <span>{consistencyContext}</span>
            <span className="progression-card-action">View 30-day details <AppIcon name="chevron-down" /></span>
          </button>
          <button type="button" className="progression-summary-card" onClick={openHistory} aria-label={`${weeklyXp >= 0 ? 'Plus' : 'Minus'} ${Math.abs(weeklyXp)} XP this week, open score history`}>
            <span className="progression-card-label">XP THIS WEEK</span><strong className={weeklyXp < 0 ? 'is-negative' : ''}>{weeklyXp > 0 ? '+' : ''}{weeklyXp.toLocaleString()}<small> XP</small></strong>
            <span>Net confirmed rewards in the last 7 days</span><span className="progression-card-action">Open score history <AppIcon name="chevron-down" /></span>
          </button>
          <button type="button" className="progression-summary-card" onClick={() => setDetail('streaks')} aria-label={`${activeStreakCount} active streaks, view streak details`}>
            <span className="progression-card-label">ACTIVE STREAKS</span><strong>{activeStreakCount}</strong>
            <span>{activeTrackers.length ? `Across ${activeTrackers.length} active trackers` : 'Create or restore a tracker to begin'}</span><span className="progression-card-action">View streaks <AppIcon name="chevron-down" /></span>
          </button>
          <button type="button" className="progression-summary-card progression-badges-summary" aria-label={`${distinctBadgesUnlocked} distinct badge types unlocked. Show all badges`} onClick={() => setAllBadgesOpen(true)}>
            <span className="progression-card-label">BADGES</span><strong>{distinctBadgesUnlocked}<small> unlocked</small></strong>
            <span>Distinct badge types</span><span className="progression-card-action">Show all badges <AppIcon name="chevron-down" /></span>
          </button>
        </div>
        <div className="progression-recent-unlocks" aria-label="Recently unlocked achievements">
          <strong>Recently unlocked</strong>
          {recentUnlocks.length ? recentUnlocks.map((badge) => {
            const definition = achievementDefinition(badge.achievementId)
            const earnedDate = definition ? badgeEarnedDate(badge) : badge.unlockedAt?.slice(0, 10)
            const activeOccurrences = activeAchievementOccurrences(badge.history)
            const earnedCount = badge.validAwardCount ?? activeOccurrences.length
            return <button type="button" key={badge.achievementId} onClick={() => setSelectedBadge(badge)}><ProgressionBadge achievementId={badge.achievementId} tier={badge.repeatable ? Math.max(1, earnedCount) : 1} /><span>{definition?.name ?? 'Achievement'}<small>{earnedDate ? formatCalendarDate(earnedDate) : 'Earned'}</small></span></button>
          }) : <p>Your first confirmed badge will appear here when earned.</p>}
        </div>
      </section>

      <section className="progression-section" aria-labelledby="progression-history-heading">
        <div className="progression-section-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h2 id="progression-history-heading">Score history</h2></div><button type="button" className="progression-text-button" onClick={openHistory}>View all <AppIcon name="chevron-down" /></button></div>
        {pageData.overview.scoreHistory.length === 0 && pageData.overview.provisionalRewards.length === 0 ? <p className="progression-empty-inline">Confirmed rewards will appear here as eligible activity syncs.</p> : <ul className="progression-event-list progression-recent-list">{recentEvents(pageData).slice(0, 4).map((item) => <HistoryRow key={item.id} item={item} />)}</ul>}
      </section>

      <section className="progression-section" aria-labelledby="progression-streak-heading">
        <div className="progression-section-heading"><div><span className="eyebrow">STEADY PROGRESS</span><h2 id="progression-streak-heading">Streaks &amp; milestones</h2></div></div>
        <div className="progression-detail-cards">
          <button type="button" className="progression-detail-card" onClick={() => setDetail('streaks')}><span className="progression-detail-symbol"><AppIcon name="habit" /></span><span><strong>{activeStreakCount} active streaks</strong><small>Recent activity, skips, and exempt days</small></span><AppIcon className="progression-detail-chevron" name="chevron-down" /></button>
          <button type="button" className="progression-detail-card" onClick={() => setDetail('milestones')}><span className="progression-detail-symbol is-gold"><AppIcon name="spark" /></span><span><strong>{milestones.length} milestone rewards</strong><small>Streak and goal awards from your ledger</small></span><AppIcon className="progression-detail-chevron" name="chevron-down" /></button>
        </div>
      </section>

      <section className="progression-section" aria-labelledby="progression-badges-heading">
        <div className="progression-section-heading"><div><span className="eyebrow">COLLECTION</span><h2 id="progression-badges-heading">Achievement badges</h2></div><span className="progression-collection-count">{distinctBadgesUnlocked} of {pageData.overview.achievements.length} earned</span></div>
        {pageData.overview.achievements.length === 0 ? <p className="progression-empty-inline">Achievement progress will appear after the account’s progression data is available.</p> : <div className="progression-badge-grid">{pageData.overview.achievements.map((badge) => <BadgeCard key={badge.achievementId} badge={badge} onOpen={() => setSelectedBadge(badge)} />)}</div>}
      </section>
    </>}

    {historyOpen && <ProgressionDetailDialog title="Score history" eyebrow="CONFIRMED REWARDS" onClose={() => setHistoryOpen(false)}>
      <p className="progression-dialog-intro">Every listed XP change comes from the authoritative ledger. Pending local rewards are labeled separately.</p>
      <div className="progression-range-filter" role="group" aria-label="Filter score history by date">
        {historyRanges.map(({ value, label }) => <button type="button" key={value} aria-pressed={historyRange === value} className={historyRange === value ? 'is-selected' : ''} onClick={() => changeHistoryRange(value)}>{label}</button>)}
      </div>
      {historyError && <div className="form-alert" role="alert"><div><span>{progressionFailureMessage(historyError).summary}</span><details className="progression-error-details"><summary>Technical details</summary><code>{historyError}</code></details></div><Button variant="secondary" size="small" onClick={() => void fetchHistoryPage(historyPage.rows.length ? Math.floor(historyPage.rows.length / historyPageSize) : 0, !historyPage.rows.length)}>Retry</Button></div>}
      {historyLoading && <p className="tracker-loading" role="status">Loading score history…</p>}
      {!historyLoading && !historyError && visibleHistory.length === 0 && pageData && <EmptyState title={pageData.overview.scoreHistory.length === 0 && pageData.overview.provisionalRewards.length === 0 && !historyPage.hasMore ? 'No score history yet' : 'No rewards in this period'} description="Confirmed rewards and eligible pending estimates will appear here." />}
      {visibleHistory.length > 0 && <ul className="progression-event-list progression-dialog-event-list">{visibleHistory.map((item) => <HistoryRow key={item.id} item={item} allEvents={pageData?.overview.scoreHistory ?? []} />)}</ul>}
      {historyPage.hasMore && <Button variant="secondary" disabled={historyLoading} onClick={() => void fetchHistoryPage(Math.floor(historyPage.rows.length / historyPageSize), false)}>{historyLoading ? 'Loading…' : 'Load more history'}</Button>}
      {pageData?.overview.provisionalXp ? <p className="progression-dialog-footnote">+{pageData.overview.provisionalXp.toLocaleString()} provisional XP is not in the confirmed total.</p> : null}
    </ProgressionDetailDialog>}

    {allBadgesOpen && pageData && <ProgressionDetailDialog title={selectedBadge ? achievementDefinition(selectedBadge.achievementId)?.name ?? 'Badge details' : 'All badges'} eyebrow="UNLOCKED COLLECTION" onClose={() => { setSelectedBadge(null); setAllBadgesOpen(false) }} onBack={selectedBadge ? () => setSelectedBadge(null) : undefined}>
      {selectedBadge ? <BadgeDetailContent badge={selectedBadge} /> : <>
      {pageData.overview.achievements.filter((badge) => badge.earned && activeAchievementOccurrences(badge.history).length > 0).length === 0
        ? <EmptyState title="Your badge shelf is ready" description="Badges will appear here after an achievement is confirmed." />
        : <div className="progression-unlocked-list">{pageData.overview.achievements.filter((badge) => badge.earned && activeAchievementOccurrences(badge.history).length > 0).map((badge) => {
          const definition = achievementDefinition(badge.achievementId)
          if (!definition) return null
          const occurrences = activeAchievementOccurrences(badge.history)
          return <button type="button" className="progression-unlocked-badge" key={badge.achievementId} onClick={() => setSelectedBadge(badge)}>
            <ProgressionBadge achievementId={badge.achievementId} tier={badge.repeatable ? Math.max(1, occurrences.length) : 1} />
            <span><strong>{definition.name}</strong>{badge.repeatable && <small>Earned {occurrences.length} {occurrences.length === 1 ? 'time' : 'times'}</small>}</span>
          </button>
        })}</div>}
      </>}
    </ProgressionDetailDialog>}

    {detail === 'consistency' && pageData && <ProgressionDetailDialog title="Consistency" eyebrow="ROLLING 30 ELIGIBLE DAYS" onClose={() => setDetail(null)}>
      <div className="progression-detail-score"><strong>{pageData.overview.consistency.score === null ? '—' : `${pageData.overview.consistency.score}%`}</strong><span>{consistencyContext}</span></div>
      <p className="progression-dialog-intro">Each eligible day contributes its completed trackers divided by eligible trackers. The score is the average across the most recent 30 eligible days.</p>
      {pageData.overview.consistency.dailyAdherence.length ? <div className="progression-consistency-list" aria-label="Recent daily adherence">
        {[...pageData.overview.consistency.dailyAdherence].reverse().map((day) => <div className="progression-consistency-day" key={day.date} aria-label={`${formatCalendarDate(day.date)}: ${day.completed} completed of ${day.eligible} eligible, ${Math.round(day.completed / day.eligible * 100)} percent`}>
          <span>{formatCalendarDate(day.date)}</span><span className="progression-consistency-track"><span style={{ width: `${Math.min(100, day.completed / day.eligible * 100)}%` }} /></span><strong>{day.completed}/{day.eligible}</strong>
        </div>)}
      </div> : <EmptyState title="No eligible days yet" description="Consistency becomes measurable after an eligible tracker day is completed and closed. Skips, future dates, and the still-open day do not count." />}
      <div className="progression-exclusion-note"><strong>What is excluded?</strong><p>Future dates and the still-open current day do not count. Days without an eligible tracker are omitted. Scheduled days, holidays, and Strict Mode follow your tracker settings.</p></div>
    </ProgressionDetailDialog>}

    {detail === 'streaks' && pageData && <ProgressionDetailDialog title="Streaks & recent activity" eyebrow="TRACKER MOMENTUM" onClose={() => setDetail(null)}>
      <div className="progression-streak-filter" role="group" aria-label="Filter streak history">
        {(['active', 'archived'] as const).map((filter) => <button type="button" key={filter} aria-pressed={streakFilter === filter} className={streakFilter === filter ? 'is-selected' : ''} onClick={() => setStreakFilter(filter)}>{filter === 'active' ? 'Active' : 'Archived'}</button>)}
      </div>
      {visibleStreaks.length === 0 ? <EmptyState title={streakFilter === 'active' ? 'No active trackers' : 'No archived tracker history'} description={streakFilter === 'active' ? 'Restore or create an active tracker to build a current streak.' : 'Archived trackers will appear here with their saved historical streaks.'} /> : <>
        <div className="progression-streak-summary">{streakFilter === 'active' ? <span><strong>{activeStreakCount}</strong> active streaks</span> : <span>Historical streaks from archived trackers</span>}<span><strong>{Math.max(0, ...visibleStreaks.map((item) => item.streak.longest))}</strong> longest streak</span></div>
        <div className="progression-streak-list">{visibleStreaks.map(({ tracker, streak }) => {
          const nextMilestone = PROGRESSION_REWARDS.streakMilestones.find((item) => item.days > streak.current)
          const reversedRewardIds = new Set(pageData.overview.scoreHistory.filter((event) => event.reasonCode === 'AWARD_REVERSAL' && event.reversesEventId).map((event) => event.reversesEventId))
          const earnedRewards = pageData.overview.streakHistory.filter((event) => event.trackerId === tracker.id && event.xpDelta > 0 && !reversedRewardIds.has(event.id))
          return <article className="progression-streak-card" key={tracker.id}><div><span className="tracker-kind-chip">{streakFilter === 'archived' ? 'Archived' : tracker.kind}</span><h3>{tracker.name}</h3></div><div className="progression-streak-values">{streakFilter === 'active' && <span><strong>{streak.current}</strong> current</span>}<span><strong>{streak.longest}</strong> longest</span></div>{streakFilter === 'active' && nextMilestone && <p>Next streak milestone: {streak.current} / {nextMilestone.days} days · {nextMilestone.xp} XP</p>}{streakFilter === 'archived' && <p>{streak.lastQualifiedDate ? `Last qualifying activity: ${formatCalendarDate(streak.lastQualifiedDate)}` : 'No qualifying activity recorded'}</p>}{earnedRewards.length > 0 && <div className="progression-earned-streaks" aria-label="Earned streak rewards">{earnedRewards.map((event) => <span key={event.id}>+{event.xpDelta} XP · {formatCalendarDate(event.effectiveDate)}</span>)}</div>}</article>
        })}</div>
        <h3 className="progression-subheading">Recent seven-day activity</h3>
        <ul className="progression-activity-list">{activity.map((day) => <li key={day.date}><time dateTime={day.date}>{formatCalendarDate(day.date)}</time><span>{day.completed} completed</span><span>{day.skipped} skipped</span><span>{day.missed} missed</span><span>{day.exempt} exempt</span></li>)}</ul>
        <p className="progression-dialog-footnote">A skip remains distinct from a completion. Exempt days include dates outside a tracker’s eligible schedule or active period.</p>
      </>}
    </ProgressionDetailDialog>}

    {detail === 'milestones' && pageData && <ProgressionDetailDialog title="Milestone rewards" eyebrow="CONFIRMED LEDGER" onClose={() => setDetail(null)}>
      <p className="progression-dialog-intro">Streak and goal milestone rewards shown here are confirmed server transactions. Reversals remain visible in score history.</p>
      {milestones.length ? <ul className="progression-event-list progression-dialog-event-list">{milestones.map((event) => <HistoryRow key={event.id} item={{ ...event, pending: false }} allEvents={pageData.overview.scoreHistory} />)}</ul> : <EmptyState title="No milestone rewards yet" description="Confirmed streak and goal milestones will appear here." />}
      <p className="progression-dialog-footnote">For live goal target progress and plan details, open <Link to="/goals" onClick={() => setDetail(null)}>Goals &amp; planning</Link>.</p>
    </ProgressionDetailDialog>}

    {selectedBadge && !allBadgesOpen && <BadgeDetailDialog badge={selectedBadge} onClose={() => setSelectedBadge(null)} />}
  </section>
}

type HistoryItem = ProgressionEvent & { pending: false } | { id: string; effectiveDate: string; xpDelta: number; displayName: string; pending: true }

function HistoryRow({ item, allEvents = [] }: { item: HistoryItem; allEvents?: ProgressionEvent[] }) {
  const event = 'reasonCode' in item ? item : null
  const reversed = event?.reversesEventId ? allEvents.find((candidate) => candidate.id === event.reversesEventId) : undefined
  const label = event ? eventLabel(event) : 'Pending check-in'
  const sourceName = event?.displayName && event.displayName !== 'Progression reward' ? event.displayName : item.displayName
  return <li className={`progression-event-row${item.pending ? ' is-pending' : ''}${item.xpDelta < 0 ? ' is-reversed' : ''}`}>
    <span className={`progression-event-icon${item.xpDelta < 0 ? ' is-reversal' : ''}`}><AppIcon name={item.xpDelta < 0 ? 'reset' : event ? eventIcon(event) : 'status-pending'} /></span>
    <span className="progression-event-copy"><strong>{label}</strong><span>{sourceName}</span>{event?.deletedTracker && <span className="progression-deleted-tracker-tag">Deleted tracker</span>}<time dateTime={item.effectiveDate}>{formatCalendarDate(item.effectiveDate)}</time>
      {reversed && <small className="progression-reversal-note">Reverses {eventLabel(reversed).toLowerCase()} from {formatCalendarDate(reversed.effectiveDate)}.</small>}
      {event?.reasonCode === 'LEGACY_XP_OPENING_BALANCE' && <small className="progression-reversal-note">XP reconstructed from past activity. This is an estimate, not a list of individual historical score events.</small>}
      {item.pending && <small className="progression-pending-note">Pending server confirmation</small>}
    </span>
    <strong className={`progression-event-xp${item.xpDelta < 0 ? ' is-negative' : ''}`}>{item.xpDelta > 0 ? '+' : ''}{item.xpDelta} XP</strong>
  </li>
}

function BadgeCard({ badge, onOpen }: { badge: AchievementState; onOpen: () => void }) {
  const definition = achievementDefinition(badge.achievementId)
  if (!definition) return null
  const repeatable = badge.repeatable
  const occurrences = activeAchievementOccurrences(badge.history)
  const earnedCount = badge.validAwardCount ?? occurrences.length
  const tier = badge.earned && repeatable ? Math.max(1, earnedCount) : badge.earned ? 1 : Math.max(1, badge.currentTier + 1)
  const periodProgress = ['perfect-week', 'perfect-month', 'perfect-year'].includes(badge.achievementId) && badge.qualificationDetails?.status === 'in_progress'
  const showMeter = !badge.earned && (periodProgress || !['perfect-day', 'perfect-week', 'perfect-month', 'perfect-year', 'the-comeback', 'milestone-maker', 'goal-crusher', 'consistency-star'].includes(badge.achievementId))
  const meterValue = periodProgress ? badge.qualificationDetails?.progress ?? 0 : badge.progress
  const meterTarget = periodProgress ? badge.qualificationDetails?.target ?? 1 : badge.target
  const meterPercent = meterTarget > 0 ? Math.min(100, Math.floor(meterValue / meterTarget * 100)) : 0
  return <div className="progression-badge-card-shell">
  <button type="button" className={`progression-badge-card${badge.earned ? ' is-earned' : ' is-locked'}`} onClick={onOpen} aria-label={`${definition.name}, ${badge.earned ? 'earned' : 'locked'}. View badge details`}>
    <ProgressionBadge achievementId={badge.achievementId} tier={tier} locked={!badge.earned} />
    <strong>{definition.name}</strong><span>{badge.earned ? 'Unlocked' : 'Locked'}</span>
    {badge.earned && repeatable && <small>Earned {earnedCount === 1 ? 'once' : `${earnedCount} times`}</small>}
    {!badge.earned && showMeter && <span className="progression-badge-meter"><span className="progression-level-track" role="progressbar" aria-label={`${definition.name} progress`} aria-valuenow={meterValue} aria-valuemin={0} aria-valuemax={meterTarget}><span style={{ width: `${meterPercent}%` }} /></span><small>{meterPercent}%</small></span>}
  </button>
  <InfoButton title={`${definition.name} badge information`} label={`More about ${definition.name}`} compact content={<BadgeInformation badge={badge} />} />
  </div>
}

function BadgeDetailDialog({ badge, onClose }: { badge: AchievementState; onClose: () => void }) {
  const definition = achievementDefinition(badge.achievementId)
  if (!definition) return null
  return <ProgressionDetailDialog title={definition.name} eyebrow="ACHIEVEMENT BADGE" onClose={onClose}><BadgeDetailContent badge={badge} /></ProgressionDetailDialog>
}

function BadgeDetailContent({ badge }: { badge: AchievementState }) {
  const definition = achievementDefinition(badge.achievementId)
  if (!definition) return null
  const repeatable = badge.repeatable
  const occurrences = activeAchievementOccurrences(badge.history)
  const earnedCount = badge.validAwardCount ?? occurrences.length
  const tier = badge.earned && repeatable ? Math.max(1, earnedCount) : Math.max(1, badge.currentTier + (badge.earned ? 0 : 1))
  const earnedDate = badgeEarnedDate(badge)
  const consistencyDetails = consistencyProgress(badge)
  return <>
    <div className="progression-badge-detail"><ProgressionBadge achievementId={badge.achievementId} tier={tier} locked={!badge.earned} size="large" /><div><span className={`progression-status-pill${badge.earned ? ' is-earned' : ''}`}>{badge.earned ? 'Unlocked' : 'Locked'}</span>{badge.earned && repeatable && <span className="progression-status-pill is-tier">Earned {earnedCount === 1 ? 'once' : `${earnedCount} times`}</span>}<p>{definition.description}</p></div></div>
    <div className="progression-badge-requirement"><strong>Unlock requirement</strong><p>{definition.requirement}</p></div>
    {badge.achievementId === 'consistency-star' && <div className="progression-badge-requirement progression-consistency-qualification"><strong>Qualification progress</strong>{consistencyDetails ? <><p>{consistencyDetails.eligibleDays}</p><p>{consistencyDetails.adherence}</p></> : <p>Authoritative qualification progress is unavailable.</p>}</div>}
    {badge.earned && earnedDate && <p className="progression-unlock-date">{repeatable ? `Most recent · ${formatCalendarDate(earnedDate)}` : `Originally earned · ${formatCalendarDate(earnedDate)}`}</p>}
    {badge.earned && repeatable && badge.firstEarnedAt && <p className="progression-unlock-date">First earned · {formatCalendarDate(badge.firstEarnedAt.slice(0, 10))}</p>}
    {badge.earned && repeatable && <ul className="progression-badge-earned-periods">{occurrences.map((event) => <li key={event.id}>{badgeOccurrencePeriod(badge, event)}</li>)}</ul>}
    <p className="progression-empty-inline">Badge unlocks do not add XP. XP changes are listed separately in your reward history.</p>
    {!badge.earned && !['perfect-day', 'perfect-week', 'perfect-month', 'the-comeback', 'milestone-maker', 'goal-crusher', 'consistency-star'].includes(badge.achievementId) && <div className="progression-badge-detail-progress"><div><span>Progress</span><strong>{achievementProgressLabel(badge, definition.progressUnit)}</strong></div><span className="progression-level-track"><span style={{ width: `${Math.min(100, badge.progress / badge.target * 100)}%` }} /></span></div>}
    {badge.qualificationDetails?.label && badge.achievementId !== 'consistency-star' && <div className="progression-badge-requirement"><strong>{badge.qualificationDetails.label}</strong><p>{badge.qualificationDetails.message}</p>{badge.qualificationDetails.status === 'in_progress' && badge.qualificationDetails.progress !== undefined && badge.qualificationDetails.target !== undefined && <span className="progression-level-track"><span style={{ width: `${Math.min(100, badge.qualificationDetails.progress / badge.qualificationDetails.target * 100)}%` }} /></span>}</div>}
    <h3 className="progression-subheading">Achievement history</h3>
    {badge.history.length ? <ul className="progression-badge-history">{[...new Map(badge.history.map((event) => [event.id, event])).values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map((event) => <li key={event.id}><span className={event.eventType === 'revoked' ? 'is-revoked' : ''}>{event.eventType === 'unlocked' ? 'Unlocked' : 'Revoked'} · {repeatable ? `Award ${event.tier}` : 'First award'}{event.retainedAfterTrackerDeletion ? ' · Retained historical achievement' : ''}{event.trackerDisplayName && <><br /><span>{event.trackerDisplayName}</span><span className="progression-deleted-tracker-tag">Deleted tracker</span><small className="progression-retained-reason">Earned for: {reasonCodeLabel(event.rewardReasonCode)}</small></>}</span><time dateTime={event.recordedAt}>{formatRecordedTimestamp(event.recordedAt)}</time></li>)}</ul> : <p className="progression-empty-inline">No confirmed unlock history yet.</p>}
  </>
}

function recentEvents(data: PageData): HistoryItem[] {
  const confirmed = data.overview.scoreHistory.map((event) => ({ ...event, pending: false as const }))
  const pending = data.overview.provisionalRewards.map((reward) => {
    const entryId = reward.id.slice('check-in:'.length)
    const entry = data.entries.find((item) => item.id === entryId)
    const tracker = entry ? data.trackers.find((item) => item.id === entry.trackerId) : undefined
    return { id: reward.id, effectiveDate: reward.effectiveDate, xpDelta: reward.xpDelta, displayName: tracker?.name ?? 'Pending check-in', pending: true as const }
  })
  return [...confirmed, ...pending].sort((left, right) => right.effectiveDate.localeCompare(left.effectiveDate))
}
