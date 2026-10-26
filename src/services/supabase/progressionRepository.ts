import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { openDatabase } from '../../db/database'
import { getSupabaseClient } from './client'
import { localCalendarDate } from '../../features/shared/localDates'
import { evaluateTrackerEntry, isTrackerInActivePeriod, isTrackerScheduledOccurrence, trackerActiveStartDate } from '../../domain/trackers/planning'
import { hasPositiveProgress } from '../../domain/trackers/activityStatus'
import { trackerStrictModeForDate } from '../../domain/trackers/ruleVersions'
import { calculateProgressionLevel, selectProvisionalRewards, summarizeProgression, type ProvisionalReward } from '../../domain/trackers/progressionModel'
import { subscribeToWorkspaceDataChanges, subscribeToWorkspaceSyncPreparation } from '../../db/workspaceMutationEvents'
import { countDevPerformance, measureDevPerformance } from '../../utils/devPerformance'

const pageSize = 500

type ConfirmedOverview = Pick<ProgressionOverview, 'legacyXpStatus' | 'confirmedXp' | 'officialLevel' | 'scoreHistory' | 'streakHistory' | 'achievements'>
const confirmedOverviewCache = new Map<string, ConfirmedOverview>()
const overviewRequests = new Map<string, { version: number; promise: Promise<ConfirmedOverview> }>()
const qualificationRefreshRequests = new Map<string, Promise<void>>()
const overviewVersions = new Map<string, number>()

export type ProgressionEvent = {
  id: string
  userId: string
  effectiveDate: string
  recordedAt: string
  xpDelta: number
  eventCategory: string
  reasonCode: string
  reversesEventId: string | null
  sourceId: string | null
  trackerId: string | null
  goalId: string | null
  displayName: string
  deletedTracker: boolean
}

export type AchievementProgress = {
  achievementId: string
  progress: number
  target: number
  currentTier: number
  repeatable: boolean
  sourceEventId: string | null
  sourceDate: string | null
  updatedAt: string
  qualificationDetails?: AchievementQualificationDetails
}

export type AchievementQualificationDetails = {
  status?: 'in_progress' | 'qualified' | 'ineligible' | 'failed' | 'unavailable' | 'waiting' | 'recovery_possible' | 'episode_confirmed'
  label?: string
  message?: string
  progress?: number
  target?: number
  eligible_days?: number
  eligible_days_target?: number
  adherence_percent?: number | null
  adherence_target_percent?: number
  period_start?: string
  period_end?: string
  percentage?: number
}

export type AchievementHistoryEvent = {
  id: string
  achievementId: string
  tier: number
  generation: number
  eventType: 'unlocked' | 'revoked'
  recordedAt: string
  sourceEventId: string | null
  sourceDate: string | null
  sourceReference?: Record<string, unknown> | null
  reversesEventId: string | null
  retainedAfterTrackerDeletion: boolean
  trackerId?: string | null
  trackerDeleted?: boolean
  trackerDisplayName: string | null
  rewardReasonCode: string | null
  rewardXpDelta: number | null
  rewardReversed?: boolean
  sourceGoalId?: string | null
}

export type AchievementState = {
  achievementId: string
  progress: number
  target: number
  currentTier: number
  repeatable: boolean
  earned: boolean
  unlockedAt: string | null
  validAwardCount?: number
  firstEarnedAt?: string | null
  lastEarnedAt?: string | null
  history: AchievementHistoryEvent[]
  qualificationDetails?: AchievementQualificationDetails
}

export type ConsistencySummary = { score: number | null; eligibleDays: number; dailyAdherence: Array<{ date: string; completed: number; eligible: number }> }
export type PerfectDayState = { date: string; eligibleTrackers: number; completedTrackers: number; confirmed: boolean; provisional: boolean }
export type WeeklyProgressDay = { date: string; completed: number; eligible: number; adherence: number | null; isOpen: boolean }

/** Confirmations are authoritative only after the server sync transaction commits. */
export function subscribeToProgressionChanges(userId: string, listener: () => void): () => void {
  return subscribeToWorkspaceDataChanges((ownerId, kind) => {
    if (ownerId === userId && (kind === 'progression-confirmed' || kind === 'sync-complete')) {
      listener()
    }
  })
}

export function invalidateProgressionOverview(userId: string): void {
  confirmedOverviewCache.delete(userId)
  overviewVersions.set(userId, (overviewVersions.get(userId) ?? 0) + 1)
}

subscribeToWorkspaceSyncPreparation((userId) => {
  if (userId) invalidateProgressionOverview(userId)
})

export type LegacyXpStatus = 'reconstructed' | 'legacy_fallback' | 'unavailable' | 'pending' | 'new_account'

export type ProgressionOverview = {
  legacyXpStatus: LegacyXpStatus
  confirmedXp: number
  officialLevel: ReturnType<typeof calculateProgressionLevel>
  provisionalXp: number
  provisionalRewards: ProvisionalReward[]
  scoreHistory: ProgressionEvent[]
  streakHistory: ProgressionEvent[]
  consistency: ConsistencySummary
  achievements: AchievementState[]
}

type RawEvent = {
  id: string; user_id: string; effective_date: string; recorded_at: string; xp_delta: number; event_category: string; reason_code: string
  reverses_event_id: string | null
  progression_event_sources?: Array<{ source_id: string | null; tracker_id: string | null; goal_id: string | null; display_name: string }>
    | { source_id: string | null; tracker_id: string | null; goal_id: string | null; display_name: string } | null
}

type RetainedRewardContext = {
  event_id: string
  tracker_display_name: string
  deleted_tracker: boolean
  reward_reason_code: string
  xp_delta: number | null
}

function progressionReadError(resource: string, error: { code?: string; message: string }): Error {
  const code = error.code ? ` ${error.code}` : ''
  return new Error(`${resource} request failed${code}: ${error.message}`)
}

type LocalSnapshot = {
  trackers: StoredTrackerDefinition[]
  entries: StoredTrackerEntry[]
  pendingEntryIds: Set<string>
  holidays: Set<string>
  trackerHolidays: Array<{ trackerId: string; date: string }>
  timeZone: string
}

export function mapEvent(row: RawEvent, retained?: RetainedRewardContext): ProgressionEvent {
  const relation = row.progression_event_sources
  const source = Array.isArray(relation) ? relation[0] : relation
  return {
    id: row.id,
    userId: row.user_id,
    effectiveDate: row.effective_date,
    recordedAt: row.recorded_at,
    xpDelta: row.xp_delta,
    eventCategory: row.event_category,
    reasonCode: row.reason_code,
    reversesEventId: row.reverses_event_id,
    sourceId: source?.source_id ?? null,
    trackerId: source?.tracker_id ?? null,
    goalId: source?.goal_id ?? null,
    displayName: retained?.tracker_display_name ?? source?.display_name ?? 'Progression reward',
    deletedTracker: retained?.deleted_tracker ?? false,
  }
}

/** Returns ids that belong to a complete, directly linked XP reversal group. */
export function fullyReversedProgressionEventIds(events: readonly ProgressionEvent[]): Set<string> {
  const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()]
  const reversalsByAwardId = new Map<string, ProgressionEvent[]>()
  for (const event of uniqueEvents) {
    if (!event.reversesEventId) continue
    const reversals = reversalsByAwardId.get(event.reversesEventId) ?? []
    reversals.push(event)
    reversalsByAwardId.set(event.reversesEventId, reversals)
  }

  const hiddenIds = new Set<string>()
  for (const award of uniqueEvents) {
    if (award.xpDelta <= 0 || award.eventCategory === 'reversal' || award.reasonCode === 'AWARD_REVERSAL' || award.reversesEventId !== null) continue
    const reversals = reversalsByAwardId.get(award.id)
    if (!reversals?.length || reversals.some((event) => event.eventCategory !== 'reversal'
      || event.userId !== award.userId || event.reasonCode !== 'AWARD_REVERSAL' || event.xpDelta >= 0 || event.reversesEventId !== award.id)) continue
    if (award.xpDelta + reversals.reduce((sum, event) => sum + event.xpDelta, 0) !== 0) continue
    hiddenIds.add(award.id)
    for (const reversal of reversals) hiddenIds.add(reversal.id)
  }
  return hiddenIds
}

async function getRetainedRewardContexts(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  userId: string,
  eventIds: readonly string[],
  contextKind: 'score' | 'achievement',
): Promise<Map<string, RetainedRewardContext>> {
  const contexts = new Map<string, RetainedRewardContext>()
  for (let offset = 0; offset < eventIds.length; offset += 200) {
    const ids = eventIds.slice(offset, offset + 200)
    if (!ids.length) continue
    countDevPerformance('supabase.retained-context-request')
    const { data, error } = await client.from('progression_retained_reward_context')
      .select('event_id,tracker_display_name,deleted_tracker,reward_reason_code,xp_delta')
      .eq('user_id', userId).eq('context_kind', contextKind).in('event_id', ids)
    if (error) throw progressionReadError('progression_retained_reward_context', error)
    for (const row of (data ?? []) as RetainedRewardContext[]) contexts.set(row.event_id, row)
  }
  return contexts
}

async function assertAccount(client: NonNullable<ReturnType<typeof getSupabaseClient>>, userId: string): Promise<void> {
  countDevPerformance('supabase.auth-user-request')
  const { data, error } = await client.auth.getUser()
  if (error || data.user?.id !== userId) throw new Error('Progression data is available only for the signed-in account.')
}

async function queryAllEvents(client: NonNullable<ReturnType<typeof getSupabaseClient>>, userId: string): Promise<ProgressionEvent[]> {
  const rows: RawEvent[] = []
  for (let offset = 0; ; offset += pageSize) {
    countDevPerformance('supabase.progression-event-page-request')
    const { data, error } = await client.from('progression_events')
      .select('id,user_id,effective_date,recorded_at,xp_delta,event_category,reason_code,reverses_event_id,progression_event_sources(source_id,tracker_id,goal_id,display_name)')
      .eq('user_id', userId).order('recorded_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + pageSize - 1)
    if (error) throw progressionReadError('progression_events (confirmed XP)', error)
    const page = (data ?? []) as RawEvent[]
    rows.push(...page)
    if (page.length < pageSize) break
  }
  const retained = await getRetainedRewardContexts(client, userId, rows.map((row) => row.id), 'score')
  return rows.map((row) => mapEvent(row, retained.get(row.id)))
}

async function getLocalSnapshot(userId: string): Promise<LocalSnapshot> {
  const database = await openDatabase()
  const workspace = await database.workspaceMetadata.get('workspace')
  if (workspace?.userId !== userId) throw new Error('Open this account’s local workspace before loading provisional progression.')
  const [trackers, entries, operations, holidays, trackerHolidays, settings] = await Promise.all([
    database.trackers.toArray(), database.trackerEntries.toArray(),
    database.syncOperations.where('ownerUserId').equals(userId).toArray(),
    database.accountHolidays.toArray(), database.trackerHolidays.toArray(), database.settings.get('general'),
  ])
  return {
    trackers: trackers.filter((tracker) => tracker.deletedAt === null),
    entries: entries.filter((entry) => entry.deletedAt === null),
    pendingEntryIds: new Set(operations.filter((op) => op.entity === 'tracker_entry' && (op.status === 'pending' || op.status === 'in-flight')).map((op) => op.entityId)),
    holidays: new Set(holidays.filter((holiday) => holiday.deletedAt === null).map((holiday) => holiday.date)),
    trackerHolidays: trackerHolidays.filter((holiday) => holiday.deletedAt === null).map(({ trackerId, date }) => ({ trackerId, date })),
    timeZone: settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  }
}

function eligibleAndSuccessful(trackers: readonly StoredTrackerDefinition[], entries: readonly StoredTrackerEntry[], holidays: ReadonlySet<string>, date: string, timeZone?: string, trackerHolidays: readonly { trackerId: string; date: string }[] = []) {
  const byTracker = new Map(entries.filter((entry) => entry.date === date).map((entry) => [entry.trackerId, entry]))
  let eligible = 0
  let completed = 0
  for (const tracker of trackers) {
    if (tracker.deletedAt !== null || !['active', 'archived'].includes(tracker.status)) continue
    if (!isTrackerInActivePeriod(tracker, date, timeZone)) continue
    const entry = byTracker.get(tracker.id)
    const holiday = holidays.has(date) || trackerHolidays.some((item) => item.trackerId === tracker.id && item.date === date)
    const positiveWork = entry?.outcome === 'recorded' && hasPositiveProgress(tracker, entry)
    if (!trackerStrictModeForDate(tracker, date) && ((holiday && !positiveWork) || !isTrackerScheduledOccurrence(tracker, date, timeZone))) continue
    eligible += 1
    if (entry?.outcome === 'recorded' && evaluateTrackerEntry(tracker, entry).qualified) completed += 1
  }
  return { eligible, completed }
}

function dateValue(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new RangeError(`Invalid calendar date: ${value}`)
  return parsed
}
function dateText(value: number): string { return new Date(value).toISOString().slice(0, 10) }

export function calculateConsistencySummary(input: {
  trackers: readonly StoredTrackerDefinition[]
  entries: readonly StoredTrackerEntry[]
  holidays?: ReadonlySet<string>
  trackerHolidays?: readonly { trackerId: string; date: string }[]
  today: string
  timeZone?: string
}): ConsistencySummary {
  const eligibleTrackers = input.trackers.filter((tracker) => tracker.status === 'active' && tracker.deletedAt === null)
  if (!eligibleTrackers.length) return { score: null, eligibleDays: 0, dailyAdherence: [] }
  const latestDefinitionDate = eligibleTrackers.reduce((latest, tracker) => {
    const changed = tracker.updatedAt.slice(0, 10)
    return changed > latest ? changed : latest
  }, '0000-01-01')
  const trackerStart = eligibleTrackers.reduce((earliest, tracker) => {
    const start = trackerActiveStartDate(tracker, input.timeZone)
    return start < earliest ? start : earliest
  }, '9999-12-31')
  const start = latestDefinitionDate > trackerStart ? latestDefinitionDate : trackerStart
  const lastCompletedDate = dateText(dateValue(input.today) - 86_400_000)
  const dailyAdherence: ConsistencySummary['dailyAdherence'] = []
  for (let day = dateValue(lastCompletedDate); day >= dateValue(start) && dailyAdherence.length < 30; day -= 86_400_000) {
    const date = dateText(day)
    const counts = eligibleAndSuccessful(eligibleTrackers, input.entries, input.holidays ?? new Set(), date, input.timeZone, input.trackerHolidays)
    if (counts.eligible > 0) dailyAdherence.push({ date, completed: counts.completed, eligible: counts.eligible })
  }
  return {
    score: dailyAdherence.length ? Math.round(dailyAdherence.reduce((total, day) => total + day.completed / day.eligible, 0) / dailyAdherence.length * 100) : null,
    eligibleDays: dailyAdherence.length,
    dailyAdherence,
  }
}

export function activeAchievementOccurrences(history: readonly AchievementHistoryEvent[]): AchievementHistoryEvent[] {
  const revokedIds = new Set(history.filter((event) => event.eventType === 'revoked' && event.reversesEventId).map((event) => event.reversesEventId))
  return [...new Map(history
    .filter((event) => event.eventType === 'unlocked' && !revokedIds.has(event.id))
    .map((event) => [event.id, event])).values()]
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id))
}

export function makeAchievementStates(
  progress: any[],
  history: any[],
  retainedIds: ReadonlySet<string> = new Set(),
  retainedContexts: ReadonlyMap<string, RetainedRewardContext> = new Map(),
  trackerIdsByEvent: ReadonlyMap<string, string> = new Map(),
  sourceContextByEvent: ReadonlyMap<string, { displayName: string | null; reasonCode: string | null; xpDelta: number | null; goalId: string | null; reversed?: boolean }> = new Map(),
): AchievementState[] {
  const historyById = new Map<string, AchievementHistoryEvent[]>()
  for (const row of history) {
    const event: AchievementHistoryEvent = {
      id: row.id, achievementId: row.achievement_id, tier: row.tier, generation: row.generation,
      eventType: row.event_type, recordedAt: row.recorded_at, sourceEventId: row.source_event_id,
      sourceDate: row.source_date, reversesEventId: row.reverses_event_id,
      sourceReference: row.source_reference ?? null,
      retainedAfterTrackerDeletion: retainedIds.has(row.id),
      trackerId: trackerIdsByEvent.get(row.id) ?? null,
      sourceGoalId: sourceContextByEvent.get(row.id)?.goalId ?? null,
      trackerDeleted: retainedContexts.get(row.id)?.deleted_tracker ?? false,
      trackerDisplayName: retainedContexts.get(row.id)?.tracker_display_name ?? sourceContextByEvent.get(row.id)?.displayName ?? null,
      rewardReasonCode: retainedContexts.get(row.id)?.reward_reason_code ?? sourceContextByEvent.get(row.id)?.reasonCode ?? null,
      rewardXpDelta: retainedContexts.get(row.id)?.xp_delta ?? sourceContextByEvent.get(row.id)?.xpDelta ?? null,
      rewardReversed: sourceContextByEvent.get(row.id)?.reversed ?? false,
    }
    historyById.set(event.achievementId, [...(historyById.get(event.achievementId) ?? []), event])
  }
  return progress.map((row) => {
    const events = (historyById.get(row.achievement_id) ?? []).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    // This persisted flag is set by the server-side achievement reconciler and
    // is the sole cadence authority consumed by every client surface.
    const repeatable = Boolean(row.repeatable)
    const active = activeAchievementOccurrences(events)
    // One-time achievements have one current valid award. Historical retries
    // remain in the audit list, but never inflate the visible count.
    const valid = repeatable ? active : active.slice(0, 1)
    const first = valid[0] ?? null
    const latest = valid.at(-1) ?? null
    return {
      achievementId: row.achievement_id, progress: Number(row.progress), target: Number(row.target),
      currentTier: valid.length, repeatable, earned: valid.length > 0,
      unlockedAt: first?.recordedAt ?? null, validAwardCount: valid.length,
      firstEarnedAt: first?.sourceDate ?? first?.recordedAt ?? null,
      lastEarnedAt: latest?.sourceDate ?? latest?.recordedAt ?? null,
      history: events,
      qualificationDetails: row.qualification_details ?? {},
    }
  })
}

export async function getConfirmedXp(userId: string): Promise<number> {
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase is not configured.')
  await assertAccount(client, userId)
  const events = await queryAllEvents(client, userId)
  return summarizeProgression({ events }).lifetimeXp
}

export async function getProvisionalXp(userId: string, today = localCalendarDate()): Promise<ProvisionalReward[]> {
  const snapshot = await getLocalSnapshot(userId)
  const client = getSupabaseClient()
  if (!client) return localProvisional(snapshot, today)
  await assertAccount(client, userId)
  const events = await queryAllEvents(client, userId)
  return localProvisional(snapshot, today, events)
}

export function localProvisional(snapshot: LocalSnapshot, today: string, confirmedEvents: readonly ProgressionEvent[] = []): ProvisionalReward[] {
  const fullyReversedIds = fullyReversedProgressionEventIds(confirmedEvents)
  const activeCheckInSourceIds = new Set(confirmedEvents
    .filter((event) => event.reasonCode === 'DAILY_CHECK_IN_COMPLETED' && event.xpDelta > 0 && !fullyReversedIds.has(event.id))
    .map((event) => event.sourceId)
    .filter((id): id is string => id !== null))
  const pendingEntryIds = new Set([...snapshot.pendingEntryIds].filter((id) => !activeCheckInSourceIds.has(id)))
  const rewards = selectProvisionalRewards({
    trackers: snapshot.trackers, entries: snapshot.entries, pendingEntryIds, today,
    timeZone: snapshot.timeZone, holidays: snapshot.holidays, trackerHolidays: snapshot.trackerHolidays,
  })
  const dates = new Set(snapshot.entries.filter((entry) => entry.date <= today && pendingEntryIds.has(entry.id)).map((entry) => entry.date))
  for (const date of dates) {
    const counts = eligibleAndSuccessful(snapshot.trackers, snapshot.entries, snapshot.holidays, date, snapshot.timeZone, snapshot.trackerHolidays)
    const hasActivePerfectDayAward = confirmedEvents.some((event) => event.reasonCode === 'PERFECT_DAY_BONUS'
      && event.effectiveDate === date && event.xpDelta > 0 && !fullyReversedIds.has(event.id))
    if (counts.eligible > 0 && counts.completed === counts.eligible && !hasActivePerfectDayAward) {
      rewards.push({ id: `perfect-day:${date}`, effectiveDate: date, xpDelta: 20 })
    }
  }
  return rewards
}

export async function getProgressionHistory(userId: string, page = 0, perPage = 50): Promise<{ rows: ProgressionEvent[]; hasMore: boolean }> {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 200) throw new RangeError('Progression history page is invalid.')
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase is not configured.')
  await assertAccount(client, userId)
  const from = page * perPage
  const { data, error } = await client.from('progression_events')
    .select('id,user_id,effective_date,recorded_at,xp_delta,event_category,reason_code,reverses_event_id,progression_event_sources(source_id,tracker_id,goal_id,display_name)')
    .eq('user_id', userId).order('recorded_at', { ascending: false }).order('id', { ascending: false }).range(from, from + perPage)
  if (error) throw progressionReadError('progression_events (score history)', error)
  const rows = (data ?? []) as RawEvent[]
  const pageRows = rows.slice(0, perPage)
  const retained = await getRetainedRewardContexts(client, userId, pageRows.map((row) => row.id), 'score')
  return { rows: pageRows.map((row) => mapEvent(row, retained.get(row.id))), hasMore: rows.length > perPage }
}

export async function getStreakAndMilestoneHistory(userId: string): Promise<ProgressionEvent[]> {
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase is not configured.')
  await assertAccount(client, userId)
  return (await queryAllEvents(client, userId)).filter((event) => event.reasonCode === 'STREAK_MILESTONE')
}

export async function getConsistencyScore(userId: string, today?: string): Promise<ConsistencySummary> {
  const snapshot = await getLocalSnapshot(userId)
  return calculateConsistencySummary({ ...snapshot, today: today ?? localCalendarDate(new Date(), snapshot.timeZone) })
}

export async function getAchievementProgress(userId: string): Promise<AchievementProgress[]> {
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase is not configured.')
  await assertAccount(client, userId)
  const { data, error } = await client.from('progression_achievement_progress')
    .select('achievement_id,progress,target,current_tier,repeatable,source_event_id,source_date,updated_at,qualification_details')
    .eq('user_id', userId).order('achievement_id')
  if (error) throw progressionReadError('progression_achievement_progress', error)
  return (data ?? []).map((row: any) => ({
    achievementId: row.achievement_id, progress: Number(row.progress), target: Number(row.target), currentTier: row.current_tier,
    repeatable: row.repeatable, sourceEventId: row.source_event_id, sourceDate: row.source_date, updatedAt: row.updated_at,
    qualificationDetails: row.qualification_details ?? {},
  }))
}

async function readEarnedAndLockedBadges(client: NonNullable<ReturnType<typeof getSupabaseClient>>, userId: string): Promise<AchievementState[]> {
  let refreshRequest = qualificationRefreshRequests.get(userId)
  if (refreshRequest) {
    countDevPerformance('supabase.achievement-refresh-deduplicated')
    await refreshRequest
  } else {
    countDevPerformance('supabase.achievement-refresh-rpc')
    const request: Promise<void> = Promise.resolve(client.rpc('refresh_my_progression_qualification_progress')).then(({ error }) => {
      if (error) throw progressionReadError('refresh_my_progression_qualification_progress', error)
    })
    const trackedRequest = request.finally(() => {
      if (qualificationRefreshRequests.get(userId) === refreshRequest) qualificationRefreshRequests.delete(userId)
    })
    refreshRequest = trackedRequest
    qualificationRefreshRequests.set(userId, trackedRequest)
    await trackedRequest
  }
  countDevPerformance('supabase.achievement-progress-request')
  countDevPerformance('supabase.achievement-history-request')
  countDevPerformance('supabase.retained-achievement-request')
  const [progress, history, retained] = await Promise.all([
    client.from('progression_achievement_progress').select('achievement_id,progress,target,current_tier,repeatable,qualification_details').eq('user_id', userId),
    client.from('progression_achievement_events').select('id,achievement_id,tier,generation,event_type,recorded_at,source_event_id,source_date,source_reference,reverses_event_id').eq('user_id', userId).order('recorded_at'),
    client.from('progression_retained_achievement_unlocks').select('achievement_event_id').eq('user_id', userId),
  ])
  if (progress.error) throw progressionReadError('progression_achievement_progress', progress.error)
  if (history.error) throw progressionReadError('progression_achievement_events', history.error)
  if (retained.error) throw progressionReadError('progression_retained_achievement_unlocks', retained.error)
  const historyRows = history.data ?? []
  const contexts = await getRetainedRewardContexts(client, userId, historyRows.map((row: { id: string }) => row.id), 'achievement')
  const sourceEventIds = [...new Set(historyRows.map((row: { id: string; source_event_id: string | null }) => row.source_event_id).filter((id: string | null): id is string => Boolean(id)))]
  const trackerIdsByEvent = new Map<string, string>()
  const sourceContextByAchievement = new Map<string, { displayName: string | null; reasonCode: string | null; xpDelta: number | null; goalId: string | null; reversed?: boolean }>()
  for (let offset = 0; offset < sourceEventIds.length; offset += 200) {
    const ids = sourceEventIds.slice(offset, offset + 200)
    if (!ids.length) continue
    countDevPerformance('supabase.achievement-source-tracker-request')
    const { data, error } = await client.from('progression_event_sources').select('event_id,tracker_id,goal_id,display_name')
      .eq('user_id', userId).in('event_id', ids)
    if (error) throw progressionReadError('progression_event_sources (achievement attribution)', error)
    for (const row of (data ?? []) as Array<{ event_id: string; tracker_id: string | null; goal_id: string | null; display_name: string }>) {
      if (row.tracker_id) trackerIdsByEvent.set(row.event_id, row.tracker_id)
      sourceContextByAchievement.set(row.event_id, { displayName: row.display_name, reasonCode: null, xpDelta: null, goalId: row.goal_id })
    }
  }
  for (let offset = 0; offset < sourceEventIds.length; offset += 200) {
    const ids = sourceEventIds.slice(offset, offset + 200)
    if (!ids.length) continue
    const [{ data, error }, { data: reversalData, error: reversalError }] = await Promise.all([
      client.from('progression_events').select('id,reason_code,xp_delta').eq('user_id', userId).in('id', ids),
      client.from('progression_events').select('id,reverses_event_id,reason_code,xp_delta,event_category').eq('user_id', userId).in('reverses_event_id', ids),
    ])
    if (error) throw progressionReadError('progression_events (achievement reward source)', error)
    if (reversalError) throw progressionReadError('progression_events (achievement reward reversals)', reversalError)
    const reversalsBySource = new Map<string, Array<{ reason_code: string; xp_delta: number; event_category: string }>>()
    for (const reversal of (reversalData ?? []) as Array<{ reverses_event_id: string | null; reason_code: string; xp_delta: number; event_category: string }>) {
      if (!reversal.reverses_event_id) continue
      reversalsBySource.set(reversal.reverses_event_id, [...(reversalsBySource.get(reversal.reverses_event_id) ?? []), reversal])
    }
    for (const row of (data ?? []) as Array<{ id: string; reason_code: string; xp_delta: number }>) {
      const existing = sourceContextByAchievement.get(row.id)
      const reversals = reversalsBySource.get(row.id) ?? []
      const fullyReversed = row.xp_delta > 0 && reversals.length > 0
        && reversals.every((reversal) => reversal.reason_code === 'AWARD_REVERSAL' && reversal.event_category === 'reversal' && reversal.xp_delta < 0)
        && row.xp_delta + reversals.reduce((sum, reversal) => sum + reversal.xp_delta, 0) === 0
      sourceContextByAchievement.set(row.id, { displayName: existing?.displayName ?? null, reasonCode: row.reason_code, xpDelta: row.xp_delta, goalId: existing?.goalId ?? null, reversed: fullyReversed })
    }
  }
  const trackerIdsByAchievement = new Map(historyRows.map((row: { id: string; source_event_id: string | null }) => [row.id, row.source_event_id ? trackerIdsByEvent.get(row.source_event_id) : undefined]))
  const sourceContextByAchievementEvent = new Map(historyRows.map((row: { id: string; source_event_id: string | null }) => [row.id, row.source_event_id ? sourceContextByAchievement.get(row.source_event_id) : undefined]))
  return makeAchievementStates(progress.data ?? [], historyRows, new Set((retained.data ?? []).map((row: { achievement_event_id: string }) => row.achievement_event_id)), contexts,
    new Map([...trackerIdsByAchievement].filter((entry): entry is [string, string] => Boolean(entry[1]))),
    new Map([...sourceContextByAchievementEvent].filter((entry): entry is [string, { displayName: string | null; reasonCode: string | null; xpDelta: number | null; goalId: string | null; reversed?: boolean }] => Boolean(entry[1])))
  )
}

export async function getEarnedAndLockedBadges(userId: string): Promise<AchievementState[]> {
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase is not configured.')
  await assertAccount(client, userId)
  return readEarnedAndLockedBadges(client, userId)
}

export async function getAchievementHistory(userId: string): Promise<AchievementHistoryEvent[]> {
  const badges = await getEarnedAndLockedBadges(userId)
  return badges.flatMap((badge) => badge.history).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
}

/** Returns positive, unreversed XP only when an achievement references a real ledger event. */
export async function getAchievementAwardXp(userId: string, sourceEventIds: readonly string[]): Promise<Map<string, number>> {
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase is not configured.')
  await assertAccount(client, userId)
  const result = new Map<string, number>()
  for (let offset = 0; offset < sourceEventIds.length; offset += 200) {
    const ids = sourceEventIds.slice(offset, offset + 200)
    if (!ids.length) continue
    const { data, error } = await client.from('progression_events').select('id,xp_delta').eq('user_id', userId).in('id', ids).gt('xp_delta', 0)
    if (error) throw progressionReadError('progression_events (achievement reward attribution)', error)
    const rows = (data ?? []) as Array<{ id: string; xp_delta: number }>
    if (!rows.length) continue
    const { data: reversals, error: reversalError } = await client.from('progression_events').select('reverses_event_id')
      .eq('user_id', userId).in('reverses_event_id', rows.map((row) => row.id))
    if (reversalError) throw progressionReadError('progression_events (achievement reward reversal)', reversalError)
    const reversed = new Set((reversals ?? []).map((row: { reverses_event_id: string }) => row.reverses_event_id))
    rows.forEach((row) => { if (!reversed.has(row.id)) result.set(row.id, Number(row.xp_delta)) })
  }
  return result
}

export async function getNewlyConfirmedRewards(userId: string, since: string): Promise<ProgressionEvent[]> {
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase is not configured.')
  await assertAccount(client, userId)
  const { data, error } = await client.from('progression_events')
    .select('id,user_id,effective_date,recorded_at,xp_delta,event_category,reason_code,reverses_event_id,progression_event_sources(source_id,tracker_id,goal_id,display_name)')
    .eq('user_id', userId).gt('recorded_at', since).gt('xp_delta', 0).order('recorded_at').order('id')
  if (error) throw progressionReadError('progression_events (newly confirmed rewards)', error)
  const rows = (data ?? []) as RawEvent[]
  const retained = await getRetainedRewardContexts(client, userId, rows.map((row) => row.id), 'score')
  return rows.map((row) => mapEvent(row, retained.get(row.id)))
}

export async function getPerfectDayCompletion(userId: string, date: string): Promise<PerfectDayState> {
  const snapshot = await getLocalSnapshot(userId)
  const counts = eligibleAndSuccessful(snapshot.trackers, snapshot.entries, snapshot.holidays, date, snapshot.timeZone, snapshot.trackerHolidays)
  const today = localCalendarDate(new Date(), snapshot.timeZone)
  const entryIds = new Set(snapshot.entries.filter((entry) => entry.date === date).map((entry) => entry.id))
  const provisional = date <= today && counts.eligible > 0 && counts.eligible === counts.completed && snapshot.entries.some((entry) => entry.date === date && entryIds.has(entry.id) && snapshot.pendingEntryIds.has(entry.id))
  const client = getSupabaseClient()
  let confirmed = false
  if (client) {
    await assertAccount(client, userId)
    const { data, error } = await client.from('progression_events').select('xp_delta').eq('user_id', userId).eq('reason_code', 'PERFECT_DAY_BONUS').eq('effective_date', date)
    if (error) throw progressionReadError('progression_events (Perfect Day confirmation)', error)
    confirmed = (data ?? []).reduce((sum: number, event: { xp_delta: number }) => sum + event.xp_delta, 0) > 0
  }
  return { date, eligibleTrackers: counts.eligible, completedTrackers: counts.completed, confirmed, provisional: !confirmed && provisional }
}

export async function getWeeklyProgressSummary(userId: string, today?: string): Promise<WeeklyProgressDay[]> {
  const snapshot = await getLocalSnapshot(userId)
  const currentDate = today ?? localCalendarDate(new Date(), snapshot.timeZone)
  return Array.from({ length: 7 }, (_, index) => {
    const date = dateText(dateValue(currentDate) - (6 - index) * 86_400_000)
    const counts = eligibleAndSuccessful(snapshot.trackers, snapshot.entries, snapshot.holidays, date, snapshot.timeZone, snapshot.trackerHolidays)
    return { date, completed: counts.completed, eligible: counts.eligible, adherence: counts.eligible ? Math.round(counts.completed / counts.eligible * 100) : null, isOpen: date === currentDate }
  })
}

async function getLegacyXpStatus(client: NonNullable<ReturnType<typeof getSupabaseClient>>): Promise<LegacyXpStatus> {
  countDevPerformance('supabase.legacy-xp-status-rpc')
  const { data, error } = await client.rpc('get_progression_legacy_xp_status')
  if (error) throw progressionReadError('get_progression_legacy_xp_status (historical XP status)', error)
  if (!['reconstructed', 'legacy_fallback', 'unavailable', 'pending', 'new_account'].includes(data)) {
    throw new Error('get_progression_legacy_xp_status returned an invalid status.')
  }
  return data as LegacyXpStatus
}

async function fetchConfirmedOverview(userId: string): Promise<ConfirmedOverview> {
  const measure = measureDevPerformance('wins.confirmed-overview-fetch')
  countDevPerformance('wins.overview-refresh')
  try {
    const client = getSupabaseClient()
    if (!client) throw new Error('Supabase is not configured.')
    await assertAccount(client, userId)
    const [events, achievements, legacyXpStatus] = await Promise.all([
      queryAllEvents(client, userId), readEarnedAndLockedBadges(client, userId), getLegacyXpStatus(client),
    ])
    const summary = summarizeProgression({ events, provisionalRewards: [] })
    return {
      legacyXpStatus,
      confirmedXp: summary.lifetimeXp,
      officialLevel: summary.level,
      scoreHistory: events,
      streakHistory: events.filter((event) => event.reasonCode === 'STREAK_MILESTONE'),
      achievements,
    }
  } finally { measure() }
}

function deduplicatedConfirmedOverview(userId: string): Promise<ConfirmedOverview> {
  const active = overviewRequests.get(userId)
  if (active) {
    if (active.version === (overviewVersions.get(userId) ?? 0)) {
      countDevPerformance('wins.overview-deduplicated')
      return active.promise
    }
    return active.promise.then(() => deduplicatedConfirmedOverview(userId), () => deduplicatedConfirmedOverview(userId))
  }
  const version = overviewVersions.get(userId) ?? 0
  const request = fetchConfirmedOverview(userId).then((overview) => {
    if ((overviewVersions.get(userId) ?? 0) === version) confirmedOverviewCache.set(userId, overview)
    return overview
  }).finally(() => {
    if (overviewRequests.get(userId)?.promise === request) overviewRequests.delete(userId)
  })
  overviewRequests.set(userId, { version, promise: request })
  return request
}

/**
 * Uses an account-scoped confirmed snapshot when available, while always recomputing
 * provisional rewards and consistency from the current local-first workspace.
 */
export async function getProgressionOverview(userId: string, options: { forceRefresh?: boolean } = {}): Promise<ProgressionOverview> {
  let confirmed = confirmedOverviewCache.get(userId)
  if (confirmed && !options.forceRefresh) countDevPerformance('wins.overview-cache-hit')
  else confirmed = await deduplicatedConfirmedOverview(userId)

  const measure = measureDevPerformance('wins.local-progression-compose')
  try {
    const local = await getLocalSnapshot(userId)
    const provisionalRewards = localProvisional(local, localCalendarDate(new Date(), local.timeZone), confirmed.scoreHistory)
    const summary = summarizeProgression({ events: confirmed.scoreHistory, provisionalRewards })
    return {
      ...confirmed,
      provisionalXp: summary.provisionalXp,
      provisionalRewards,
      consistency: calculateConsistencySummary({ ...local, today: localCalendarDate(new Date(), local.timeZone) }),
    }
  } finally { measure() }
}
