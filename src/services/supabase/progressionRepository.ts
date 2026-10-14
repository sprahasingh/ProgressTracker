import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { openDatabase } from '../../db/database'
import { getSupabaseClient } from './client'
import { localCalendarDate } from '../../features/shared/localDates'
import { isTrackerInActivePeriod, isTrackerScheduledOccurrence } from '../../domain/trackers/planning'
import { qualifiesForStreak } from '../../domain/trackers/progression'
import { calculateProgressionLevel, selectProvisionalRewards, summarizeProgression, type ProvisionalReward } from '../../domain/trackers/progressionModel'
import { subscribeToWorkspaceDataChanges } from '../../db/workspaceMutationEvents'

const pageSize = 500

export type ProgressionEvent = {
  id: string
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
  status?: 'in_progress' | 'qualified' | 'ineligible' | 'unavailable' | 'waiting' | 'recovery_possible' | 'episode_confirmed'
  label?: string
  message?: string
  progress?: number
  target?: number
  eligible_days?: number
  eligible_days_target?: number
  adherence_percent?: number | null
  adherence_target_percent?: number
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
  reversesEventId: string | null
  retainedAfterTrackerDeletion: boolean
  trackerDisplayName: string | null
  rewardReasonCode: string | null
  rewardXpDelta: number | null
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

/** Refresh progression reads after local edits, successful sync, or a sibling device tab update. */
export function subscribeToProgressionChanges(userId: string, listener: () => void): () => void {
  return subscribeToWorkspaceDataChanges((ownerId) => { if (ownerId === userId) listener() })
}

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
  id: string; effective_date: string; recorded_at: string; xp_delta: number; event_category: string; reason_code: string
  reverses_event_id: string | null
  progression_event_sources?: Array<{ source_id: string | null; tracker_id: string | null; goal_id: string | null; display_name: string }> | null
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
  timeZone: string
}

function mapEvent(row: RawEvent, retained?: RetainedRewardContext): ProgressionEvent {
  const source = row.progression_event_sources?.[0]
  return {
    id: row.id,
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
    const { data, error } = await client.from('progression_retained_reward_context')
      .select('event_id,tracker_display_name,deleted_tracker,reward_reason_code,xp_delta')
      .eq('user_id', userId).eq('context_kind', contextKind).in('event_id', ids)
    if (error) throw progressionReadError('progression_retained_reward_context', error)
    for (const row of (data ?? []) as RetainedRewardContext[]) contexts.set(row.event_id, row)
  }
  return contexts
}

async function assertAccount(client: NonNullable<ReturnType<typeof getSupabaseClient>>, userId: string): Promise<void> {
  const { data, error } = await client.auth.getUser()
  if (error || data.user?.id !== userId) throw new Error('Progression data is available only for the signed-in account.')
}

async function queryAllEvents(client: NonNullable<ReturnType<typeof getSupabaseClient>>, userId: string): Promise<ProgressionEvent[]> {
  const rows: RawEvent[] = []
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.from('progression_events')
      .select('id,effective_date,recorded_at,xp_delta,event_category,reason_code,reverses_event_id,progression_event_sources(source_id,tracker_id,goal_id,display_name)')
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
  const [trackers, entries, operations, holidays, settings] = await Promise.all([
    database.trackers.toArray(), database.trackerEntries.toArray(),
    database.syncOperations.where('ownerUserId').equals(userId).toArray(),
    database.accountHolidays.toArray(), database.settings.get('general'),
  ])
  return {
    trackers: trackers.filter((tracker) => tracker.deletedAt === null),
    entries: entries.filter((entry) => entry.deletedAt === null),
    pendingEntryIds: new Set(operations.filter((op) => op.entity === 'tracker_entry' && op.status === 'pending').map((op) => op.entityId)),
    holidays: new Set(holidays.filter((holiday) => holiday.deletedAt === null).map((holiday) => holiday.date)),
    timeZone: settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  }
}

function eligibleAndCompleted(trackers: readonly StoredTrackerDefinition[], entries: readonly StoredTrackerEntry[], holidays: ReadonlySet<string>, date: string, timeZone?: string, requireQualifyingEntry = false) {
  const byTracker = new Map(entries.filter((entry) => entry.date === date).map((entry) => [entry.trackerId, entry]))
  let eligible = 0
  let completed = 0
  for (const tracker of trackers) {
    if (tracker.deletedAt !== null || !['active', 'archived'].includes(tracker.status)) continue
    if (!isTrackerInActivePeriod(tracker, date, timeZone)) continue
    if (tracker.strictMode !== true && (holidays.has(date) || !isTrackerScheduledOccurrence(tracker, date, timeZone))) continue
    eligible += 1
    const entry = byTracker.get(tracker.id)
    if (entry && (requireQualifyingEntry ? qualifiesForStreak(tracker, entry) : entry.outcome === 'recorded')) completed += 1
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
    const created = tracker.startDate && tracker.startDate > tracker.createdAt.slice(0, 10) ? tracker.startDate : tracker.createdAt.slice(0, 10)
    return created < earliest ? created : earliest
  }, '9999-12-31')
  const start = latestDefinitionDate > trackerStart ? latestDefinitionDate : trackerStart
  const lastCompletedDate = dateText(dateValue(input.today) - 86_400_000)
  const dailyAdherence: ConsistencySummary['dailyAdherence'] = []
  for (let day = dateValue(lastCompletedDate); day >= dateValue(start) && dailyAdherence.length < 30; day -= 86_400_000) {
    const date = dateText(day)
    const counts = eligibleAndCompleted(eligibleTrackers, input.entries, input.holidays ?? new Set(), date, input.timeZone)
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
): AchievementState[] {
  const historyById = new Map<string, AchievementHistoryEvent[]>()
  for (const row of history) {
    const event: AchievementHistoryEvent = {
      id: row.id, achievementId: row.achievement_id, tier: row.tier, generation: row.generation,
      eventType: row.event_type, recordedAt: row.recorded_at, sourceEventId: row.source_event_id,
      sourceDate: row.source_date, reversesEventId: row.reverses_event_id,
      retainedAfterTrackerDeletion: retainedIds.has(row.id),
      trackerDisplayName: retainedContexts.get(row.id)?.tracker_display_name ?? null,
      rewardReasonCode: retainedContexts.get(row.id)?.reward_reason_code ?? null,
      rewardXpDelta: retainedContexts.get(row.id)?.xp_delta ?? null,
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

function localProvisional(snapshot: LocalSnapshot, today: string, confirmedEvents: readonly ProgressionEvent[] = []): ProvisionalReward[] {
  const confirmedSourceIds = new Set(confirmedEvents.map((event) => event.sourceId).filter((id): id is string => id !== null))
  const pendingEntryIds = new Set([...snapshot.pendingEntryIds].filter((id) => !confirmedSourceIds.has(id)))
  const rewards = selectProvisionalRewards({
    trackers: snapshot.trackers, entries: snapshot.entries, pendingEntryIds, today,
    timeZone: snapshot.timeZone, holidays: snapshot.holidays,
  })
  const dates = new Set(snapshot.entries.filter((entry) => entry.date <= today && pendingEntryIds.has(entry.id)).map((entry) => entry.date))
  for (const date of dates) {
    const counts = eligibleAndCompleted(snapshot.trackers, snapshot.entries, snapshot.holidays, date, snapshot.timeZone, true)
    const confirmedNet = confirmedEvents.filter((event) => event.reasonCode === 'PERFECT_DAY_BONUS' && event.effectiveDate === date).reduce((sum, event) => sum + event.xpDelta, 0)
    if (counts.eligible > 0 && counts.completed === counts.eligible && confirmedNet <= 0) {
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
    .select('id,effective_date,recorded_at,xp_delta,event_category,reason_code,reverses_event_id,progression_event_sources(source_id,tracker_id,goal_id,display_name)')
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
  const { error: refreshError } = await client.rpc('refresh_my_progression_qualification_progress')
  if (refreshError) throw progressionReadError('refresh_my_progression_qualification_progress', refreshError)
  const [progress, history, retained] = await Promise.all([
    client.from('progression_achievement_progress').select('achievement_id,progress,target,current_tier,repeatable,qualification_details').eq('user_id', userId),
    client.from('progression_achievement_events').select('id,achievement_id,tier,generation,event_type,recorded_at,source_event_id,source_date,reverses_event_id').eq('user_id', userId).order('recorded_at'),
    client.from('progression_retained_achievement_unlocks').select('achievement_event_id').eq('user_id', userId),
  ])
  if (progress.error) throw progressionReadError('progression_achievement_progress', progress.error)
  if (history.error) throw progressionReadError('progression_achievement_events', history.error)
  if (retained.error) throw progressionReadError('progression_retained_achievement_unlocks', retained.error)
  const historyRows = history.data ?? []
  const contexts = await getRetainedRewardContexts(client, userId, historyRows.map((row: { id: string }) => row.id), 'achievement')
  return makeAchievementStates(progress.data ?? [], historyRows, new Set((retained.data ?? []).map((row: { achievement_event_id: string }) => row.achievement_event_id)), contexts)
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
    .select('id,effective_date,recorded_at,xp_delta,event_category,reason_code,reverses_event_id,progression_event_sources(source_id,tracker_id,goal_id,display_name)')
    .eq('user_id', userId).gt('recorded_at', since).gt('xp_delta', 0).order('recorded_at').order('id')
  if (error) throw progressionReadError('progression_events (newly confirmed rewards)', error)
  const rows = (data ?? []) as RawEvent[]
  const retained = await getRetainedRewardContexts(client, userId, rows.map((row) => row.id), 'score')
  return rows.map((row) => mapEvent(row, retained.get(row.id)))
}

export async function getPerfectDayCompletion(userId: string, date: string): Promise<PerfectDayState> {
  const snapshot = await getLocalSnapshot(userId)
  const counts = eligibleAndCompleted(snapshot.trackers, snapshot.entries, snapshot.holidays, date, snapshot.timeZone, true)
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
    const counts = eligibleAndCompleted(snapshot.trackers, snapshot.entries, snapshot.holidays, date, snapshot.timeZone)
    return { date, completed: counts.completed, eligible: counts.eligible, adherence: counts.eligible ? Math.round(counts.completed / counts.eligible * 100) : null, isOpen: date === currentDate }
  })
}

async function getLegacyXpStatus(client: NonNullable<ReturnType<typeof getSupabaseClient>>): Promise<LegacyXpStatus> {
  const { data, error } = await client.rpc('get_progression_legacy_xp_status')
  if (error) throw progressionReadError('get_progression_legacy_xp_status (historical XP status)', error)
  if (!['reconstructed', 'legacy_fallback', 'unavailable', 'pending', 'new_account'].includes(data)) {
    throw new Error('get_progression_legacy_xp_status returned an invalid status.')
  }
  return data as LegacyXpStatus
}

export async function getProgressionOverview(userId: string): Promise<ProgressionOverview> {
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase is not configured.')
  await assertAccount(client, userId)
  const [events, local, achievements, legacyXpStatus] = await Promise.all([
    queryAllEvents(client, userId), getLocalSnapshot(userId), readEarnedAndLockedBadges(client, userId), getLegacyXpStatus(client),
  ])
  const provisionalRewards = localProvisional(local, localCalendarDate(new Date(), local.timeZone), events)
  const summary = summarizeProgression({ events, provisionalRewards })
  return {
    legacyXpStatus,
    confirmedXp: summary.lifetimeXp,
    officialLevel: summary.level,
    provisionalXp: summary.provisionalXp,
    provisionalRewards,
    scoreHistory: events,
    streakHistory: events.filter((event) => event.reasonCode === 'STREAK_MILESTONE'),
    consistency: calculateConsistencySummary({ ...local, today: localCalendarDate(new Date(), local.timeZone) }),
    achievements,
  }
}
