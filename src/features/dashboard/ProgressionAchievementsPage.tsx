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
import { activeAchievementOccurrences, fullyReversedProgressionEventIds, getProgressionHistory, getProgressionOverview, invalidateProgressionOverview, type AchievementState, type ProgressionEvent, type ProgressionOverview } from '../../services/supabase/progressionRepository'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { achievementDefinition, achievementRewardExplanation } from './achievementCatalog'
import { calendarBadgeProgress, type CalendarBadgeProgress } from './calendarBadgeProgress'
import { ProgressionBadge } from './ProgressionBadge'
import { ProgressionDetailDialog } from './ProgressionDetailDialog'
import { InfoButton } from '../../components/ui/InfoButton'
import { countDevPerformance, measureDevPerformance } from '../../utils/devPerformance'
import { trackerStrictModeForDate } from '../../domain/trackers/ruleVersions'

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
const winsPageCache = new Map<string, PageData>()

export function clearProgressionPageCache(ownerUserId?: string): void {
  if (ownerUserId) winsPageCache.delete(ownerUserId)
  else winsPageCache.clear()
}
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

export function XpInformation({ overview }: { overview: ProgressionOverview }) {
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
  const entryByTrackerDate = new Map(data.entries.map((entry) => [`${entry.trackerId}:${entry.date}`, entry]))
  return Array.from({ length: 7 }, (_, index) => shiftCalendarDate(today as CalendarDate, index - 7)).map((date) => {
    const activity: LocalActivity = { date, completed: 0, skipped: 0, missed: 0, exempt: 0 }
    for (const tracker of trackers) {
      if (isArchivedTracker(tracker) && tracker.archivedAt && date >= localCalendarDate(new Date(tracker.archivedAt), timeZone)) continue
      const inPeriod = isTrackerInActivePeriod(tracker, date, timeZone)
      const isEligible = inPeriod && (trackerStrictModeForDate(tracker, date) || (!data.holidays.has(date) && isTrackerScheduledOccurrence(tracker, date, timeZone)))
      if (!isEligible) { activity.exempt += 1; continue }
      const entry = entryByTrackerDate.get(`${tracker.id}:${date}`)
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
  const [pageData, setPageData] = useState<PageData | null>(() => owner ? winsPageCache.get(owner) ?? null : null)
  const initialLoadMeasure = useRef<(() => void) | null>(null)
  if (!initialLoadMeasure.current) initialLoadMeasure.current = measureDevPerformance('wins.initial-data-to-render')
  const pageDataRef = useRef(pageData)
  pageDataRef.current = pageData
  const [loading, setLoading] = useState(() => Boolean(owner && !winsPageCache.has(owner)))
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRange, setHistoryRange] = useState<HistoryRange>('7')
  const [showReversedTransactions, setShowReversedTransactions] = useState(false)
  const [historyPage, setHistoryPage] = useState<HistoryPage>({ rows: [], hasMore: false })
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [detail, setDetail] = useState<Detail>(null)
  const [streakFilter, setStreakFilter] = useState<StreakFilter>('active')
  const [selectedBadge, setSelectedBadge] = useState<AchievementState | null>(null)
  const [allBadgesOpen, setAllBadgesOpen] = useState(false)
  const recentUnlocksRef = useRef<HTMLDivElement>(null)
  const [recentUnlockScroll, setRecentUnlockScroll] = useState({ hasOverflow: false, canScrollLeft: false, canScrollRight: false })
  const refreshGeneration = useRef(0)
  const historyGeneration = useRef(0)
  const previousOwner = useRef(owner)

  useEffect(() => {
    if (!pageData || !initialLoadMeasure.current) return
    initialLoadMeasure.current()
    initialLoadMeasure.current = null
  }, [pageData])

  useEffect(() => {
    if (previousOwner.current && previousOwner.current !== owner) {
      winsPageCache.delete(previousOwner.current)
      invalidateProgressionOverview(previousOwner.current)
    }
    previousOwner.current = owner
    historyGeneration.current += 1
    const cached = owner ? winsPageCache.get(owner) ?? null : null
    pageDataRef.current = cached
    setPageData(cached)
    setLoading(Boolean(owner && !cached))
    setRefreshing(false)
    setHistoryOpen(false)
    setShowReversedTransactions(false)
    setHistoryPage({ rows: [], hasMore: false })
    setHistoryError('')
    setDetail(null)
    setSelectedBadge(null)
  }, [owner])

  const refresh = useCallback(async (forceServerRefresh = false) => {
    if (!owner || !workspaceReady) return
    const measure = measureDevPerformance('wins.page-refresh-to-render-data')
    countDevPerformance(forceServerRefresh ? 'wins.page-server-refresh' : 'wins.page-local-refresh')
    const generation = ++refreshGeneration.current
    const hasVisibleData = pageDataRef.current !== null
    setLoading(!hasVisibleData)
    setRefreshing(hasVisibleData)
    setError('')
    try {
      const trackers = (await localRepository.listTrackers(true)).filter((tracker) => tracker.deletedAt === null && ['active', 'archived'].includes(tracker.status))
      const earliest = trackers.reduce<CalendarDate>((value, tracker) => {
        const start = trackerActiveStartDate(tracker, timeZone) as CalendarDate
        return start < value ? start : value
      }, today as CalendarDate)
      const [overview, entries, holidays] = await Promise.all([
        getProgressionOverview(owner, { forceRefresh: forceServerRefresh }),
        trackers.length ? localRepository.listTrackerEntriesBetween(earliest, today) : Promise.resolve([]),
        localRepository.listAccountHolidays(earliest, today),
      ])
      if (refreshGeneration.current === generation) {
        const next = { overview, trackers, entries, holidays: new Set(holidays.map((holiday) => holiday.date)) }
        pageDataRef.current = next
        winsPageCache.set(owner, next)
        setPageData(next)
      }
    } catch (cause) {
      if (refreshGeneration.current === generation) setError(progressionFailureMessage(cause).detail)
    } finally {
      if (refreshGeneration.current === generation) { setLoading(false); setRefreshing(false) }
      measure()
    }
  }, [owner, today, timeZone, workspaceReady])

  useEffect(() => {
    if (workspaceReady) void refresh(true)
    else { setLoading(false); setPageData(null) }
    return () => { refreshGeneration.current += 1 }
  }, [refresh, workspaceReady])
  const refreshLocalSnapshot = useCallback(() => { void refresh(false) }, [refresh])

  const entriesByTracker = useMemo(() => {
    const grouped = new Map<string, StoredTrackerEntry[]>()
    for (const entry of pageData?.entries ?? []) {
      const group = grouped.get(entry.trackerId)
      if (group) group.push(entry)
      else grouped.set(entry.trackerId, [entry])
    }
    return grouped
  }, [pageData?.entries])
  const streaks = useMemo(() => pageData?.trackers.map((tracker) => ({
    tracker,
    streak: calculateStreak(tracker, entriesByTracker.get(tracker.id) ?? [], today, pageData.holidays, timeZone),
  })) ?? [], [pageData, entriesByTracker, today, timeZone])
  const activeTrackers = useMemo(() => pageData?.trackers.filter(isActiveTracker) ?? [], [pageData])
  const archivedTrackers = useMemo(() => pageData?.trackers.filter(isArchivedTracker) ?? [], [pageData])
  const hasQualifiedOpenDay = Boolean(pageData && activeTrackers.some((tracker) => {
    if (!isTrackerInActivePeriod(tracker, today, timeZone) || !trackerStrictModeForDate(tracker, today) && (pageData.holidays.has(today) || !isTrackerScheduledOccurrence(tracker, today, timeZone))) return false
    const entry = entriesByTracker.get(tracker.id)?.find((item) => item.date === today)
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
  const recentUnlocks = useMemo(() => {
    const byAchievement = new Map<string, { badge: AchievementState; event: AchievementState['history'][number] }>()
    for (const badge of pageData?.overview.achievements ?? []) {
      if (!badge.earned) continue
      const event = activeAchievementOccurrences(badge.history).sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id)).at(-1)
      if (!event) continue
      const existing = byAchievement.get(badge.achievementId)
      if (!existing || event.recordedAt > existing.event.recordedAt || event.recordedAt === existing.event.recordedAt && event.id > existing.event.id) byAchievement.set(badge.achievementId, { badge, event })
    }
    return [...byAchievement.values()]
      .filter(({ badge }) => Boolean(achievementDefinition(badge.achievementId)))
      .sort((left, right) => right.event.recordedAt.localeCompare(left.event.recordedAt) || left.badge.achievementId.localeCompare(right.badge.achievementId))
  }, [pageData])
  const calendarBadgeProgressById = useMemo(() => {
    if (!pageData) return new Map<string, CalendarBadgeProgress>()
    const reversedEventIds = fullyReversedProgressionEventIds(pageData.overview.scoreHistory)
    const confirmedPerfectDayDates = new Set(pageData.overview.scoreHistory
      .filter((event) => event.reasonCode === 'PERFECT_DAY_BONUS' && event.xpDelta > 0 && !reversedEventIds.has(event.id))
      .map((event) => event.effectiveDate))
    const perfectMonthHistory = pageData.overview.achievements.find((badge) => badge.achievementId === 'perfect-month')?.history ?? []
    return new Map(['perfect-week', 'perfect-month', 'perfect-year'].flatMap((achievementId) => {
      const badge = pageData.overview.achievements.find((item) => item.achievementId === achievementId)
      const progress = calendarBadgeProgress({
        achievementId,
        today,
        confirmedPerfectDayDates,
        perfectMonthHistory,
        qualificationStatus: badge?.qualificationDetails?.status,
      })
      return progress ? [[achievementId, progress] as const] : []
    }))
  }, [pageData, today])
  const updateRecentUnlockScroll = useCallback(() => {
    const element = recentUnlocksRef.current
    if (!element) return
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
    setRecentUnlockScroll((current) => {
      const next = { hasOverflow: maxScrollLeft > 1, canScrollLeft: element.scrollLeft > 1, canScrollRight: element.scrollLeft < maxScrollLeft - 1 }
      return current.hasOverflow === next.hasOverflow && current.canScrollLeft === next.canScrollLeft && current.canScrollRight === next.canScrollRight ? current : next
    })
  }, [])
  useEffect(() => {
    const element = recentUnlocksRef.current
    if (!element) return
    updateRecentUnlockScroll()
    element.addEventListener('scroll', updateRecentUnlockScroll, { passive: true })
    window.addEventListener('resize', updateRecentUnlockScroll)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateRecentUnlockScroll)
    observer?.observe(element)
    if (element.firstElementChild) observer?.observe(element.firstElementChild)
    return () => {
      element.removeEventListener('scroll', updateRecentUnlockScroll)
      window.removeEventListener('resize', updateRecentUnlockScroll)
      observer?.disconnect()
    }
  }, [recentUnlocks.length, updateRecentUnlockScroll])
  const scrollRecentUnlocks = (direction: -1 | 1) => {
    const element = recentUnlocksRef.current
    if (element) {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      element.scrollBy({ left: direction * Math.max(180, element.clientWidth * 0.8), behavior: reducedMotion ? 'auto' : 'smooth' })
    }
  }
  const activeStreakCount = streaks.filter((item) => isActiveTracker(item.tracker) && item.streak.current > 0).length
  const currentStreakDays = activeTrackers.length ? Math.max(0, ...streaks.filter(({ tracker }) => isActiveTracker(tracker)).map(({ streak }) => streak.current)) : null

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
  const refreshConfirmedSnapshot = useCallback(() => {
    void refresh(true)
    if (historyOpen) {
      setHistoryPage({ rows: [], hasMore: false })
      void fetchHistoryPage(0, true)
    }
  }, [refresh, historyOpen, fetchHistoryPage])

  const reversedTransactionIds = useMemo(() => fullyReversedProgressionEventIds(pageData?.overview.scoreHistory ?? []), [pageData?.overview.scoreHistory])

  const visibleHistory = useMemo(() => {
    if (!pageData) return []
    const start = historyRange === 'all' ? null : shiftCalendarDate(today as CalendarDate, -(Number(historyRange) - 1))
    const confirmed = historyPage.rows.filter((event) => event.effectiveDate <= today && (!start || event.effectiveDate >= start)
      && (showReversedTransactions || !reversedTransactionIds.has(event.id)))
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
  }, [historyPage.rows, historyRange, pageData, today, showReversedTransactions, reversedTransactionIds])

  useWorkspaceDataChanges(owner, workspaceReady, refreshLocalSnapshot, true, refreshConfirmedSnapshot)

  if (status === 'loading' || sessionTransitionPending || loading && workspaceReady) {
    return <section className="tracker-page progression-page insights-page" aria-labelledby="achievements-title"><WinsPageHeader /><SectionTabs label="Insights sections" items={insightsSectionTabs} /><p role="status" className="tracker-loading">Loading your confirmed progress…</p></section>
  }

  if (!owner) {
    return <section className="tracker-page progression-page insights-page" aria-labelledby="achievements-title"><WinsPageHeader /><SectionTabs label="Insights sections" items={insightsSectionTabs} /><Surface><EmptyState title="Sign in to view your rewards" description="Confirmed XP and achievement unlocks are securely stored with your account." action={<Link className="button button-primary button-medium" to="/auth">Open account</Link>} /></Surface></section>
  }

  return <section className="tracker-page progression-page insights-page" aria-labelledby="achievements-title">
    <WinsPageHeader />
    <SectionTabs label="Insights sections" items={insightsSectionTabs} />
    {error && <div role="alert" className="form-alert progression-error"><div><span>{pageData ? `Could not refresh progression data. Cards below show the last server-confirmed state. ${progressionFailureMessage(error).summary}` : progressionFailureMessage(error).summary}</span><details className="progression-error-details"><summary>Technical details</summary><code>{progressionFailureMessage(error).detail}</code></details></div><Button variant="secondary" size="small" onClick={() => void refresh(true)}>Try again</Button></div>}
    {refreshing && <p role="status" className="progression-refresh-indicator">Refreshing confirmed Wins…</p>}
    {pageData && (syncStatus === 'waiting' || syncStatus === 'syncing' || syncStatus === 'offline' || syncStatus === 'error' || !isOnline) && <p className="progression-sync-note" role={syncStatus === 'error' ? 'alert' : 'status'}>
      {syncStatus === 'error'
        ? 'Sync needs attention. Wins below show the last server-confirmed state; recent changes may not be included.'
        : syncStatus === 'syncing'
          ? 'Checking for account changes. Wins below show the latest server-confirmed state.'
          : 'Changes saved on this device are waiting to sync. Wins below show the latest server-confirmed state.'}
    </p>}
    {!workspaceReady && !error ? <p role="status" className="tracker-loading">Opening your account workspace…</p> : pageData && <>
      <section className="progression-overview" aria-labelledby="progression-overview-title">
        <section className="progression-level-card-shell" aria-label="Level progress">
          <div className="progression-xp-header"><h2 id="progression-overview-title">Level progress</h2><div><span className="progression-level-pill">LEVEL {pageData.overview.officialLevel.level}</span><InfoButton title="How XP and levels work" label="XP and level information" compact content={<XpInformation overview={pageData.overview} />} /></div></div>
          <button type="button" className="progression-level-card" onClick={openHistory} aria-label={`Level ${pageData.overview.officialLevel.level}: ${pageData.overview.officialLevel.progressXp} of ${pageData.overview.officialLevel.requiredXp} XP toward the next level. Open score history`}>
            <span className="progression-level-detail"><strong>{pageData.overview.officialLevel.progressXp.toLocaleString()}</strong><span>of {pageData.overview.officialLevel.requiredXp.toLocaleString()} XP to next level</span></span>
            {pageData.overview.legacyXpStatus === 'reconstructed' && <span className="progression-history-estimate">XP reconstructed from past activity</span>}
            {(pageData.overview.legacyXpStatus === 'unavailable' || pageData.overview.legacyXpStatus === 'legacy_fallback') && <span className="progression-history-unavailable">Historical XP unavailable</span>}
            {pageData.overview.legacyXpStatus === 'pending' && <span className="progression-history-unavailable">Historical XP is being prepared</span>}
            <span className="progression-level-track" role="progressbar" aria-label="Progress to next level" aria-valuenow={pageData.overview.officialLevel.progressXp} aria-valuemin={0} aria-valuemax={pageData.overview.officialLevel.requiredXp}><span style={{ width: `${Math.min(100, pageData.overview.officialLevel.progressXp / pageData.overview.officialLevel.requiredXp * 100)}%` }} /></span>
            <span className="progression-level-caption">{(pageData.overview.officialLevel.nextLevelXp - pageData.overview.confirmedXp).toLocaleString()} XP to Level {pageData.overview.officialLevel.level + 1}</span>
            {pageData.overview.provisionalXp > 0 && <span className="progression-pending-line"><AppIcon name="status-pending" /> +{pageData.overview.provisionalXp.toLocaleString()} XP pending sync</span>}
            {syncStatus === 'error' && <span className="progression-pending-note">Sync needs attention. Pending rewards are not included above.</span>}
            {(pageData.overview.provisionalXp > 0 && (!isOnline || syncStatus === 'offline' || syncStatus === 'waiting')) && <span className="progression-pending-note">Saved on this device; confirmation will follow when synchronization completes.</span>}
          </button>
        </section>
        <section className={`progression-recent-unlocks${recentUnlocks.length ? '' : ' is-empty'}`} aria-labelledby="progression-recent-unlocks-title">
          <div className="progression-recent-unlocks-heading"><h3 id="progression-recent-unlocks-title">Recently Achieved</h3><div className="progression-recent-unlocks-actions">
            {recentUnlockScroll.hasOverflow && <div className="progression-recent-unlocks-scroll-actions" role="group" aria-label="Scroll recent badges">
              <button type="button" aria-label="Scroll recent badges left" disabled={!recentUnlockScroll.canScrollLeft} onClick={() => scrollRecentUnlocks(-1)}><AppIcon name="chevron-down" /></button>
              <button type="button" aria-label="Scroll recent badges right" disabled={!recentUnlockScroll.canScrollRight} onClick={() => scrollRecentUnlocks(1)}><AppIcon name="chevron-down" /></button>
            </div>}
            <button type="button" className="progression-text-button" onClick={() => { setSelectedBadge(null); setAllBadgesOpen(true) }}>See All Badges</button>
          </div></div>
          {recentUnlocks.length
            ? <div className={`progression-recent-unlocks-grid${recentUnlocks.length === 1 ? ' is-single' : ''}${recentUnlockScroll.canScrollRight ? ' has-more-right' : ''}`} ref={recentUnlocksRef} role="region" aria-label="Recent badges" tabIndex={0} onKeyDown={(keyboardEvent) => {
              if (keyboardEvent.key !== 'ArrowLeft' && keyboardEvent.key !== 'ArrowRight') return
              keyboardEvent.preventDefault()
              scrollRecentUnlocks(keyboardEvent.key === 'ArrowLeft' ? -1 : 1)
            }}>{recentUnlocks.map(({ badge, event }) => {
              const definition = achievementDefinition(badge.achievementId)!
              const earnedCount = badge.validAwardCount ?? activeAchievementOccurrences(badge.history).length
              const earnedDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone }).format(new Date(event.recordedAt))
              return <button type="button" key={badge.achievementId} aria-label={`${definition.name}, achieved ${earnedDate}. Open badge details`} onClick={() => setSelectedBadge(badge)}>
                <ProgressionBadge achievementId={badge.achievementId} tier={badge.repeatable ? Math.max(1, earnedCount) : 1} />
                <span><strong>{definition.name}</strong><small>Achieved {earnedDate}</small></span>
              </button>
            })}</div>
            : <p>Your first confirmed badge will appear here when earned.</p>}
        </section>
        <section className="progression-activity" aria-labelledby="progression-activity-title">
          <div className="progression-activity-heading"><div><h2 id="progression-activity-title">30-Day Activity</h2><p>30-day consistency: {pageData.overview.consistency.score === null ? '—' : `${pageData.overview.consistency.score}%`} · {consistencyContext}</p></div><button type="button" className="progression-text-button" aria-label={`30-day account consistency ${pageData.overview.consistency.score ?? 'not available'}, view details`} onClick={() => setDetail('consistency')}>View details <AppIcon name="chevron-down" /></button></div>
          <div className="progression-activity-grid">
            <button type="button" className="progression-activity-stat" onClick={() => setDetail('streaks')} aria-label={currentStreakDays === null ? 'No active trackers for a current streak. Open tracker streak details' : `Current streak ${currentStreakDays} ${currentStreakDays === 1 ? 'day' : 'days'} across active trackers. Open tracker streak details`}>
              <span><AppIcon name="habit" /></span><small>Current streak</small><strong>{currentStreakDays === null ? '—' : `${currentStreakDays} ${currentStreakDays === 1 ? 'day' : 'days'}`}</strong>
            </button>
            <button type="button" className="progression-activity-stat" onClick={openHistory} aria-label={`${pageData.overview.confirmedXp.toLocaleString()} confirmed XP at level ${pageData.overview.officialLevel.level}. Total lifetime XP. Open score history`}>
              <span><AppIcon name="spark" /></span><small>Total XP</small><strong>{pageData.overview.confirmedXp.toLocaleString()}</strong>
            </button>
          </div>
          <p className="progression-insights-link">See period tracker details in <Link to="/analytics">Insights</Link>.</p>
        </section>
        <section className="progression-explore" aria-labelledby="progression-explore-title">
          <h2 id="progression-explore-title">Explore Wins</h2>
          <div className="progression-explore-list">
            <button type="button" className="progression-detail-card" onClick={() => setDetail('milestones')}><span className="progression-detail-symbol is-gold"><AppIcon name="spark" /></span><span><strong>Milestones</strong><small>{milestones.length} milestone rewards · streak and goal awards</small></span><AppIcon className="progression-detail-chevron" name="chevron-down" /></button>
            <Link className="progression-detail-card" to="/achievements/challenges"><span className="progression-detail-symbol"><AppIcon name="habit" /></span><span><strong>Tracker challenges</strong><small>Per-tracker streaks and earned milestones</small></span><AppIcon className="progression-detail-chevron" name="chevron-down" /></Link>
          </div>
        </section>
      </section>
    </>}

    {historyOpen && <ProgressionDetailDialog title="Score history" eyebrow="CONFIRMED REWARDS" onClose={() => setHistoryOpen(false)}>
      <p className="progression-dialog-intro">Every listed XP change comes from the authoritative ledger. Pending local rewards are labeled separately.</p>
      <div className="progression-range-filter" role="group" aria-label="Filter score history by date">
        {historyRanges.map(({ value, label }) => <button type="button" key={value} aria-pressed={historyRange === value} className={historyRange === value ? 'is-selected' : ''} onClick={() => changeHistoryRange(value)}>{label}</button>)}
      </div>
      <label className="progression-history-toggle"><input type="checkbox" checked={showReversedTransactions} onChange={(event) => setShowReversedTransactions(event.target.checked)} /><span>Show reversed transactions</span></label>
      {historyError && <div className="form-alert" role="alert"><div><span>{progressionFailureMessage(historyError).summary}</span><details className="progression-error-details"><summary>Technical details</summary><code>{historyError}</code></details></div><Button variant="secondary" size="small" onClick={() => void fetchHistoryPage(historyPage.rows.length ? Math.floor(historyPage.rows.length / historyPageSize) : 0, !historyPage.rows.length)}>Retry</Button></div>}
      {historyLoading && <p className="tracker-loading" role="status">Loading score history…</p>}
      {!historyLoading && !historyError && visibleHistory.length === 0 && pageData && <EmptyState
        title={pageData.overview.scoreHistory.length === 0 && pageData.overview.provisionalRewards.length === 0 && !historyPage.hasMore ? 'No score history yet' : 'No rewards in this period'}
        description={!showReversedTransactions && historyPage.rows.some((event) => reversedTransactionIds.has(event.id))
          ? 'Fully reversed transactions are hidden. Turn on “Show reversed transactions” to review them.'
          : 'Confirmed rewards and eligible pending estimates will appear here.'}
      />}
      {visibleHistory.length > 0 && <ul className="progression-event-list progression-dialog-event-list">{visibleHistory.map((item) => <HistoryRow key={item.id} item={item} allEvents={pageData?.overview.scoreHistory ?? []} />)}</ul>}
      {historyPage.hasMore && <Button variant="secondary" disabled={historyLoading} onClick={() => void fetchHistoryPage(Math.floor(historyPage.rows.length / historyPageSize), false)}>{historyLoading ? 'Loading…' : 'Load more history'}</Button>}
      {pageData?.overview.provisionalXp ? <p className="progression-dialog-footnote">+{pageData.overview.provisionalXp.toLocaleString()} provisional XP is not in the confirmed total.</p> : null}
    </ProgressionDetailDialog>}

    {allBadgesOpen && pageData && <ProgressionDetailDialog title={selectedBadge ? achievementDefinition(selectedBadge.achievementId)?.name ?? 'Badge details' : 'All badges'} eyebrow="BADGE COLLECTION" onClose={() => { setSelectedBadge(null); setAllBadgesOpen(false) }} onBack={selectedBadge ? () => setSelectedBadge(null) : undefined}>
      {selectedBadge ? <BadgeDetailContent badge={selectedBadge} trackers={pageData?.trackers ?? []} calendarProgress={calendarBadgeProgressById.get(selectedBadge.achievementId)} /> : <>
      {pageData.overview.achievements.length === 0
        ? <EmptyState title="Your badge shelf is ready" description="Badges will appear here when achievement data is available." />
        : <div className="progression-badge-grid">{pageData.overview.achievements.map((badge) => <BadgeCard key={badge.achievementId} badge={badge} calendarProgress={calendarBadgeProgressById.get(badge.achievementId)} onOpen={() => setSelectedBadge(badge)} />)}</div>}
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

    {selectedBadge && !allBadgesOpen && <BadgeDetailDialog badge={selectedBadge} trackers={pageData?.trackers ?? []} calendarProgress={calendarBadgeProgressById.get(selectedBadge.achievementId)} onClose={() => setSelectedBadge(null)} />}
  </section>
}

function WinsPageHeader() {
  return <PageHeader headingId="achievements-title" eyebrow="YOUR ACHIEVEMENTS" title="Wins" description="Your earned badges, milestones, and progress." help={{ title: 'Wins', summary: 'Review your level, confirmed XP, achievements, and tracker milestones.', description: 'Rewards and badge history come from your signed-in account. Pending offline XP stays labeled until sync confirms it.' }} />
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

function BadgeInformation({ badge, calendarProgress }: { badge: AchievementState; calendarProgress?: CalendarBadgeProgress }) {
  const definition = achievementDefinition(badge.achievementId)
  if (!definition) return null
  const details = badge.qualificationDetails ?? {}
  const progress = Number.isFinite(details.progress) ? details.progress! : badge.progress
  const target = Number.isFinite(details.target) && details.target! > 0 ? details.target! : badge.target
  const periodBadge = ['perfect-week', 'perfect-month', 'perfect-year'].includes(badge.achievementId)
  const canShowProgress = !periodBadge && !badge.earned && (details.status === 'in_progress' || badge.target > 0)
  const percentage = canShowProgress && target > 0 ? Math.min(100, Math.floor(progress / target * 100)) : null
  const occurrences = activeAchievementOccurrences(badge.history)
  return <div className="badge-information">
    <p>{definition.description}</p><strong>Unlock requirement</strong><p>{definition.requirement}</p>
    {definition.attribution === 'account' && <p className="progression-achievement-attribution">Account-wide achievement{badge.achievementId === 'perfect-day' ? ' · This achievement considers all eligible trackers for that date.' : ''}</p>}
    {definition.attribution === 'account' && <p className="progression-achievement-attribution">Account-wide achievement{badge.achievementId === 'perfect-day' ? ' · This achievement considers all eligible trackers for that date.' : ''}</p>}
    {badge.earned && badge.repeatable && <p>{occurrences.length} active confirmed {occurrences.length === 1 ? 'occurrence' : 'occurrences'}.</p>}
    {badge.earned && occurrences.length > 0 && <ul className="badge-information-dates">{occurrences.map((event) => <li key={event.id}>{badgeOccurrencePeriod(badge, event)}</li>)}</ul>}
    {calendarProgress && <CalendarBadgeProgressView achievementName={definition.name} progress={calendarProgress} />}
    {!badge.earned && details.label && !(periodBadge && ['unavailable', 'waiting', 'in_progress'].includes(details.status ?? '')) && <><strong>{details.label}</strong><p>{details.message ?? qualificationStatusLabel(details.status)}</p></>}
    {!badge.earned && !details.label && !periodBadge && <p>Current progress: {progress.toLocaleString()} / {target.toLocaleString()} {definition.progressUnit}.</p>}
    {canShowProgress && percentage !== null && <><div className="badge-information-progress-label"><span>{progress.toLocaleString()} / {target.toLocaleString()}</span><strong>{percentage}%</strong></div><span className="progression-level-track" role="progressbar" aria-label={`${definition.name} qualification progress`} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={target}><span style={{ width: `${percentage}%` }} /></span></>}
    {periodBadge && details.status !== 'unavailable' && details.period_start && details.period_end && <p>Period: {formatCalendarDate(details.period_start)} – {formatCalendarDate(details.period_end)} (account timezone)</p>}
    <BadgeRewardExplanation achievementId={badge.achievementId} />
  </div>
}

function BadgeRewardExplanation({ achievementId }: { achievementId: AchievementState['achievementId'] }) {
  const explanation = achievementRewardExplanation(achievementId)
  return explanation ? <div className="progression-badge-reward-rule"><strong>Related XP</strong><p>{explanation}</p></div> : null
}

function qualificationStatusLabel(status: string | undefined) {
  if (status === 'failed' || status === 'ineligible') return 'This period was not achieved.'
  if (status === 'unavailable' || status === 'waiting') return 'Awaiting reliable confirmation.'
  if (status === 'qualified') return 'Period completed and qualified.'
  return 'Current period is still in progress.'
}

function CalendarBadgeProgressView({ achievementName, progress }: { achievementName: string; progress: CalendarBadgeProgress }) {
  const percentage = Math.min(100, Math.floor(progress.progress / progress.target * 100))
  return <div className="progression-calendar-progress">
    <strong>Current confirmed progress</strong>
    <p>{progress.label}</p>
    {progress.secondaryLabel && <p>{progress.secondaryLabel}</p>}
    <span className="progression-level-track" role="progressbar" aria-label={`${achievementName} confirmed calendar progress`} aria-valuenow={progress.progress} aria-valuemin={0} aria-valuemax={progress.target} aria-valuetext={progress.label}><span style={{ width: `${percentage}%` }} /></span>
    <p className="progression-calendar-progress-note">Progress counts confirmed Perfect Days; badge unlocks still require the full calendar period.</p>
    {progress.unavailableMessage && <p className="progression-calendar-progress-note">{progress.unavailableMessage}</p>}
  </div>
}

function BadgeCard({ badge, calendarProgress, onOpen }: { badge: AchievementState; calendarProgress?: CalendarBadgeProgress; onOpen: () => void }) {
  const definition = achievementDefinition(badge.achievementId)
  if (!definition) return null
  const occurrences = activeAchievementOccurrences(badge.history)
  const earnedCount = badge.validAwardCount ?? occurrences.length
  const earned = badge.earned && earnedCount > 0
  const tier = earned && badge.repeatable ? Math.max(1, earnedCount) : earned ? 1 : Math.max(1, badge.currentTier + 1)
  const details = badge.qualificationDetails
  const periodBadge = ['perfect-week', 'perfect-month', 'perfect-year'].includes(badge.achievementId)
  const unavailable = !calendarProgress && (details?.status === 'unavailable' || details?.status === 'waiting' || periodBadge)
  let meterValue = details?.progress ?? badge.progress
  let meterTarget = details?.target ?? badge.target
  if (calendarProgress) {
    meterValue = calendarProgress.progress
    meterTarget = calendarProgress.target
  }
  if (badge.achievementId === 'consistency-star' && Number.isFinite(details?.eligible_days) && Number.isFinite(details?.eligible_days_target) && details!.eligible_days_target! > 0) {
    const eligiblePercent = details!.eligible_days! / details!.eligible_days_target! * 100
    const adherencePercent = Number.isFinite(details?.adherence_percent) && Number.isFinite(details?.adherence_target_percent) && details!.adherence_target_percent! > 0
      ? details!.adherence_percent! / details!.adherence_target_percent! * 100
      : 0
    meterValue = Math.min(eligiblePercent, adherencePercent)
    meterTarget = 100
  }
  const percentageAvailable = Boolean(calendarProgress) || earned || !unavailable && Number.isFinite(meterValue) && Number.isFinite(meterTarget) && meterTarget > 0
  const meterPercent = calendarProgress ? Math.min(100, Math.max(0, Math.floor(meterValue / meterTarget * 100))) : earned ? 100 : percentageAvailable ? Math.min(100, Math.max(0, Math.floor(meterValue / meterTarget * 100))) : null
  const visibleProgressLabel = calendarProgress?.label.replace(/ confirmed days$/, ' days') ?? (meterPercent === null ? '—' : `${meterPercent}%`)
  const statusLabel = earned ? earnedCount > 1 ? `Unlocked (${earnedCount})` : 'Unlocked' : 'Locked'
  return <div className="progression-badge-card-shell">
    <button type="button" className={`progression-badge-card${earned ? ' is-earned' : ' is-locked'}`} onClick={onOpen} aria-label={`${definition.name}, ${earned ? `earned, ${statusLabel.toLowerCase()}` : 'locked'}, ${calendarProgress?.label ?? (meterPercent === null ? 'progress unavailable' : `${meterPercent}% progress`)}. View badge details`}>
      <ProgressionBadge achievementId={badge.achievementId} tier={tier} locked={!earned} />
      <strong>{definition.name}</strong><span>{statusLabel}</span>
      <span className={`progression-badge-percent${meterPercent === null ? ' is-unavailable' : ''}`} aria-label={calendarProgress?.label ?? (meterPercent === null ? 'Progress unavailable' : `${meterPercent}% progress`)}>{visibleProgressLabel}</span>
    </button>
    <InfoButton title={`${definition.name} badge information`} label={`More about ${definition.name}`} compact content={<BadgeInformation badge={badge} calendarProgress={calendarProgress} />} />
  </div>
}

function BadgeDetailDialog({ badge, trackers, calendarProgress, onClose }: { badge: AchievementState; trackers: StoredTrackerDefinition[]; calendarProgress?: CalendarBadgeProgress; onClose: () => void }) {
  const definition = achievementDefinition(badge.achievementId)
  if (!definition) return null
  return <ProgressionDetailDialog title={definition.name} eyebrow="ACHIEVEMENT BADGE" onClose={onClose}><BadgeDetailContent badge={badge} trackers={trackers} calendarProgress={calendarProgress} /></ProgressionDetailDialog>
}

function BadgeDetailContent({ badge, trackers, calendarProgress }: { badge: AchievementState; trackers: StoredTrackerDefinition[]; calendarProgress?: CalendarBadgeProgress }) {
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
    {definition.attribution === 'account' && <div className="progression-badge-requirement progression-achievement-attribution"><strong>Account-wide achievement</strong>{badge.achievementId === 'perfect-day' && <p>This achievement considers all eligible trackers for that date.</p>}</div>}
    {calendarProgress && <div className="progression-badge-requirement progression-calendar-progress"><strong>Current confirmed progress</strong><p>{calendarProgress.label}</p>{calendarProgress.secondaryLabel && <p>{calendarProgress.secondaryLabel}</p>}<span className="progression-level-track" role="progressbar" aria-label={`${definition.name} confirmed calendar progress`} aria-valuenow={calendarProgress.progress} aria-valuemin={0} aria-valuemax={calendarProgress.target} aria-valuetext={calendarProgress.label}><span style={{ width: `${Math.min(100, calendarProgress.progress / calendarProgress.target * 100)}%` }} /></span><p className="progression-calendar-progress-note">Progress counts confirmed Perfect Days; badge unlocks still require the full calendar period.</p>{calendarProgress.unavailableMessage && <p className="progression-calendar-progress-note">{calendarProgress.unavailableMessage}</p>}</div>}
    {badge.achievementId === 'consistency-star' && <div className="progression-badge-requirement progression-consistency-qualification"><strong>Qualification progress</strong>{consistencyDetails ? <><p>{consistencyDetails.eligibleDays}</p><p>{consistencyDetails.adherence}</p></> : <p>Authoritative qualification progress is unavailable.</p>}</div>}
    {badge.earned && earnedDate && !repeatable && <p className="progression-unlock-date">Earned · {formatCalendarDate(earnedDate)}</p>}
    {badge.earned && repeatable && <div className="progression-badge-occurrence-summary"><strong>{occurrences.length} confirmed unlock{occurrences.length === 1 ? '' : 's'}</strong><ul className="progression-badge-earned-periods">{occurrences.map((event) => <li key={event.id}>{badgeOccurrencePeriod(badge, event)}</li>)}</ul></div>}
    <BadgeRewardExplanation achievementId={badge.achievementId} />
    {!badge.earned && !['perfect-day', 'perfect-week', 'perfect-month', 'perfect-year', 'the-comeback', 'milestone-maker', 'goal-crusher', 'consistency-star'].includes(badge.achievementId) && <div className="progression-badge-detail-progress"><div><span>Progress</span><strong>{achievementProgressLabel(badge, definition.progressUnit)}</strong></div><span className="progression-level-track"><span style={{ width: `${Math.min(100, badge.progress / badge.target * 100)}%` }} /></span></div>}
    {badge.qualificationDetails?.label && badge.achievementId !== 'consistency-star' && !['perfect-week', 'perfect-month', 'perfect-year'].includes(badge.achievementId) && <div className="progression-badge-requirement"><strong>{badge.qualificationDetails.label}</strong><p>{badge.qualificationDetails.message}</p>{badge.qualificationDetails.status === 'in_progress' && badge.qualificationDetails.progress !== undefined && badge.qualificationDetails.target !== undefined && <span className="progression-level-track"><span style={{ width: `${Math.min(100, badge.qualificationDetails.progress / badge.qualificationDetails.target * 100)}%` }} /></span>}</div>}
    <h3 className="progression-subheading">Achievement history</h3>
    {badge.history.length ? <ul className="progression-badge-history">{[...new Map(badge.history.map((event) => [event.id, event])).values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map((event) => {
      const attribution = achievementAttribution(badge.achievementId, event, trackers)
      return <li key={event.id}><span className={event.eventType === 'revoked' ? 'is-revoked' : ''}>{event.eventType === 'unlocked' ? 'Unlocked' : 'Revoked'} · {repeatable ? `Award ${event.tier}` : 'First award'}{event.retainedAfterTrackerDeletion ? ' · Retained historical achievement' : ''}{attribution && <><br /><span>{attribution.name}</span>{attribution.deleted && <span className="progression-deleted-tracker-tag">Deleted tracker</span>}{attribution.archived && <span className="progression-archived-tracker-tag">Archived tracker</span>}<small className="progression-retained-reason">Earned for: {reasonCodeLabel(event.rewardReasonCode)}</small></>}</span><time dateTime={event.recordedAt}>{formatRecordedTimestamp(event.recordedAt)}</time></li>
    })}</ul> : <p className="progression-empty-inline">No confirmed unlock history yet.</p>}
  </>
}

function achievementAttribution(achievementId: AchievementState['achievementId'], event: AchievementState['history'][number], trackers: StoredTrackerDefinition[]) {
  const definition = achievementDefinition(achievementId)
  if (!definition || definition.attribution === 'account') return null
  if (event.trackerDeleted) return { name: event.trackerDisplayName ?? 'Tracker unavailable', deleted: true, archived: false }
  const tracker = event.trackerId ? trackers?.find((candidate) => candidate.id === event.trackerId) : undefined
  if (tracker) return { name: tracker.name, deleted: false, archived: tracker.status === 'archived' }
  return { name: 'Tracker unavailable', deleted: false, archived: false }
}

