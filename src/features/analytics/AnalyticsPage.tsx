import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, insightsSectionTabs } from '../../components/ui/SectionTabs'
import { Surface } from '../../components/ui/Surface'
import { assertDateRange } from '../../db/calendarDate'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import type { CalendarDate } from '../../db/models'
import { calculateTrackerAnalytics } from '../../domain/trackers/analytics'
import { trackerEvaluationHistoryStartDate } from '../../domain/trackers/planning'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate, useWorkspaceCalendarDate } from '../shared/localDates'
import { useAuth } from '../auth/AuthProvider'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { TrackerFilter, useTrackerFilter } from '../shared/TrackerFilter'
import { InfoButton } from '../../components/ui/InfoButton'
import { activeAchievementOccurrences, getProgressionOverview, type ProgressionOverview } from '../../services/supabase/progressionRepository'

type PeriodMode = '7' | '30' | '90' | 'custom' | 'all'
type AppliedPeriod = { mode: PeriodMode; startDate?: CalendarDate; endDate?: CalendarDate }
type DateRange = { startDate: CalendarDate; endDate: CalendarDate }
type AnalyticsSnapshot = {
  workspaceKey: string
  trackers: Awaited<ReturnType<typeof localRepository.listTrackers>>
  entries: Awaited<ReturnType<typeof localRepository.listAllTrackerEntries>>
  holidays: Awaited<ReturnType<typeof localRepository.listAccountHolidays>>
  progression: ProgressionOverview | null
}

function periodStorageKey(workspaceId: string | null): string {
  return `progress-tracker-analytics-period:${workspaceId ?? 'guest'}`
}

function readAppliedPeriod(key: string, today: CalendarDate): AppliedPeriod {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as Partial<AppliedPeriod> | null
    if (value?.mode === '7' || value?.mode === '30' || value?.mode === '90' || value?.mode === 'all') return { mode: value.mode }
    if (value?.mode === 'custom' && typeof value.startDate === 'string' && typeof value.endDate === 'string') {
      assertDateRange(value.startDate, value.endDate)
      if (value.endDate <= today) return { mode: 'custom', startDate: value.startDate as CalendarDate, endDate: value.endDate as CalendarDate }
    }
  } catch { /* Session storage can be disabled or contain stale data. */ }
  return { mode: '30' }
}

function dateRangeForPeriod(period: AppliedPeriod, today: CalendarDate, trackers: AnalyticsSnapshot['trackers'], entries: AnalyticsSnapshot['entries'], progression: ProgressionOverview | null, timeZone: string): DateRange {
  if (period.mode === '7' || period.mode === '30' || period.mode === '90') {
    const length = Number(period.mode)
    return { startDate: shiftCalendarDate(today, -(length - 1)), endDate: today }
  }
  if (period.mode === 'custom' && period.startDate && period.endDate) return { startDate: period.startDate, endDate: period.endDate }

  // The report starts at the earliest locally retained tracker timeline or
  // account reward date, including archived tracker definitions and old rule versions.
  const candidates = [
    ...trackers.map((tracker) => trackerEvaluationHistoryStartDate(tracker, timeZone)),
    ...entries.map((entry) => entry.date),
    ...(progression?.scoreHistory.map((event) => event.effectiveDate) ?? []),
    ...(progression?.provisionalRewards.map((reward) => reward.effectiveDate) ?? []),
  ].filter((date) => date <= today)
  const earliest = candidates.sort((a, b) => a.localeCompare(b))[0] ?? today
  return { startDate: earliest as CalendarDate, endDate: today }
}

function inRange(date: string, range: DateRange, allTime: boolean, today: CalendarDate): boolean {
  return date <= today && (allTime || date >= range.startDate && date <= range.endDate)
}

type ActivityBucket = { key: string; startDate: CalendarDate; endDate: CalendarDate; label: string; count: number }

function calendarDaysBetween(startDate: CalendarDate, endDate: CalendarDate): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  return Math.floor((end - start) / 86_400_000) + 1
}

function activityBucketsForRange(
  entries: AnalyticsSnapshot['entries'],
  range: DateRange,
  trackerId: string | null,
): ActivityBucket[] {
  const totalDays = Math.max(1, calendarDaysBetween(range.startDate, range.endDate))
  const unit: 'day' | 'week' | 'month' = totalDays <= 35 ? 'day' : totalDays <= 180 ? 'week' : 'month'
  const buckets: ActivityBucket[] = []

  if (unit === 'month') {
    const [startYear, startMonth] = range.startDate.split('-').map(Number)
    let year = startYear!
    let month = startMonth!
    while (`${year}-${String(month).padStart(2, '0')}-01` <= range.endDate) {
      const monthStart = `${year}-${String(month).padStart(2, '0')}-01` as CalendarDate
      const nextMonthStart = month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`
      const monthEnd = shiftCalendarDate(nextMonthStart as CalendarDate, -1)
      const bucketStart = monthStart < range.startDate ? range.startDate : monthStart
      const bucketEnd = monthEnd > range.endDate ? range.endDate : monthEnd
      const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(`${monthStart}T00:00:00.000Z`))
      buckets.push({ key: `${year}-${String(month).padStart(2, '0')}`, startDate: bucketStart, endDate: bucketEnd, label: monthLabel, count: 0 })
      if (month === 12) { year += 1; month = 1 } else month += 1
    }
  } else {
    const step = unit === 'day' ? 1 : 7
    for (let offset = 0; offset < totalDays; offset += step) {
      const startDate = shiftCalendarDate(range.startDate, offset)
      const endDate = shiftCalendarDate(range.startDate, Math.min(totalDays - 1, offset + step - 1))
      buckets.push({
        key: startDate,
        startDate,
        endDate,
        label: calendarDateLabel(startDate, { month: 'short', day: 'numeric' }),
        count: 0,
      })
    }
  }

  const bucketByDate = new Map<string, ActivityBucket>()
  for (const bucket of buckets) {
    if (unit === 'month') bucketByDate.set(bucket.key, bucket)
    else {
      for (let date = bucket.startDate; date <= bucket.endDate; date = shiftCalendarDate(date, 1)) bucketByDate.set(date, bucket)
    }
  }
  for (const entry of entries) {
    if (entry.deletedAt !== null || entry.date < range.startDate || entry.date > range.endDate || trackerId && entry.trackerId !== trackerId) continue
    const key = unit === 'month' ? entry.date.slice(0, 7) : entry.date
    const bucket = bucketByDate.get(key)
    if (bucket) bucket.count += 1
  }
  return buckets
}

export function AnalyticsPage() {
  const { status: authStatus, user, workspaceStatus, workspaceUserId, sessionTransitionPending } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const today = useWorkspaceCalendarDate(timeZone)
  const expectedOwner = authStatus === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && authStatus !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === expectedOwner
  const workspaceKey = workspaceReady ? expectedOwner ?? 'guest' : null
  const filterKey = periodStorageKey(expectedOwner)
  const [periodState, setPeriodState] = useState(() => ({ key: filterKey, value: readAppliedPeriod(filterKey, localCalendarDate(new Date(), timeZone)) }))
  const appliedPeriod = periodState.key === filterKey ? periodState.value : { mode: '30' as const }
  const [customEditorOpen, setCustomEditorOpen] = useState(false)
  const [customDraft, setCustomDraft] = useState<DateRange>(() => ({
    startDate: shiftCalendarDate(localCalendarDate(new Date(), timeZone), -29),
    endDate: localCalendarDate(new Date(), timeZone),
  }))
  const [customRangeError, setCustomRangeError] = useState('')
  const trackerDetailsIdPrefix = useId()
  const workspaceRef = useRef({ key: workspaceKey, ready: workspaceReady })
  workspaceRef.current = { key: workspaceKey, ready: workspaceReady }
  const generationRef = useRef(0)
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ workspaceKey: string; message: string } | null>(null)

  useEffect(() => {
    if (periodState.key === filterKey) return
    setPeriodState({ key: filterKey, value: readAppliedPeriod(filterKey, today) })
    setCustomEditorOpen(false)
    setCustomRangeError('')
  }, [filterKey, periodState.key, today])

  const allTrackers = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.trackers : []
  const allEntries = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.entries : []
  const holidays = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.holidays : []
  const progression = workspaceKey && snapshot?.workspaceKey === workspaceKey ? snapshot.progression : null
  const visibleError = workspaceKey && error?.workspaceKey === workspaceKey ? error.message : ''
  const visibleLoading = loading || !workspaceReady || Boolean(workspaceKey && snapshot?.workspaceKey !== workspaceKey)
  const dateRange = useMemo(() => dateRangeForPeriod(appliedPeriod, today, allTrackers, allEntries, progression, timeZone), [appliedPeriod, today, allTrackers, allEntries, progression, timeZone])
  const allTime = appliedPeriod.mode === 'all'
  const holidayDates = useMemo(() => new Set(holidays.map((holiday) => holiday.date)), [holidays])
  const summaries = useMemo(() => allTrackers.map((tracker) =>
    calculateTrackerAnalytics(tracker, allEntries, dateRange.startDate, dateRange.endDate, holidayDates, timeZone, allEntries, today),
  ), [allTrackers, allEntries, dateRange, holidayDates, timeZone, today])
  const holidayCount = holidays.filter((holiday) => inRange(holiday.date, dateRange, allTime, today)).length
  const trackerFilter = useTrackerFilter(expectedOwner, summaries.map((summary) => summary.tracker), !visibleLoading)
  const selectedTracker = summaries.find((summary) => summary.tracker.id === trackerFilter.selectedId)?.tracker ?? null
  const visibleSummaries = selectedTracker ? summaries.filter((summary) => summary.tracker.id === selectedTracker.id) : summaries
  const [expansion, setExpansion] = useState<Record<string, boolean>>({})
  const previousSelectedId = useRef<string | null>(null)

  useEffect(() => {
    const previousId = previousSelectedId.current
    if (previousId === trackerFilter.selectedId) return
    previousSelectedId.current = trackerFilter.selectedId
    setExpansion((current) => {
      const next = { ...current }
      if (previousId) next[previousId] = false
      if (trackerFilter.selectedId) next[trackerFilter.selectedId] = true
      return next
    })
  }, [trackerFilter.selectedId])

  const refresh = useCallback(async () => {
    const currentWorkspace = workspaceRef.current
    if (!currentWorkspace.ready || !currentWorkspace.key) return
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const [trackers, entries, holidays, loadedProgression] = await Promise.all([
        localRepository.listTrackers(true),
        localRepository.listAllTrackerEntries(),
        localRepository.listAccountHolidays(),
        expectedOwner ? getProgressionOverview(expectedOwner).catch(() => null) : Promise.resolve(null),
      ])
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setSnapshot({ workspaceKey: currentWorkspace.key, trackers, entries, holidays, progression: loadedProgression })
      }
    } catch {
      if (generationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === currentWorkspace.key) {
        setError({ workspaceKey: currentWorkspace.key, message: 'Your analytics could not be loaded from this device.' })
      }
    } finally {
      if (generationRef.current === generation) setLoading(false)
    }
  }, [expectedOwner])

  useEffect(() => {
    if (!workspaceReady || !workspaceKey) {
      setLoading(true)
      return () => { generationRef.current += 1 }
    }
    void refresh()
    return () => { generationRef.current += 1 }
  }, [refresh, workspaceKey, workspaceReady])
  useWorkspaceDataChanges(expectedOwner, workspaceReady, refresh)

  function applyPeriod(value: AppliedPeriod) {
    const stored = { key: filterKey, value }
    setPeriodState(stored)
    try { window.sessionStorage.setItem(filterKey, JSON.stringify(value)) } catch { /* Keep the selected filter in memory if storage is unavailable. */ }
  }

  function choosePeriod(mode: PeriodMode) {
    setCustomRangeError('')
    if (mode === 'custom') {
      setCustomDraft(appliedPeriod.mode === 'custom' && appliedPeriod.startDate && appliedPeriod.endDate
        ? { startDate: appliedPeriod.startDate, endDate: appliedPeriod.endDate }
        : { startDate: shiftCalendarDate(today, -29), endDate: today })
      setCustomEditorOpen(true)
      return
    }
    setCustomEditorOpen(false)
    applyPeriod({ mode })
  }

  function cancelCustomRange() {
    setCustomEditorOpen(false)
    setCustomRangeError('')
  }

  function applyCustomRange() {
    try {
      assertDateRange(customDraft.startDate, customDraft.endDate)
      if (customDraft.endDate > today) throw new Error('The end date cannot be in the future.')
      applyPeriod({ mode: 'custom', ...customDraft })
      setCustomEditorOpen(false)
      setCustomRangeError('')
    } catch (cause) {
      setCustomRangeError(cause instanceof Error ? cause.message : 'Choose a valid date range.')
    }
  }

  const activeScheduled = visibleSummaries.filter((item) => item.scheduledCount !== null)
  const scheduledCount = activeScheduled.reduce((sum, item) => sum + (item.scheduledCount ?? 0), 0)
  const qualifiedScheduled = activeScheduled.reduce((sum, item) => sum + (item.scheduledQualifiedCount ?? 0), 0)
  const entriesCount = visibleSummaries.reduce((sum, item) => sum + item.entryCount, 0)
  const recordedCount = visibleSummaries.reduce((sum, item) => sum + item.recordedCount, 0)
  const qualifiedCount = visibleSummaries.reduce((sum, item) => sum + item.qualifiedCount, 0)
  const streakQualifiedCount = visibleSummaries.reduce((sum, item) => sum + item.streakQualifiedCount, 0)
  const consistency = scheduledCount ? Math.round(qualifiedScheduled / scheduledCount * 100) : null
  const successRate = recordedCount ? Math.round(qualifiedCount / recordedCount * 100) : null
  const periodEvents = progression?.scoreHistory.filter((event) => inRange(event.effectiveDate, dateRange, allTime, today)) ?? []
  const periodProvisional = progression?.provisionalRewards.filter((reward) => inRange(reward.effectiveDate, dateRange, allTime, today)) ?? []
  const entriesById = useMemo(() => new Map(allEntries.map((entry) => [entry.id, entry])), [allEntries])
  const accountXp = progression
    ? allTime ? progression.confirmedXp + progression.provisionalXp : periodEvents.reduce((sum, event) => sum + event.xpDelta, 0) + periodProvisional.reduce((sum, reward) => sum + reward.xpDelta, 0)
    : null
  const trackerAttributedXp = progression ? periodEvents.filter((event) => event.trackerId !== null).reduce((sum, event) => sum + event.xpDelta, 0) + periodProvisional.filter((reward) => Boolean(entriesById.get(reward.id.replace(/^check-in:/, ''))?.trackerId)).reduce((sum, reward) => sum + reward.xpDelta, 0) : null
  const selectedTrackerXp = progression && selectedTracker ? periodEvents.filter((event) => event.trackerId === selectedTracker.id).reduce((sum, event) => sum + event.xpDelta, 0) + periodProvisional.filter((reward) => entriesById.get(reward.id.replace(/^check-in:/, ''))?.trackerId === selectedTracker.id).reduce((sum, reward) => sum + reward.xpDelta, 0) : null
  const otherAccountXp = accountXp === null || trackerAttributedXp === null ? null : accountXp - trackerAttributedXp
  const accountXpOutsideSelectedTracker = accountXp === null || selectedTrackerXp === null ? null : accountXp - selectedTrackerXp
  const totalXp = progression ? allTime ? accountXp : progression.confirmedXp + progression.provisionalXp : null
  const earnedBadges = progression ? selectedTracker ? progression.achievements.reduce((count, achievement) => {
    const active = activeAchievementOccurrences(achievement.history)
    const attributed = active.filter((event) => event.sourceEventId && progression.scoreHistory.some((score) => score.id === event.sourceEventId && score.trackerId === selectedTracker.id))
    return count + attributed.length
  }, 0) : progression.achievements.filter((achievement) => achievement.earned).length : null
  const hasNoCheckIns = entriesCount === 0
  const hasNoOpportunities = scheduledCount === 0
  const hasNoMetricObservations = visibleSummaries.every((summary) => summary.metrics.every((metric) => metric.observationCount === 0))
  const hasLifetimeActivity = visibleSummaries.some((summary) => summary.lifetimeEntryCount > 0)
  const customRangeIsPending = customEditorOpen
  const periodControlValue = customRangeIsPending ? 'custom' : appliedPeriod.mode
  const displayedRange = allTime
    ? `All available history through ${calendarDateLabel(today, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : `${calendarDateLabel(dateRange.startDate, { month: 'short', day: 'numeric', year: 'numeric' })} – ${calendarDateLabel(dateRange.endDate, { month: 'short', day: 'numeric', year: 'numeric' })}`
  const activityBuckets = useMemo(() => activityBucketsForRange(allEntries, dateRange, selectedTracker?.id ?? null), [allEntries, dateRange, selectedTracker?.id])
  const activityMax = Math.max(1, ...activityBuckets.map((bucket) => bucket.count))
  const activityLabelStep = Math.max(1, Math.ceil(activityBuckets.length / 6))
  const activityTicks = activityBuckets.filter((_, index) => index % activityLabelStep === 0 || index === activityBuckets.length - 1)
  const currentStreak = selectedTracker
    ? selectedTracker.status === 'active' ? visibleSummaries.find((summary) => summary.tracker.id === selectedTracker.id)?.currentStreak ?? null : null
    : Math.max(0, ...visibleSummaries.filter((summary) => summary.tracker.status === 'active').map((summary) => summary.currentStreak))
  const longestStreak = Math.max(0, ...visibleSummaries.map((summary) => summary.longestStreak))
  const activityGranularity = activityBuckets.length <= 35 ? 'daily' : activityBuckets.length <= 180 ? 'weekly' : 'monthly'

  return <section className="tracker-page analytics-page insights-page" aria-labelledby="analytics-title">
    <PageHeader headingId="analytics-title" eyebrow="YOUR PATTERNS" title="Analytics" description="Understand your activity, consistency, and progress over time." help={{ title: 'Analytics', summary: 'Statistics follow the tracker selector and selected date range.', description: 'All Trackers adds comparable counts such as check-ins and eligible opportunities while keeping metric values separate because units can differ. Individual Tracker recalculates counts and trends using only that tracker. Scheduled opportunities and consistency include active trackers only. Archived tracker cards show retained historical values and saved check-ins, but do not contribute to current completion or opportunity statistics. Holidays and rest days are excluded in Standard Mode and required in Strict Mode. XP remains account-scoped where labeled.' }} />
    <SectionTabs label="Insights sections" items={insightsSectionTabs} />
    <div className="analytics-toolbar">
      <TrackerFilter trackers={summaries.map((summary) => summary.tracker)} selectedId={trackerFilter.selectedId} onChange={trackerFilter.select} label="Tracker" />
      <div className="analytics-period-control" role="group" aria-label="Period">
        {([['7', '7D'], ['30', '30D'], ['90', '90D'], ['custom', 'Custom'], ['all', 'All Time']] as const).map(([mode, label]) => <button type="button" key={mode} aria-pressed={periodControlValue === mode} onClick={() => choosePeriod(mode)}>{label}</button>)}
      </div>
      <div className="analytics-range" aria-live="polite" aria-label={`Analytics date range: ${displayedRange}`}><AppIcon name="calendar" /><span>{displayedRange}</span></div>
    </div>
    {customRangeIsPending && <fieldset className="analytics-custom-range">
      <legend>Choose a custom date range</legend>
      <p>Both dates are included. Select dates up to today; your current report stays in place until you apply.</p>
      <div className="analytics-custom-range-fields">
        <label className="history-filter"><span>Start date</span><input className="auth-input" type="date" value={customDraft.startDate} max={today} onChange={(event) => { setCustomDraft((current) => ({ ...current, startDate: event.target.value as CalendarDate })); setCustomRangeError('') }} /></label>
        <label className="history-filter"><span>End date</span><input className="auth-input" type="date" value={customDraft.endDate} min={/^\d{4}-\d{2}-\d{2}$/.test(customDraft.startDate) ? customDraft.startDate : undefined} max={today} onChange={(event) => { setCustomDraft((current) => ({ ...current, endDate: event.target.value as CalendarDate })); setCustomRangeError('') }} /></label>
      </div>
      {customRangeError && <p className="analytics-custom-range-error" role="alert">{customRangeError}</p>}
      <div className="analytics-custom-range-actions"><Button variant="secondary" onClick={cancelCustomRange}>Cancel</Button><Button onClick={applyCustomRange}>Apply range</Button></div>
    </fieldset>}
    {visibleError && <div role="alert" className="form-alert">{visibleError}</div>}
    {visibleLoading ? <p role="status" className="tracker-loading">Loading your analytics…</p> : visibleError ? <Surface><EmptyState title="Your activity is still saved" description="This device could not open your workspace analytics." action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>} /></Surface> : summaries.length === 0 ? <Surface><EmptyState title="Analytics start with your first tracker" description="Create a tracker and log activity to see consistency and metric trends here." action={<Link className="button button-primary button-medium" to="/trackers/new">Create a tracker</Link>} /></Surface> : <>
      <div className="analytics-summary-groups" role="group" aria-label="Period summary">
        <AnalyticsGroup title="Overall Progress" ariaLabel="Activity" className="analytics-summary-activity" helpTitle="Overall Progress" helpSummary="Check-ins and successful check-ins for the selected range." helpDescription="Counts the latest saved recorded and intentionally skipped entries. Successful check-ins met each tracker’s configured Success Rule. In All Trackers, counts add across trackers; the same date can contribute one entry per tracker.">
          <AnalyticsStat label="Check-ins" value={entriesCount} />
          <AnalyticsStat label="Successful check-ins" value={qualifiedCount} detail={recordedCount ? `of ${recordedCount} recorded` : 'no recorded check-ins'} />
          <div className="analytics-success-meter" role="img" aria-label={successRate === null ? 'Success rate unavailable because there are no recorded check-ins.' : `Success rate ${successRate} percent, ${qualifiedCount} successful out of ${recordedCount} recorded check-ins.`}>
            <div className="analytics-success-ring" aria-hidden="true" style={{ '--success-angle': `${(successRate ?? 0) * 3.6}deg` } as CSSProperties}>
              <strong>{successRate === null ? '—' : `${successRate}%`}</strong><small>Success rate</small>
            </div>
          </div>
        </AnalyticsGroup>
        {progression && <AnalyticsGroup title="XP & Rewards" className="analytics-summary-rewards" helpTitle="XP & Rewards" helpSummary="Account XP and earned badges." helpContent={<div className="analytics-xp-information">
          <p>Total XP is account-wide, including confirmed XP and any pending check-in rewards. XP this period is the net of confirmed rewards and pending estimates dated in the selected range.</p>
          <dl>
            <div><dt>Account XP in selected range</dt><dd>{accountXp ?? '—'}</dd></div>
            <div><dt>Tracker-attributed XP</dt><dd>{trackerAttributedXp ?? '—'}</dd></div>
            <div><dt>Account-wide or unattributed XP</dt><dd>{otherAccountXp ?? '—'}</dd></div>
            {selectedTracker && <><div><dt>Selected tracker XP</dt><dd>{selectedTrackerXp ?? '—'}</dd></div><div><dt>Account XP outside selected tracker</dt><dd>{accountXpOutsideSelectedTracker ?? '—'}</dd></div></>}
          </dl>
          <p>Rewards may be linked to a tracker, account-wide, retained after tracker deletion, or have older unattributed history. The tracker filter does not change the account-wide XP total. Badge counts show active badge types for the account or active linked award occurrences for the selected tracker.</p>
        </div>}>
          <AnalyticsStat label="Total XP" value={totalXp ?? '—'} />
          <AnalyticsStat label="Badges earned" value={earnedBadges ?? '—'} />
          {!allTime && <p className="analytics-period-xp-note">{accountXp ?? '—'} XP this period</p>}
          <Link className="analytics-rewards-link" to="/achievements">View Wins <AppIcon name="chevron-down" /></Link>
        </AnalyticsGroup>}
        <AnalyticsGroup title="Consistency" className="analytics-summary-consistency" helpTitle="Consistency" helpSummary="Streaks and scheduled progress follow tracker rules." helpDescription={`Current streak uses the workspace time zone; the selected date filter does not change current streaks. Consistency is successful eligible opportunities divided by elapsed eligible opportunities (${qualifiedScheduled} of ${scheduledCount}). Streak-qualified tracker dates (${streakQualifiedCount}) use each tracker’s Streak Rule, separately from Success Rule matches and success rate. In All Trackers, one calendar date can count once for each qualifying tracker. Standard Mode excludes rest days and holidays; Strict Mode includes active calendar dates. An unlogged today remains open.`}>
          <AnalyticsStat label="Current streak" value={currentStreak === null ? '—' : `${currentStreak} ${currentStreak === 1 ? 'day' : 'days'}`} />
          <AnalyticsStat label="Longest streak" value={`${longestStreak} ${longestStreak === 1 ? 'day' : 'days'}`} />
          <p className="analytics-consistency-context">{consistency === null ? 'Consistency unavailable' : `${consistency}% consistency · ${qualifiedScheduled}/${scheduledCount} opportunities`}</p>
        </AnalyticsGroup>
      </div>
      <Surface className="analytics-activity-card" aria-labelledby="analytics-activity-title">
        <header className="analytics-activity-heading"><div><div className="analytics-activity-title-line"><AppIcon name="insights" /><h2 id="analytics-activity-title">Activity</h2></div><p>{activityGranularity[0]!.toUpperCase() + activityGranularity.slice(1)} check-ins in the selected range</p></div><InfoButton title="Activity chart" summary="Saved check-ins by date, grouped to fit the selected range." description="Bars count saved tracker entries, including intentionally skipped entries. Long ranges are grouped by week or calendar month. Use the data list below the chart to review exact bucket dates and counts." compact /></header>
        {activityBuckets.every((bucket) => bucket.count === 0)
          ? <p className="analytics-activity-empty">No activity to plot in this range.</p>
          : <>
            <div className="analytics-activity-chart" role="img" aria-label={`${activityGranularity} activity chart, ${entriesCount} check-ins in the selected range, with a maximum of ${activityMax} in one ${activityGranularity === 'daily' ? 'day' : activityGranularity === 'weekly' ? 'week' : 'month'}.`}>
              <div className="analytics-chart-scale" aria-hidden="true"><span>{activityMax}</span><span>{Math.ceil(activityMax / 2)}</span><span>0</span></div>
              <div className="analytics-chart-plot" aria-hidden="true">{activityBuckets.map((bucket) => <div className="analytics-chart-column" key={bucket.key}><span className="analytics-chart-bar" style={{ height: `${bucket.count ? Math.max(5, bucket.count / activityMax * 100) : 0}%` }} /></div>)}</div>
              <div className="analytics-chart-ticks" aria-hidden="true">{activityTicks.map((bucket) => <span key={bucket.key}>{bucket.label}</span>)}</div>
            </div>
            <details className="analytics-activity-data"><summary>View activity dates and values</summary><ul>{activityBuckets.map((bucket) => <li key={bucket.key}><span>{bucket.startDate === bucket.endDate ? calendarDateLabel(bucket.startDate, { dateStyle: 'medium' }) : `${calendarDateLabel(bucket.startDate, { month: 'short', day: 'numeric', year: 'numeric' })} – ${calendarDateLabel(bucket.endDate, { month: 'short', day: 'numeric', year: 'numeric' })}`}</span><strong>{bucket.count} {bucket.count === 1 ? 'check-in' : 'check-ins'}</strong></li>)}</ul></details>
          </>}
      </Surface>
      <div className="analytics-context-summary" role="group" aria-label="Period context">
        <span>Holidays <strong>{holidayCount}</strong></span>
        <InfoButton title="Holidays" label="About the holiday count" compact summary="Account-wide marked holidays in the selected range." description="Marked holidays are account-wide settings. They pause Standard Mode streaks; Strict Mode still requires qualifying activity on those dates." />
        {(hasNoCheckIns || hasNoOpportunities || hasNoMetricObservations && recordedCount === 0) && <p role="status">
          {hasNoCheckIns && hasNoOpportunities
            ? `No check-ins or scheduled opportunities in this range.${hasLifetimeActivity ? ' Tracker activity exists outside this range.' : hasNoMetricObservations ? ' Metric trends will appear when this range contains recorded values.' : ''}`
            : hasNoCheckIns
              ? `No check-ins in this range.${hasLifetimeActivity ? ' Tracker activity exists outside this range.' : ' An unlogged current day remains open; earlier eligible opportunities are counted after they close.'}${hasNoMetricObservations ? ' Metric trends will appear when this range contains recorded values.' : ''}`
              : hasNoOpportunities ? `No scheduled opportunities for active trackers in this range; consistency is undefined.${hasNoMetricObservations && recordedCount === 0 ? ' No recorded metric values are available in this range.' : ''}` : 'No recorded metric values in this range. Trends appear when recorded entries include values.'}
        </p>}
      </div>
      <div className="analytics-trackers">
        {visibleSummaries.map((summary) => {
          const expanded = expansion[summary.tracker.id] ?? Boolean(selectedTracker && selectedTracker.id === summary.tracker.id)
          const detailsId = `${trackerDetailsIdPrefix}-${encodeURIComponent(summary.tracker.id)}`
          return <Surface className="analytics-tracker" key={summary.tracker.id}>
            <header className="analytics-tracker-heading">
              <div><span className="tracker-kind-chip">{summary.tracker.status}</span><h2>{summary.tracker.name}</h2></div>
              <button type="button" className="analytics-tracker-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpansion((current) => ({ ...current, [summary.tracker.id]: !expanded }))}>
                <span>{expanded ? 'Hide details' : 'Show details'}</span><AppIcon name="chevron-down" />
              </button>
            </header>
            <dl className="analytics-collapsed-stats">
              <div><dt>Recorded</dt><dd>{summary.recordedCount}</dd></div>
              <div><dt>Skipped</dt><dd>{summary.skippedCount}</dd></div>
              <div><dt>Current streak</dt><dd>{summary.currentStreak}</dd></div>
            </dl>
            {summary.entryCount === 0 && summary.lifetimeEntryCount > 0 && <p className="analytics-outside-range">No entries in this range · {summary.lifetimeEntryCount} lifetime entries</p>}
            <div id={detailsId} className="analytics-tracker-details" hidden={!expanded}>
              {expanded && <>
              <dl className="analytics-tracker-stats">
                <div><dt><span>Recorded in range</span></dt><dd>{summary.recordedCount}</dd></div>
                <div><dt><span>Skipped in range</span></dt><dd>{summary.skippedCount}</dd></div>
                <div><dt><span>Recorded lifetime</span></dt><dd>{summary.lifetimeRecordedCount}</dd></div>
                <div><dt><span>Skipped lifetime</span></dt><dd>{summary.lifetimeSkippedCount}</dd></div>
                <div><dt><span>Current streak</span><InfoButton title="Current streak" summary="Consecutive qualifying opportunities up to today." description="Uses only this tracker’s Streak Rule and scheduling policy. Success Rule-only dates do not advance it. This lifetime measure remains anchored to today even when the report uses an earlier custom range." compact /></dt><dd>{summary.currentStreak}</dd></div>
                <div><dt><span>Longest streak</span><InfoButton title="Longest streak" summary="The longest qualifying run in this tracker’s history." description="The longest run of this tracker’s Streak Rule across its active dates. Historical edits are reflected after local and server reconciliation." compact /></dt><dd>{summary.longestStreak}</dd></div>
                <div><dt><span>Scheduling opportunities</span></dt><dd>{summary.scheduledCount === null ? 'Inactive for consistency' : summary.scheduledCount === 0 ? 'No elapsed opportunities' : `${summary.scheduledCount} elapsed opportunities in range`}</dd></div>
                {summary.historicalCount > 0 && <div><dt><span>Historical entries excluded in range</span></dt><dd>{summary.historicalCount}</dd></div>}
              </dl>
              {summary.scheduledCount !== null && summary.consistencyPercent !== null && <p className="analytics-consistency">{summary.scheduledQualifiedCount} of {summary.scheduledCount} scheduled opportunities met the Success Rule · {summary.consistencyPercent}% consistency in this range.</p>}
              {summary.metrics.length > 0 && <div className="analytics-metrics">
                {summary.metrics.map((metricSummary) => {
                  const { metric, observations } = metricSummary
                  const visibleObservations = observations.slice(-14)
                  const maxValue = Math.max(1, ...visibleObservations.map((item) => item.value))
                  const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
                  const latest = metricSummary.latestValue
                  return <section className="analytics-metric" key={metric.id} aria-label={`${metric.name} analysis`}>
                    <div className="analytics-metric-heading"><h3>{metric.name}</h3><span>{metricSummary.observationCount} values in range{metricSummary.averageValue === null ? '' : ` · average ${formatTrackerNumber(metricSummary.averageValue)}${unit}`}</span></div>
                    {visibleObservations.length === 0 ? hasNoMetricObservations && recordedCount === 0 ? null : <p className="analytics-empty-metric">No values recorded in this range.</p> : <>
                      <p className="analytics-latest">Latest in range: {latest === null ? '—' : metric.valueType === 'boolean' ? latest : formatTrackerNumber(latest)}{latest === null ? '' : unit}{metric.valueType === 'boolean' && latest !== null ? latest === 1 ? ' · yes' : ' · no' : ''}</p>
                      <div className="analytics-value-chart" aria-hidden="true">
                        {visibleObservations.map((item) => <span key={item.date} style={{ height: `${Math.max(5, item.value / maxValue * 100)}%` }} />)}
                      </div>
                      <p className="analytics-chart-caption">Each bar is one day’s value; the latest {visibleObservations.length} values are listed below. The chart does not add values across dates.</p>
                      <MetricDailyValues metricName={metric.name} valueType={metric.valueType} unit={unit} observations={visibleObservations} />
                    </>}
                  </section>
                })}
              </div>}
              </>}
            </div>
          </Surface>
        })}
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

function AnalyticsGroup({ title, ariaLabel, className, helpTitle, helpSummary, helpDescription, helpContent, children }: { title: string; ariaLabel?: string; className: string; helpTitle: string; helpSummary: string; helpDescription?: string; helpContent?: ReactNode; children: ReactNode }) {
  const headingId = useId()
  return <Surface role="group" className={`analytics-summary-group ${className}`} aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : headingId}>
    <header className="analytics-summary-group-heading"><h2 id={headingId}>{title}</h2><InfoButton title={helpTitle} summary={helpSummary} description={helpDescription} content={helpContent} compact /></header>
    <div className="analytics-summary-list">{children}</div>
  </Surface>
}

function AnalyticsStat({ label, value, detail }: { label: string; value: number | string; detail?: string }) {
  return <div className="analytics-summary-stat">
    <span className="analytics-summary-label">{label}</span>
    <strong>{value}</strong>
    {detail && <small>{detail}</small>}
  </div>
}
