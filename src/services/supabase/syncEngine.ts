import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProgressTrackerDatabase } from '../../db/database'
import { openDatabase } from '../../db/database'
import { migrateLegacyRejectedConflicts } from '../../db/legacySyncRejections'
import { localRepository } from '../../db/localRepository'
import { publishPermanentDeletionNotification } from '../permanentDeletionNotifications'
import { publishWorkspaceDataChange, publishWorkspaceProgressionConfirmed, publishWorkspaceSyncCompleted } from '../../db/workspaceMutationEvents'
import { countDevPerformance, measureDevPerformance } from '../../utils/devPerformance'
import type { AccountHoliday, StoredTrackerDefinition, StoredTrackerEntry, SyncOperation, SyncRecordState } from '../../db/models'
import { trackerDefinitionSchema, trackerEntrySchema } from '../../domain/trackers/schema'
import { isPermanentDeletionEnabled, isSchemaV3WriteEnabled, isSchemaV4WriteEnabled, isSchemaV5WriteEnabled, isSchemaV6WriteEnabled, isSchemaV7WriteEnabled, isSchemaV8WriteEnabled, isSchemaV9WriteEnabled, isSchemaV10WriteEnabled } from '../../domain/trackers/schemaVersionGate'
import { getSupabaseClient } from './client'
import { ensureAccountWorkspaceTimeZone } from './workspaceTimeZone'
import { normalizeSyncTimestamp, normalizeTrackerEntryTimestamps, normalizeTrackerTimestamps } from './syncTimestamps'
import { historicalMetricMeaningChange, trackerMetricTypeChange } from '../../domain/trackers/invariants'
import { isHolidayPermanentDeletionEnabled } from '../../domain/trackers/schemaVersionGate'
import { publishHolidayDeletionNotification } from '../holidayDeletionNotifications'
import { isNetworkFailure, isUnsupportedSchemaFailure, reportTrackerWriteDiagnostic } from '../../utils/trackerWriteDiagnostics'

type ServerTracker = { id: string; user_id: string; schema_version: number; kind: string; status: string; name: string; definition: unknown; created_at: string; updated_at: string; deleted_at: string | null; server_revision: number }
type ServerEntry = { id: string; user_id: string; tracker_id: string; entry_date: string; outcome: 'recorded' | 'skipped'; entry_values: Record<string, unknown>; note: string; created_at: string; updated_at: string; deleted_at: string | null; server_revision: number }
type ServerHoliday = { id: string; user_id: string; holiday_date: string; reason: AccountHoliday['reason']; created_at: string; updated_at: string; deleted_at: string | null; server_revision: number }
type OperationResult = { status: 'applied' | 'conflict' | 'permanently_deleted'; record: ServerTracker | ServerEntry | ServerHoliday | null; holiday_id?: string; permanently_deleted_at?: string }
type SyncClient = Pick<SupabaseClient, 'auth'> & {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string; details?: string; hint?: string } | null }>
  from: (table: string) => any
}

export type SyncSummary = { uploaded: number; downloaded: number; conflicts: number; failed: number }
const pageSize = 200
const inFlightByUser = new Map<string, Promise<SyncSummary>>()
let syncQueue: Promise<void> = Promise.resolve()

function keyFor(entity: 'tracker' | 'tracker_entry' | 'account_holiday', id: string) { return `${entity}:${id}` }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Sync could not complete. Your local records are retained.' }

class PermanentDeletionRejectedError extends Error {}

function toServerPayload(operation: SyncOperation): Record<string, unknown> {
  if (!operation.payload) throw new Error('This sync operation has no saved record payload.')
  if (operation.entity === 'tracker') {
    // Older IndexedDB rows can contain an equivalent PostgreSQL/offset timestamp.
    // Canonicalize the outgoing copy; leave the persisted local record untouched.
    const tracker = trackerDefinitionSchema.parse(normalizeTrackerTimestamps(operation.payload))
    return { id: tracker.id, schema_version: tracker.schemaVersion, kind: tracker.kind, status: tracker.status, name: tracker.name, definition: tracker, created_at: tracker.createdAt, updated_at: tracker.updatedAt, deleted_at: tracker.deletedAt }
  }
  if (operation.entity === 'account_holiday') {
    const holiday = operation.payload as AccountHoliday
    return { id: holiday.id, holiday_date: holiday.date, reason: holiday.reason, created_at: holiday.createdAt, updated_at: holiday.updatedAt, deleted_at: holiday.deletedAt }
  }
  const entry = trackerEntrySchema.parse(normalizeTrackerEntryTimestamps(operation.payload))
  return { id: entry.id, tracker_id: entry.trackerId, entry_date: entry.date, outcome: entry.outcome, entry_values: entry.values, note: entry.note, created_at: entry.createdAt, updated_at: entry.updatedAt, deleted_at: entry.deletedAt }
}

function trackerFromServer(row: ServerTracker): StoredTrackerDefinition {
  const parsed = trackerDefinitionSchema.parse(normalizeTrackerTimestamps(row.definition))
  const serverDeletedAt = row.deleted_at === null ? null : normalizeSyncTimestamp(row.deleted_at, 'deleted_at') as string
  const sameTombstoneInstant = parsed.deletedAt === null || serverDeletedAt === null
    ? parsed.deletedAt === serverDeletedAt
    : canonicalTimestamp(parsed.deletedAt) === canonicalTimestamp(serverDeletedAt)
  if (parsed.id !== row.id || parsed.kind !== row.kind || parsed.status !== row.status || parsed.schemaVersion !== row.schema_version || !sameTombstoneInstant) throw new Error('Cloud tracker fields do not match its stored definition.')
  return parsed as StoredTrackerDefinition
}

function canonicalTimestamp(value: string): string {
  return value.replace(/(\.\d*?[1-9])0+Z$/, '$1Z').replace(/\.0+Z$/, 'Z')
}

function entryFromServer(row: ServerEntry): StoredTrackerEntry {
  return trackerEntrySchema.parse(normalizeTrackerEntryTimestamps({ id: row.id, trackerId: row.tracker_id, date: row.entry_date, outcome: row.outcome, values: row.entry_values, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at }))
}

async function assertUser(client: SyncClient, expectedUserId: string) {
  const { data, error } = await client.auth.getUser()
  if (error || data.user?.id !== expectedUserId) throw new Error('Sync stopped because the authenticated session does not match this account workspace.')
}

/** Check the locally held identity between requests; the server still enforces auth.uid() and the expected owner on every RPC/read. */
async function assertCurrentSession(client: SyncClient, expectedUserId: string) {
  const { data, error } = await client.auth.getSession()
  if (error || data.session?.user.id !== expectedUserId) throw new Error('Sync stopped because the authenticated session does not match this account workspace.')
}

async function accountState(database: ProgressTrackerDatabase, expectedUserId: string) {
  const metadata = await database.workspaceMetadata.get('workspace')
  if (!metadata || metadata.userId !== expectedUserId) throw new Error('Sync stopped because this local database is not owned by the authenticated account.')
}

async function markFailure(database: ProgressTrackerDatabase, operation: SyncOperation, message: string) {
  const latest = await database.syncOperations.get(operation.id)
  if (latest) await database.syncOperations.put({ ...latest, attempts: latest.attempts + 1, lastError: message })
}

function safeServerFailureDiagnostic(code: string, message: string) {
  const relation = /relation \"([a-zA-Z0-9_.]+)\"/.exec(message)?.[1]
  const constraint = /constraint \"([a-zA-Z0-9_]+)\"/.exec(message)?.[1]
  return {
    code,
    // PostgreSQL's message identifies trigger/constraint failures. `details`
    // can contain a full failing row, so it is deliberately not persisted.
    message: message.slice(0, 500),
    ...(relation ? { table: relation } : {}),
    ...(constraint ? { constraint } : {}),
  }
}

async function markPermanentlyBlocked(database: ProgressTrackerDatabase, operation: SyncOperation, code: string, message: string, serverMessage?: string) {
  const latest = await database.syncOperations.get(operation.id)
  if (latest) await database.syncOperations.put({
    ...latest,
    status: 'blocked',
    attempts: latest.attempts + 1,
    lastError: `The server rejected this saved change (${code}). ${message}`,
    failureCode: code,
    ...(serverMessage ? { failureDiagnostic: safeServerFailureDiagnostic(code, serverMessage) } : {}),
    blockedAt: new Date().toISOString(),
  })
}

async function markInFlight(database: ProgressTrackerDatabase, operationId: string): Promise<SyncOperation | undefined> {
  return database.transaction('rw', [database.syncOperations], async () => {
    const latest = await database.syncOperations.get(operationId)
    if (!latest || (latest.status !== 'pending' && latest.status !== 'in-flight')) return undefined
    const inFlight = { ...latest, status: 'in-flight' as const }
    await database.syncOperations.put(inFlight)
    return inFlight
  })
}

async function recordQueuedConflict(database: ProgressTrackerDatabase, operation: SyncOperation, remoteRecord: Record<string, unknown> | null, reason: string) {
  const ownerUserId = operation.ownerUserId
  const entity = operation.entity as 'tracker' | 'tracker_entry' | 'account_holiday'
  if (!ownerUserId) throw new Error('This queued operation has no authenticated owner.')
  let localPayload = operation.payload
  if (operation.entity === 'tracker') localPayload = await database.trackers.get(operation.entityId) ?? localPayload
  else if (operation.entity === 'tracker_entry') localPayload = await database.trackerEntries.get(operation.entityId) ?? localPayload
  else if (operation.entity === 'account_holiday') localPayload = await database.accountHolidays.get(operation.entityId) ?? localPayload
  const queued = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([ownerUserId, entity, operation.entityId]).toArray()
  for (const sibling of queued) {
    if (sibling.id !== operation.id && sibling.status !== 'blocked' && sibling.status !== 'superseded' && sibling.status !== 'discarded') await database.syncOperations.delete(sibling.id)
  }
  const latest = await database.syncOperations.get(operation.id)
  if (latest) await database.syncOperations.put({ ...latest, payload: localPayload, status: 'conflict', attempts: latest.attempts + 1, lastError: reason })
  await database.syncConflicts.put({ id: operation.id, ownerUserId, entity, entityId: operation.entityId, localPayload: localPayload!, remoteRecord, detectedAt: new Date().toISOString(), reason })
}

async function markConflict(database: ProgressTrackerDatabase, operation: SyncOperation, remoteRecord: Record<string, unknown> | null, reason = 'The cloud record changed since this device last read it.') {
  await database.transaction('rw', [database.syncOperations, database.syncConflicts, database.trackers, database.trackerEntries, database.accountHolidays], async () => {
    await recordQueuedConflict(database, operation, remoteRecord, reason)
  })
}

function isPermanentWriteRejection(code: string | undefined): boolean {
  return code !== undefined && ['22001', '22007', '22008', '22023', '22P02', '23502', '23503', '23505', '23514'].includes(code)
}

function reportUnsupportedSyncSchema(operation: SyncOperation): void {
  const schemaVersion = operation.entity === 'tracker' ? (operation.payload as StoredTrackerDefinition | undefined)?.schemaVersion : undefined
  reportTrackerWriteDiagnostic({ category: 'unsupported-schema-version', phase: 'payload-validation', ...(schemaVersion ? { schemaVersion } : {}), entity: operation.entity as 'tracker' | 'tracker_entry' | 'account_holiday' })
}

async function acknowledge(database: ProgressTrackerDatabase, operation: SyncOperation, record: ServerTracker | ServerEntry | ServerHoliday) {
  const ownerUserId = operation.ownerUserId
  const entity = operation.entity as 'tracker' | 'tracker_entry' | 'account_holiday'
  if (!ownerUserId) throw new Error('This queued operation has no authenticated owner.')
  const revision: SyncRecordState = { key: keyFor(entity, operation.entityId), ownerUserId, entity, entityId: operation.entityId, serverRevision: record.server_revision }
  await database.transaction('rw', [database.syncOperations, database.syncRecords, database.trackerVerification, database.trackers], async () => {
    await database.syncRecords.put(revision)
    const queued = (await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([ownerUserId, entity, operation.entityId]).toArray())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    const index = queued.findIndex((candidate) => candidate.id === operation.id)
    const next = index >= 0 ? queued.slice(index + 1).find((candidate) => candidate.status !== 'conflict' && candidate.status !== 'blocked' && candidate.status !== 'superseded' && candidate.status !== 'discarded') : undefined
    const isLatest = index >= 0 && index === queued.length - 1
    if (operation.entity === 'tracker' && isLatest) {
      const current = await database.trackers.get(operation.entityId)
      const payload = operation.payload as StoredTrackerDefinition | undefined
      const sameDeletedAt = (left: string | null | undefined, right: string | null) => {
        if (left === null || left === undefined || right === null) return left === right
        const normalizedRight = normalizeSyncTimestamp(right, 'deleted_at') as string
        return canonicalTimestamp(left) === canonicalTimestamp(normalizedRight)
      }
      if (current && payload && 'deleted_at' in record && current.updatedAt === payload.updatedAt && current.deletedAt === payload.deletedAt && sameDeletedAt(payload.deletedAt, record.deleted_at)) {
        await database.trackerVerification.delete(operation.entityId)
      }
    }
    if (index >= 0) await database.syncOperations.delete(operation.id)
    for (const earlier of (index >= 0 ? queued.slice(0, index) : [])) {
      if (earlier.status === 'blocked') await database.syncOperations.put({ ...earlier, status: 'superseded', supersededAt: new Date().toISOString(), supersededByRevision: record.server_revision })
    }
    if (next && next.status !== 'conflict') await database.syncOperations.put({ ...next, expectedRevision: record.server_revision })
  })
}

async function reconcileServerDeletionLedger(database: ProgressTrackerDatabase, client: SyncClient, userId: string) {
  await accountState(database, userId)
  await assertUser(client, userId)
  const rows: Array<{ user_id: string; tracker_id: string; permanently_deleted_at: string }> = []
  let cursor = ''
  for (;;) {
    let query = client.from('tracker_deletion_ledger').select('user_id,tracker_id,permanently_deleted_at')
      .order('tracker_id', { ascending: true }).limit(pageSize)
    if (cursor) query = query.gt('tracker_id', cursor)
    const { data, error } = await query
    if (error) throw new Error(`Permanent-deletion ledger could not be checked; uploads are paused: ${error.message}`)
    await accountState(database, userId)
    await assertCurrentSession(client, userId)
    const page = (data ?? []) as Array<{ user_id: string; tracker_id: string; permanently_deleted_at: string }>
    if (page.some((row) => row.user_id !== userId)) throw new Error('Deletion ledger returned another account’s record; sync was stopped.')
    rows.push(...page)
    if (page.length < pageSize) break
    cursor = page[page.length - 1]!.tracker_id
    await accountState(database, userId)
    await assertCurrentSession(client, userId)
  }
  await localRepository.reconcilePermanentDeletionLedger(userId, rows.map((row) => ({
    tracker_id: row.tracker_id,
    permanently_deleted_at: normalizeSyncTimestamp(row.permanently_deleted_at, 'permanently_deleted_at') as string,
  })))
}

async function reconcileServerHolidayDeletionLedger(database: ProgressTrackerDatabase, client: SyncClient, userId: string) {
  await accountState(database, userId)
  await assertUser(client, userId)
  const rows: Array<{ user_id: string; holiday_id: string; permanently_deleted_at: string }> = []
  let cursor = ''
  for (;;) {
    let query = client.from('account_holiday_deletion_ledger').select('user_id,holiday_id,permanently_deleted_at')
      .order('holiday_id', { ascending: true }).limit(pageSize)
    if (cursor) query = query.gt('holiday_id', cursor)
    const { data, error } = await query
    if (error) throw new Error(`Holiday deletion ledger could not be checked; uploads are paused: ${error.message}`)
    await accountState(database, userId)
    await assertCurrentSession(client, userId)
    const page = (data ?? []) as Array<{ user_id: string; holiday_id: string; permanently_deleted_at: string }>
    if (page.some((row) => row.user_id !== userId)) throw new Error('Holiday deletion ledger returned another account’s record; sync was stopped.')
    rows.push(...page)
    if (page.length < pageSize) break
    cursor = page[page.length - 1]!.holiday_id
    await accountState(database, userId)
    await assertCurrentSession(client, userId)
  }
  await localRepository.reconcilePermanentHolidayDeletionLedger(userId, rows.map((row) => ({
    holiday_id: row.holiday_id,
    permanently_deleted_at: normalizeSyncTimestamp(row.permanently_deleted_at, 'permanently_deleted_at') as string,
  })))
}

async function processPermanentHolidayDeletionRequests(database: ProgressTrackerDatabase, client: SyncClient, userId: string) {
  if (!isHolidayPermanentDeletionEnabled()) return { deleted: 0, failed: 0, conflicts: 0 }
  const requests = await database.holidayPermanentDeletionRequests.where('ownerUserId').equals(userId).toArray()
  let deleted = 0
  let failed = 0
  let conflicts = 0
  for (const request of requests.filter((item) => item.status === 'pending').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))) {
    try {
      await accountState(database, userId)
      await assertCurrentSession(client, userId)
      const [holiday, revision] = await Promise.all([
        database.accountHolidays.get(request.holidayId), database.syncRecords.get(keyFor('account_holiday', request.holidayId)),
      ])
      if (!holiday?.deletedAt || !revision) throw new Error('The holiday removal must sync successfully before permanent deletion can proceed.')
      publishHolidayDeletionNotification({ status: 'queued', ownerUserId: userId, holidayId: request.holidayId, holidayDate: request.holidayDate })
      const { data, error } = await client.rpc('permanently_delete_account_holiday', {
        p_expected_user_id: userId, p_operation_id: request.id, p_holiday_id: request.holidayId,
        p_expected_revision: revision.serverRevision,
      })
      if (error) throw new Error(error.message)
      const result = data as { status?: string; holiday_id?: string; permanently_deleted_at?: string; record?: ServerHoliday | null }
      if (result?.status === 'conflict') {
        await database.transaction('rw', [database.holidayPermanentDeletionRequests, database.syncConflicts], async () => {
          const current = await database.holidayPermanentDeletionRequests.get(request.id)
          if (current) await database.holidayPermanentDeletionRequests.put({ ...current, status: 'conflict', lastError: 'The cloud holiday changed. Sync and review the conflict before retrying permanent deletion.' })
          await database.syncConflicts.put({ id: request.id, ownerUserId: userId, entity: 'account_holiday', entityId: request.holidayId, localPayload: holiday, remoteRecord: result.record as unknown as Record<string, unknown> | null, detectedAt: new Date().toISOString() })
        })
        publishHolidayDeletionNotification({ status: 'conflict', ownerUserId: userId, holidayId: request.holidayId, holidayDate: request.holidayDate, message: 'The cloud holiday changed. Resolve its sync conflict before retrying permanent deletion.' })
        conflicts += 1
        continue
      }
      if (!['deleted', 'already_deleted'].includes(result?.status ?? '') || result.holiday_id !== request.holidayId || !result.permanently_deleted_at) {
        throw new Error('The server did not confirm permanent holiday deletion.')
      }
      await localRepository.recordPermanentHolidayDeletionConfirmation(userId, {
        holiday_id: request.holidayId,
        permanently_deleted_at: normalizeSyncTimestamp(result.permanently_deleted_at, 'permanently_deleted_at') as string,
      })
      publishHolidayDeletionNotification({ status: 'confirmed', ownerUserId: userId, holidayId: request.holidayId, holidayDate: request.holidayDate })
      deleted += 1
    } catch (cause) {
      const message = errorMessage(cause)
      const current = await database.holidayPermanentDeletionRequests.get(request.id)
      if (current) await database.holidayPermanentDeletionRequests.put({ ...current, lastError: message })
      publishHolidayDeletionNotification({ status: 'failed', ownerUserId: userId, holidayId: request.holidayId, holidayDate: request.holidayDate, message })
      failed += 1
    }
  }
  return { deleted, failed, conflicts }
}

async function processPermanentDeletionRequests(database: ProgressTrackerDatabase, client: SyncClient, userId: string, heldTrackerIds: ReadonlySet<string> = new Set()) {
  if (!isPermanentDeletionEnabled()) return { deleted: 0, failed: 0, conflicts: 0 }
  const requests = await database.permanentDeletionRequests.where('ownerUserId').equals(userId).toArray()
  let deleted = 0
  let failed = 0
  let conflicts = 0
  for (const request of requests.filter((item) => item.status === 'pending' && !heldTrackerIds.has(item.trackerId)).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))) {
    let trackerName = request.trackerId
    try {
      await accountState(database, userId)
      await assertCurrentSession(client, userId)
      const [tracker, revision] = await Promise.all([
        database.trackers.get(request.trackerId), database.syncRecords.get(keyFor('tracker', request.trackerId)),
      ])
      if (!request.winsRetention) throw new PermanentDeletionRejectedError('This saved request needs a Wins retention choice. Reopen the Bin and choose how its XP and achievements should be handled.')
      if (!tracker?.deletedAt || !revision) throw new Error('The Bin deletion must sync successfully before permanent deletion can proceed.')
      trackerName = tracker.name
      publishPermanentDeletionNotification({ status: 'queued', ownerUserId: userId, trackerId: request.trackerId, trackerName })
      const { data, error } = await client.rpc('permanently_delete_tracker', {
        p_expected_user_id: userId, p_operation_id: request.id, p_tracker_id: request.trackerId,
        p_expected_revision: revision.serverRevision, p_wins_retention: request.winsRetention,
      })
      if (error) {
        if (error.code === '55000') {
          throw new PermanentDeletionRejectedError(request.winsRetention === 'delete_wins'
            ? 'Delete Tracker and Wins is unavailable because some rewards cannot be safely separated. Nothing was deleted. Choose Keep My Wins to preserve them.'
            : 'This tracker could not be deleted safely. Nothing was deleted. Your tracker is still in the Bin.')
        }
        if (error.code === '22023') throw new PermanentDeletionRejectedError('Move this tracker to the Bin before permanently deleting it.')
        if (error.code === '42501') throw new PermanentDeletionRejectedError('You don’t have access to delete this tracker. Sign in to the account that owns it.')
        if (error.code === 'PGRST202') throw new PermanentDeletionRejectedError('Permanent deletion is unavailable right now. Your tracker is still in the Bin.')
        throw new Error(error.message)
      }
      const result = data as { status?: string; tracker_id?: string; permanently_deleted_at?: string; record?: ServerTracker | null }
      if (result?.status === 'conflict') {
        await database.transaction('rw', [database.permanentDeletionRequests, database.syncConflicts], async () => {
          const current = await database.permanentDeletionRequests.get(request.id)
          if (current) await database.permanentDeletionRequests.put({ ...current, status: 'conflict', lastError: 'The cloud tracker changed. Resolve its sync conflict before deleting it permanently.' })
          await database.syncConflicts.put({ id: request.id, ownerUserId: userId, entity: 'tracker', entityId: request.trackerId, localPayload: tracker, remoteRecord: result.record as unknown as Record<string, unknown> | null, detectedAt: new Date().toISOString() })
        })
        publishPermanentDeletionNotification({ status: 'conflict', ownerUserId: userId, trackerId: request.trackerId, trackerName: tracker.name, message: 'The cloud tracker changed. Resolve its sync conflict before retrying permanent deletion.' })
        conflicts += 1
        continue
      }
      if (!['deleted', 'already_deleted'].includes(result?.status ?? '') || result.tracker_id !== request.trackerId) throw new Error('The server did not confirm permanent deletion.')
      await localRepository.recordPermanentDeletionConfirmation(userId, {
        tracker_id: request.trackerId,
        permanently_deleted_at: normalizeSyncTimestamp(result.permanently_deleted_at ?? new Date().toISOString(), 'permanently_deleted_at') as string,
      })
      deleted += 1
    } catch (cause) {
      const current = await database.permanentDeletionRequests.get(request.id)
      const message = cause instanceof PermanentDeletionRejectedError
        ? errorMessage(cause)
        : 'We couldn’t confirm permanent deletion. Your tracker is still in the Bin. Reconnect and try again.'
      if (current) await database.permanentDeletionRequests.put({ ...current, status: cause instanceof PermanentDeletionRejectedError ? 'failed' : 'pending', lastError: message })
      publishPermanentDeletionNotification({ status: 'failed', ownerUserId: userId, trackerId: request.trackerId, trackerName, message })
      failed += 1
    }
  }
  return { deleted, failed, conflicts }
}

async function uploadQueue(database: ProgressTrackerDatabase, client: SyncClient, userId: string, entity: 'tracker' | 'tracker_entry' | 'account_holiday', heldTrackerIds: ReadonlySet<string> = new Set()): Promise<{ uploaded: number; conflicts: number; failed: number }> {
  const allOperations = await database.syncOperations.where('ownerUserId').equals(userId).toArray()
  const candidates = allOperations
    .filter((operation) => operation.entity === entity && operation.status !== 'conflict' && operation.status !== 'blocked' && operation.status !== 'superseded' && operation.status !== 'discarded')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const entriesById = entity === 'tracker_entry'
    ? await database.trackerEntries.bulkGet(candidates.map((operation) => operation.entityId))
    : []
  const operations = candidates.filter((operation, index) => {
    if (entity !== 'tracker_entry') return true
    const payloadTrackerId = (operation.payload as StoredTrackerEntry | undefined)?.trackerId
    const localTrackerId = entriesById[index]?.trackerId
    // A blocked or conflicted definition is not an acknowledgement. Keep its dependent
    // check-ins queued until a newer tracker write succeeds and supersedes it.
    return !heldTrackerIds.has(payloadTrackerId ?? localTrackerId ?? '')
  })
  let uploaded = 0
  let conflicts = 0
  let failed = 0
  for (const queued of operations) {
    let operation: SyncOperation | undefined
    let phase: 'workspace-preflight' | 'payload-validation' | 'server-request' | 'server-acknowledgement' = 'workspace-preflight'
    try {
      operation = await database.syncOperations.get(queued.id)
      if (!operation || operation.status === 'conflict' || operation.status === 'blocked' || operation.status === 'superseded' || operation.status === 'discarded') continue
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 10 && !isSchemaV10WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v10 versioned tracker rule cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 9 && !isSchemaV9WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v9 typed milestone cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 8 && !isSchemaV8WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v8 streak-rule cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 3 && !isSchemaV3WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v3 cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 4 && !isSchemaV4WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v4 precision cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 5 && !isSchemaV5WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v5 manual goal allocation cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 7 && !isSchemaV7WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v7 Effective Days counting cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 6 && !isSchemaV6WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v6 scheduling cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      await accountState(database, userId)
      await assertCurrentSession(client, userId)
      operation = await markInFlight(database, operation.id)
      if (!operation) continue
      // Keep the operation ID and payload durable before sending the RPC. If the
      // server commits but its response is interrupted, a retry replays its receipt.
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 10 && !isSchemaV10WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v10 versioned tracker rule cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 9 && !isSchemaV9WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v9 typed milestone cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 8 && !isSchemaV8WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v8 streak-rule cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 3 && !isSchemaV3WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v3 cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 4 && !isSchemaV4WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v4 precision cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 5 && !isSchemaV5WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v5 manual goal allocation cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 7 && !isSchemaV7WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v7 Effective Days counting cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 6 && !isSchemaV6WriteEnabled()) {
        reportUnsupportedSyncSchema(operation)
        await markPermanentlyBlocked(database, operation, 'UNSUPPORTED_SCHEMA_VERSION', 'Schema v6 scheduling cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        continue
      }
      await accountState(database, userId)
      await assertCurrentSession(client, userId)
      phase = 'payload-validation'
      const payload = toServerPayload(operation)
      const uploadMeasure = measureDevPerformance(`sync.${operation.entity}-write`)
      if (operation.entity === 'tracker_entry') countDevPerformance('sync.tracker-entry-write-request')
      let rpcResponse: Awaited<ReturnType<typeof client.rpc>>
      phase = 'server-request'
      try {
        rpcResponse = operation.entity === 'account_holiday'
          ? await client.rpc('apply_account_holiday_sync_operation', {
          p_expected_user_id: userId, p_operation_id: operation.id,
          p_expected_revision: operation.expectedRevision, p_record: payload,
        })
          : await client.rpc('apply_tracker_sync_operation', {
          p_expected_user_id: userId, p_operation_id: operation.id, p_entity: operation.entity,
          p_expected_revision: operation.expectedRevision, p_record: payload,
        })
      } finally { uploadMeasure() }
      const { data, error } = rpcResponse
      if (error?.code === '23505' && operation.entity === 'tracker_entry') {
        const payload = operation.payload as StoredTrackerEntry
        await assertCurrentSession(client, userId)
        const { data: duplicate, error: duplicateError } = await client.from('tracker_entries').select('*')
          .eq('user_id', userId).eq('tracker_id', payload.trackerId).eq('entry_date', payload.date).maybeSingle()
        if (duplicateError) throw new Error(duplicateError.message)
        if (duplicate && duplicate.user_id === userId) {
          await markConflict(database, operation, duplicate as Record<string, unknown>)
          conflicts += 1
          continue
        }
      }
      if (error) {
        if (isPermanentWriteRejection(error.code)) {
          const schemaFailure = isUnsupportedSchemaFailure(new Error(error.message))
          reportTrackerWriteDiagnostic({
            category: schemaFailure ? 'unsupported-schema-version' : 'server-validation-rejection',
            phase: 'server-request',
            ...(operation.entity === 'tracker' ? { schemaVersion: (operation.payload as StoredTrackerDefinition).schemaVersion } : {}),
            entity: operation.entity as 'tracker' | 'tracker_entry' | 'account_holiday',
            serverCode: error.code,
          })
          // A validation rejection is not evidence of a concurrent cloud edit.
          // Keep the operation and local payload as a blocked diagnostic record.
          // It will not be retried automatically; a later corrected operation
          // can proceed and will mark this record superseded after server ack.
          await markPermanentlyBlocked(database, operation, error.code!, 'Your saved payload is retained. Review the server reason, correct the tracker, and save a new version.', error.message)
          failed += 1
          continue
        }
        throw new Error(error.message)
      }
      const result = data as OperationResult
      if (operation.entity === 'account_holiday' && result?.status === 'permanently_deleted') {
        if (result.holiday_id !== operation.entityId || !result.permanently_deleted_at) throw new Error('The permanent-holiday deletion response did not match the queued holiday.')
        await localRepository.recordPermanentHolidayDeletionConfirmation(userId, {
          holiday_id: operation.entityId,
          permanently_deleted_at: normalizeSyncTimestamp(result.permanently_deleted_at, 'permanently_deleted_at') as string,
        })
        uploaded += 1
        continue
      }
      if ((result as { status?: string })?.status === 'permanently_deleted') {
        const trackerId = operation.entity === 'tracker'
          ? operation.entityId
          : (operation.payload as StoredTrackerEntry).trackerId
        const deletionResult = result as OperationResult & { permanently_deleted_at?: string; tracker_id?: string }
        if (deletionResult.tracker_id !== trackerId) throw new Error('Permanent-deletion response did not match the queued tracker.')
        await localRepository.recordPermanentDeletionConfirmation(userId, {
          tracker_id: trackerId,
          permanently_deleted_at: normalizeSyncTimestamp(deletionResult.permanently_deleted_at ?? new Date().toISOString(), 'permanently_deleted_at') as string,
        })
        uploaded += 1
        continue
      }
      if ((result as { status?: string })?.status === 'parent_in_bin') {
        await markFailure(database, operation, 'This tracker is in the Bin. Its entry changes remain queued until the tracker is restored.')
        failed += 1
        break
      }
      if (result?.status === 'conflict') {
        if (result.record && result.record.user_id !== userId) throw new Error('The server returned a row for a different account; it was not saved locally.')
        reportTrackerWriteDiagnostic({ category: 'revision-conflict', phase: 'server-request', ...(operation.entity === 'tracker' ? { schemaVersion: (operation.payload as StoredTrackerDefinition).schemaVersion } : {}), entity: operation.entity as 'tracker' | 'tracker_entry' | 'account_holiday' })
        await markConflict(database, operation, result.record as unknown as Record<string, unknown> | null)
        conflicts += 1
        break
      }
      if (result?.status !== 'applied' || !result.record || result.record.user_id !== userId) throw new Error('The sync server returned an invalid or differently owned result.')
      phase = 'server-acknowledgement'
      await acknowledge(database, operation, result.record)
      uploaded += 1
    } catch (cause) {
      const invalidDefinition = phase === 'payload-validation' && cause instanceof Error && cause.name === 'ZodError'
      const category = invalidDefinition ? 'invalid-tracker-definition'
        : phase === 'server-acknowledgement' ? 'local-persistence-failure'
          : isUnsupportedSchemaFailure(cause) ? 'unsupported-schema-version'
            : isNetworkFailure(cause) ? 'network-failure' : 'sync-failure'
      reportTrackerWriteDiagnostic({
        category,
        phase,
        ...(operation?.entity === 'tracker' ? { schemaVersion: (operation.payload as StoredTrackerDefinition | undefined)?.schemaVersion } : {}),
        ...(operation ? { entity: operation.entity as 'tracker' | 'tracker_entry' | 'account_holiday' } : {}),
      })
      if (operation && invalidDefinition) {
        await markPermanentlyBlocked(database, operation, 'LOCAL_INVALID_DEFINITION', errorMessage(cause))
        failed += 1
        continue
      }
      if (operation) await markFailure(database, operation, errorMessage(cause))
      failed += 1
      // Entry writes depend on tracker writes; stop this entity queue on first failure.
      if (entity === 'tracker') break
    }
  }
  return { uploaded, conflicts, failed }
}

async function applyRemoteTracker(database: ProgressTrackerDatabase, userId: string, row: ServerTracker): Promise<{ downloaded: number; conflicts: number; changed?: boolean }> {
  if (row.user_id !== userId) throw new Error('Cloud response contained a tracker owned by another account.')
  const remote = trackerFromServer(row)
  const stateKey = keyFor('tracker', row.id)
  return database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts], async () => {
    const operations = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker', row.id]).toArray()
    const queued = operations.find((operation) => operation.status === 'pending' || operation.status === 'in-flight') ?? operations.find((operation) => operation.status === 'conflict' || operation.status === 'blocked')
    const state = await database.syncRecords.get(stateKey)
    const local = await database.trackers.get(row.id)
    if (queued) {
      if ((queued.status === 'pending' || queued.status === 'in-flight') && queued.expectedRevision !== row.server_revision) {
        await recordQueuedConflict(database, queued, row as unknown as Record<string, unknown>, 'The cloud record changed since this device last read it.')
        return { downloaded: 0, conflicts: 1 }
      }
      return { downloaded: 0, conflicts: 0 }
    }
    if (local && !state) {
      await database.syncConflicts.put({ id: `pull:tracker:${row.id}`, ownerUserId: userId, entity: 'tracker', entityId: row.id, localPayload: local, remoteRecord: row as unknown as Record<string, unknown>, detectedAt: new Date().toISOString() })
      return { downloaded: 0, conflicts: 1 }
    }
    if (!state || !local || row.server_revision > state.serverRevision) {
      if (local) {
        const changed = trackerMetricTypeChange(local, remote)
        const history = await database.trackerEntries.where('[trackerId+date]').between([row.id, '0000-01-01'], [row.id, '9999-12-31']).filter((entry) => entry.deletedAt === null).toArray()
        const historicalMetricIds = new Set(local.metrics.filter((metric) => history.some((entry) => Object.hasOwn(entry.values, metric.id))).map((metric) => metric.id))
        const changedMeaning = historicalMetricMeaningChange(local, remote, historicalMetricIds)
        if (changed || changedMeaning) {
          await database.syncConflicts.put({ id: `pull:tracker:${row.id}`, ownerUserId: userId, entity: 'tracker', entityId: row.id, localPayload: local, remoteRecord: row as unknown as Record<string, unknown>, detectedAt: new Date().toISOString() })
          return { downloaded: 0, conflicts: 1 }
        }
      }
      await database.trackers.put(remote)
      await database.syncRecords.put({ key: stateKey, ownerUserId: userId, entity: 'tracker', entityId: row.id, serverRevision: row.server_revision })
      return { downloaded: local ? 0 : 1, conflicts: 0, changed: true }
    }
    return { downloaded: 0, conflicts: 0 }
  })
}

async function applyRemoteEntry(database: ProgressTrackerDatabase, userId: string, row: ServerEntry): Promise<{ downloaded: number; conflicts: number; changed?: boolean }> {
  if (row.user_id !== userId) throw new Error('Cloud response contained an entry owned by another account.')
  const remote = entryFromServer(row)
  const stateKey = keyFor('tracker_entry', row.id)
  return database.transaction('rw', [database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts], async () => {
    const operations = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', row.id]).toArray()
    const queued = operations.find((operation) => operation.status === 'pending' || operation.status === 'in-flight') ?? operations.find((operation) => operation.status === 'conflict' || operation.status === 'blocked')
    const state = await database.syncRecords.get(stateKey)
    const local = await database.trackerEntries.get(row.id)
    if (queued) {
      if ((queued.status === 'pending' || queued.status === 'in-flight') && queued.expectedRevision !== row.server_revision) {
        await recordQueuedConflict(database, queued, row as unknown as Record<string, unknown>, 'The cloud record changed since this device last read it.')
        return { downloaded: 0, conflicts: 1 }
      }
      return { downloaded: 0, conflicts: 0 }
    }
    if (local && !state) {
      await database.syncConflicts.put({ id: `pull:tracker_entry:${row.id}`, ownerUserId: userId, entity: 'tracker_entry', entityId: row.id, localPayload: local, remoteRecord: row as unknown as Record<string, unknown>, detectedAt: new Date().toISOString() })
      return { downloaded: 0, conflicts: 1 }
    }
    if (!state || !local || row.server_revision > state.serverRevision) {
      await database.trackerEntries.put(remote)
      await database.syncRecords.put({ key: stateKey, ownerUserId: userId, entity: 'tracker_entry', entityId: row.id, serverRevision: row.server_revision })
      return { downloaded: local ? 0 : 1, conflicts: 0, changed: true }
    }
    return { downloaded: 0, conflicts: 0 }
  })
}

async function applyRemoteHoliday(database: ProgressTrackerDatabase, userId: string, row: ServerHoliday): Promise<{ downloaded: number; conflicts: number; changed?: boolean }> {
  if (row.user_id !== userId) throw new Error('Cloud response contained a holiday owned by another account.')
  const remote: AccountHoliday = { id: row.id, date: row.holiday_date as AccountHoliday['date'], reason: row.reason, createdAt: normalizeSyncTimestamp(row.created_at, 'created_at') as string, updatedAt: normalizeSyncTimestamp(row.updated_at, 'updated_at') as string, deletedAt: row.deleted_at === null ? null : normalizeSyncTimestamp(row.deleted_at, 'deleted_at') as string }
  if (remote.reason !== null && !['travel', 'exam', 'personal', 'other'].includes(remote.reason)) throw new Error('Cloud holiday has an unsupported reason.')
  const stateKey = keyFor('account_holiday', row.id)
  return database.transaction('rw', [database.accountHolidays, database.syncOperations, database.syncRecords, database.syncConflicts], async () => {
    const operations = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'account_holiday', row.id]).toArray()
    const queued = operations.find((operation) => operation.status === 'pending' || operation.status === 'in-flight') ?? operations.find((operation) => operation.status === 'conflict' || operation.status === 'blocked')
    const state = await database.syncRecords.get(stateKey)
    const local = await database.accountHolidays.get(row.id)
    if (queued) {
      if ((queued.status === 'pending' || queued.status === 'in-flight') && queued.expectedRevision !== row.server_revision) {
        await recordQueuedConflict(database, queued, row as unknown as Record<string, unknown>, 'The cloud holiday changed since this device last read it.')
        return { downloaded: 0, conflicts: 1 }
      }
      return { downloaded: 0, conflicts: 0 }
    }
    if (local && !state) {
      await database.syncConflicts.put({ id: `pull:account_holiday:${row.id}`, ownerUserId: userId, entity: 'account_holiday', entityId: row.id, localPayload: local, remoteRecord: row as unknown as Record<string, unknown>, detectedAt: new Date().toISOString() })
      return { downloaded: 0, conflicts: 1 }
    }
    if (!state || !local || row.server_revision > state.serverRevision) {
      await database.accountHolidays.put(remote)
      await database.syncRecords.put({ key: stateKey, ownerUserId: userId, entity: 'account_holiday', entityId: row.id, serverRevision: row.server_revision })
      return { downloaded: local ? 0 : 1, conflicts: 0, changed: true }
    }
    return { downloaded: 0, conflicts: 0 }
  })
}

async function pullTable<T extends ServerTracker | ServerEntry | ServerHoliday>(database: ProgressTrackerDatabase, client: SyncClient, userId: string, table: 'trackers' | 'tracker_entries' | 'account_holidays', apply: (row: T) => Promise<{ downloaded: number; conflicts: number; changed?: boolean }>) {
  let cursor = ''
  let downloaded = 0
  let conflicts = 0
  let changed = 0
  for (;;) {
    await accountState(database, userId)
    await assertUser(client, userId)
    let query = client.from(table).select('*').order('id', { ascending: true }).limit(pageSize)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    await accountState(database, userId)
    await assertCurrentSession(client, userId)
    const rows = (data ?? []) as T[]
    if (!rows.length) break
    for (const row of rows) {
      if (row.user_id !== userId) throw new Error('The cloud returned a record for a different account; this page was not merged.')
      // Row ownership is checked above; the server identity was revalidated
      // immediately after the RLS-scoped page response. Keep per-row workspace
      // and local-session checks before IndexedDB writes without another Auth
      // network request for each row.
      await accountState(database, userId)
      await assertCurrentSession(client, userId)
      const result = await apply(row)
      downloaded += result.downloaded
      conflicts += result.conflicts
      if (result.changed) changed += 1
    }
    cursor = rows[rows.length - 1]!.id
    if (rows.length < pageSize) break
  }
  return { downloaded, conflicts, changed }
}

async function runSynchronizationCore(userId: string, injectedClient?: SupabaseClient): Promise<SyncSummary> {
  const client = (injectedClient ?? getSupabaseClient()) as SyncClient | null
  if (!client) throw new Error('Supabase is not configured; local changes remain saved on this device.')
  const database = await openDatabase()
  await accountState(database, userId)
  await database.transaction('rw', [database.workspaceMetadata, database.syncOperations, database.syncConflicts], () => migrateLegacyRejectedConflicts(database, userId))
  await assertUser(client, userId)
  const localSettings = await localRepository.getAppSettings(userId)
  const accountTimeZone = await ensureAccountWorkspaceTimeZone(userId, localSettings.timezone, client as unknown as SupabaseClient)
  if (!accountTimeZone) throw new Error('Sync stopped because the workspace time zone could not be saved to your account.')
  if (accountTimeZone !== localSettings.timezone) await localRepository.setTimeZone(accountTimeZone, userId)

  if (isPermanentDeletionEnabled()) await reconcileServerDeletionLedger(database, client, userId)
  if (isHolidayPermanentDeletionEnabled()) await reconcileServerHolidayDeletionLedger(database, client, userId)

  const trackers = await uploadQueue(database, client, userId, 'tracker')
  const remainingTrackerOperations = await database.syncOperations.where('ownerUserId').equals(userId).toArray()
  const unacknowledgedTrackerIds = new Set(remainingTrackerOperations.filter((operation) => operation.entity === 'tracker' && (operation.status === 'blocked' || operation.status === 'conflict')).map((operation) => operation.entityId))
  const deletionRequests = trackers.failed || trackers.conflicts ? { deleted: 0, conflicts: 0, failed: 0 } : await processPermanentDeletionRequests(database, client, userId, unacknowledgedTrackerIds)
  const entries = trackers.failed || trackers.conflicts || deletionRequests.failed || deletionRequests.conflicts ? { uploaded: 0, conflicts: 0, failed: 0 } : await uploadQueue(database, client, userId, 'tracker_entry', unacknowledgedTrackerIds)
  // The entry write RPC commits progression triggers in the same transaction.
  // Refresh Wins as soon as that acknowledgment arrives instead of waiting for
  // unrelated holiday work and full-table pulls later in this sync pass.
  if (entries.uploaded > 0) publishWorkspaceProgressionConfirmed(userId)
  const holidays = await uploadQueue(database, client, userId, 'account_holiday')
  const holidayDeletions = holidays.failed || holidays.conflicts
    ? { deleted: 0, conflicts: 0, failed: 0 }
    : await processPermanentHolidayDeletionRequests(database, client, userId)
  const trackerPull = await pullTable<ServerTracker>(database, client, userId, 'trackers', (row) => applyRemoteTracker(database, userId, row))
  const entryPull = await pullTable<ServerEntry>(database, client, userId, 'tracker_entries', (row) => applyRemoteEntry(database, userId, row))
  const holidayPull = await pullTable<ServerHoliday>(database, client, userId, 'account_holidays', (row) => applyRemoteHoliday(database, userId, row))
  const openConflicts = await database.syncConflicts.where('ownerUserId').equals(userId).count()
  const downloaded = trackerPull.downloaded + entryPull.downloaded + holidayPull.downloaded
  const changed = trackerPull.changed + entryPull.changed + holidayPull.changed
  // Progression views need server confirmation even when an upload did not
  // change the local workspace records. Other mounted local views do not.
  if (changed > 0) publishWorkspaceDataChange(userId)
  // The sync RPC and its database triggers commit before this point. Signal even
  // after downloaded changes so confirmed progression consumers refresh once.
  if (entries.uploaded === 0 || changed > 0) publishWorkspaceSyncCompleted(userId)
  return { uploaded: trackers.uploaded + entries.uploaded + holidays.uploaded + deletionRequests.deleted + holidayDeletions.deleted, downloaded, conflicts: openConflicts, failed: trackers.failed + entries.failed + holidays.failed + deletionRequests.failed + holidayDeletions.failed }
}

async function runSynchronization(userId: string, injectedClient?: SupabaseClient): Promise<SyncSummary> {
  const measure = measureDevPerformance('sync.workspace')
  try { return await runSynchronizationCore(userId, injectedClient) }
  catch (cause) {
    const category = cause instanceof Error && cause.name === 'ZodError' ? 'invalid-tracker-definition'
      : isUnsupportedSchemaFailure(cause) ? 'unsupported-schema-version'
        : isNetworkFailure(cause) ? 'network-failure' : 'sync-failure'
    reportTrackerWriteDiagnostic({ category, phase: 'workspace-preflight' })
    throw cause
  }
  finally { measure() }
}

/**
 * Runs one account-scoped sync at a time. Concurrent requests for the same
 * account join the active operation; other accounts wait for the current
 * IndexedDB workspace operation to finish before opening their workspace.
 */
export function synchronizeWorkspace(userId: string, injectedClient?: SupabaseClient): Promise<SyncSummary> {
  const active = inFlightByUser.get(userId)
  if (active) return active

  const operation = syncQueue.then(() => runSynchronization(userId, injectedClient))
  syncQueue = operation.then(() => undefined, () => undefined)
  inFlightByUser.set(userId, operation)
  void operation.then(
    () => { if (inFlightByUser.get(userId) === operation) inFlightByUser.delete(userId) },
    () => { if (inFlightByUser.get(userId) === operation) inFlightByUser.delete(userId) },
  )
  return operation
}
