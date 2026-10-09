import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProgressTrackerDatabase } from '../../db/database'
import { openDatabase } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition, StoredTrackerEntry, SyncOperation, SyncRecordState } from '../../db/models'
import { trackerDefinitionSchema, trackerEntrySchema } from '../../domain/trackers/schema'
import { isPermanentDeletionEnabled, isSchemaV3WriteEnabled } from '../../domain/trackers/schemaVersionGate'
import { getSupabaseClient } from './client'
import { normalizeSyncTimestamp, normalizeTrackerEntryTimestamps, normalizeTrackerTimestamps } from './syncTimestamps'

type ServerTracker = { id: string; user_id: string; schema_version: number; kind: string; status: string; name: string; definition: unknown; created_at: string; updated_at: string; deleted_at: string | null; server_revision: number }
type ServerEntry = { id: string; user_id: string; tracker_id: string; entry_date: string; outcome: 'recorded' | 'skipped'; entry_values: Record<string, unknown>; note: string; created_at: string; updated_at: string; deleted_at: string | null; server_revision: number }
type OperationResult = { status: 'applied' | 'conflict'; record: ServerTracker | ServerEntry | null }
type SyncClient = Pick<SupabaseClient, 'auth'> & {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>
  from: (table: string) => any
}

export type SyncSummary = { uploaded: number; downloaded: number; conflicts: number; failed: number }
const pageSize = 200
const inFlightByUser = new Map<string, Promise<SyncSummary>>()
let syncQueue: Promise<void> = Promise.resolve()

function keyFor(entity: 'tracker' | 'tracker_entry', id: string) { return `${entity}:${id}` }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Sync could not complete. Your local records are retained.' }

function toServerPayload(operation: SyncOperation): Record<string, unknown> {
  if (!operation.payload) throw new Error('This sync operation has no saved record payload.')
  if (operation.entity === 'tracker') {
    // Older IndexedDB rows can contain an equivalent PostgreSQL/offset timestamp.
    // Canonicalize the outgoing copy; leave the persisted local record untouched.
    const tracker = trackerDefinitionSchema.parse(normalizeTrackerTimestamps(operation.payload))
    return { id: tracker.id, schema_version: tracker.schemaVersion, kind: tracker.kind, status: tracker.status, name: tracker.name, definition: tracker, created_at: tracker.createdAt, updated_at: tracker.updatedAt, deleted_at: tracker.deletedAt }
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

async function accountState(database: ProgressTrackerDatabase, expectedUserId: string) {
  const metadata = await database.workspaceMetadata.get('workspace')
  if (!metadata || metadata.userId !== expectedUserId) throw new Error('Sync stopped because this local database is not owned by the authenticated account.')
}

async function markFailure(database: ProgressTrackerDatabase, operation: SyncOperation, message: string) {
  const latest = await database.syncOperations.get(operation.id)
  if (latest) await database.syncOperations.put({ ...latest, attempts: latest.attempts + 1, lastError: message })
}

async function markConflict(database: ProgressTrackerDatabase, operation: SyncOperation, remoteRecord: Record<string, unknown> | null) {
  await database.transaction('rw', [database.syncOperations, database.syncConflicts], async () => {
    const latest = await database.syncOperations.get(operation.id)
    if (latest) await database.syncOperations.put({ ...latest, status: 'conflict', attempts: latest.attempts + 1, lastError: 'The cloud record changed since this device last read it.' })
    await database.syncConflicts.put({ id: operation.id, ownerUserId: operation.ownerUserId!, entity: operation.entity as 'tracker' | 'tracker_entry', entityId: operation.entityId, localPayload: operation.payload!, remoteRecord, detectedAt: new Date().toISOString() })
  })
}

async function acknowledge(database: ProgressTrackerDatabase, operation: SyncOperation, record: ServerTracker | ServerEntry) {
  if (!operation.ownerUserId) throw new Error('This queued operation has no authenticated owner.')
  const revision: SyncRecordState = { key: keyFor(operation.entity as 'tracker' | 'tracker_entry', operation.entityId), ownerUserId: operation.ownerUserId!, entity: operation.entity as 'tracker' | 'tracker_entry', entityId: operation.entityId, serverRevision: record.server_revision }
  await database.transaction('rw', [database.syncOperations, database.syncRecords, database.trackerVerification], async () => {
    await database.syncRecords.put(revision)
    if (operation.entity === 'tracker') await database.trackerVerification.delete(operation.entityId)
    const latest = await database.syncOperations.filter((candidate) => candidate.ownerUserId === operation.ownerUserId && candidate.entity === operation.entity && candidate.entityId === operation.entityId).first()
    if (latest?.id === operation.id) await database.syncOperations.delete(latest.id)
    else if (latest) await database.syncOperations.put({ ...latest, expectedRevision: record.server_revision })
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
    const page = (data ?? []) as Array<{ user_id: string; tracker_id: string; permanently_deleted_at: string }>
    if (page.some((row) => row.user_id !== userId)) throw new Error('Deletion ledger returned another account’s record; sync was stopped.')
    rows.push(...page)
    if (page.length < pageSize) break
    cursor = page[page.length - 1]!.tracker_id
    await accountState(database, userId)
    await assertUser(client, userId)
  }
  await localRepository.reconcilePermanentDeletionLedger(userId, rows.map((row) => ({
    tracker_id: row.tracker_id,
    permanently_deleted_at: normalizeSyncTimestamp(row.permanently_deleted_at, 'permanently_deleted_at') as string,
  })))
}

async function processPermanentDeletionRequests(database: ProgressTrackerDatabase, client: SyncClient, userId: string) {
  if (!isPermanentDeletionEnabled()) return { deleted: 0, failed: 0, conflicts: 0 }
  const requests = await database.permanentDeletionRequests.where('ownerUserId').equals(userId).toArray()
  let deleted = 0
  let failed = 0
  let conflicts = 0
  for (const request of requests.filter((item) => item.status === 'pending').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))) {
    try {
      await accountState(database, userId)
      await assertUser(client, userId)
      const [tracker, revision] = await Promise.all([
        database.trackers.get(request.trackerId), database.syncRecords.get(keyFor('tracker', request.trackerId)),
      ])
      if (!tracker?.deletedAt || !revision) throw new Error('The Bin deletion must sync successfully before permanent deletion can proceed.')
      const { data, error } = await client.rpc('permanently_delete_tracker', {
        p_expected_user_id: userId, p_operation_id: request.id, p_tracker_id: request.trackerId,
        p_expected_revision: revision.serverRevision,
      })
      if (error) throw new Error(error.message)
      const result = data as { status?: string; tracker_id?: string; permanently_deleted_at?: string; record?: ServerTracker | null }
      if (result?.status === 'conflict') {
        await database.transaction('rw', [database.permanentDeletionRequests, database.syncConflicts], async () => {
          const current = await database.permanentDeletionRequests.get(request.id)
          if (current) await database.permanentDeletionRequests.put({ ...current, status: 'conflict', lastError: 'The cloud tracker changed. Resolve its sync conflict before deleting it permanently.' })
          await database.syncConflicts.put({ id: request.id, ownerUserId: userId, entity: 'tracker', entityId: request.trackerId, localPayload: tracker, remoteRecord: result.record as unknown as Record<string, unknown> | null, detectedAt: new Date().toISOString() })
        })
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
      if (current) await database.permanentDeletionRequests.put({ ...current, status: 'pending', lastError: errorMessage(cause) })
      failed += 1
    }
  }
  return { deleted, failed, conflicts }
}

async function uploadQueue(database: ProgressTrackerDatabase, client: SyncClient, userId: string, entity: 'tracker' | 'tracker_entry'): Promise<{ uploaded: number; conflicts: number; failed: number }> {
  const operations = (await database.syncOperations.where('ownerUserId').equals(userId).toArray())
    .filter((operation) => operation.entity === entity && operation.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  let uploaded = 0
  let conflicts = 0
  let failed = 0
  for (const operation of operations) {
    try {
      if (operation.entity === 'tracker' && (operation.payload as StoredTrackerDefinition).schemaVersion === 3 && !isSchemaV3WriteEnabled()) {
        await markFailure(database, operation, 'Schema v3 cloud writes are disabled until the hosted migration is applied and verified.')
        failed += 1
        break
      }
      await accountState(database, userId)
      await assertUser(client, userId)
      const payload = toServerPayload(operation)
      const { data, error } = await client.rpc('apply_tracker_sync_operation', {
        p_expected_user_id: userId,
        p_operation_id: operation.id,
        p_entity: operation.entity,
        p_expected_revision: operation.expectedRevision,
        p_record: payload,
      })
      if (error?.code === '23505' && operation.entity === 'tracker_entry') {
        const payload = operation.payload as StoredTrackerEntry
        await assertUser(client, userId)
        const { data: duplicate, error: duplicateError } = await client.from('tracker_entries').select('*')
          .eq('user_id', userId).eq('tracker_id', payload.trackerId).eq('entry_date', payload.date).maybeSingle()
        if (duplicateError) throw new Error(duplicateError.message)
        if (duplicate && duplicate.user_id === userId) {
          await markConflict(database, operation, duplicate as Record<string, unknown>)
          conflicts += 1
          continue
        }
      }
      if (error) throw new Error(error.message)
      const result = data as OperationResult
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
        await markConflict(database, operation, result.record as unknown as Record<string, unknown> | null)
        conflicts += 1
        continue
      }
      if (result?.status !== 'applied' || !result.record || result.record.user_id !== userId) throw new Error('The sync server returned an invalid or differently owned result.')
      await acknowledge(database, operation, result.record)
      uploaded += 1
    } catch (cause) {
      await markFailure(database, operation, errorMessage(cause))
      failed += 1
      // Entry writes depend on tracker writes; stop this entity queue on first failure.
      if (entity === 'tracker') break
    }
  }
  return { uploaded, conflicts, failed }
}

async function applyRemoteTracker(database: ProgressTrackerDatabase, userId: string, row: ServerTracker): Promise<{ downloaded: number; conflicts: number }> {
  if (row.user_id !== userId) throw new Error('Cloud response contained a tracker owned by another account.')
  const remote = trackerFromServer(row)
  const stateKey = keyFor('tracker', row.id)
  return database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.syncConflicts], async () => {
    const queued = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker', row.id]).first()
    const state = await database.syncRecords.get(stateKey)
    const local = await database.trackers.get(row.id)
    if (queued) {
      if (queued.status === 'pending' && queued.expectedRevision !== row.server_revision) {
        await database.syncOperations.put({ ...queued, status: 'conflict', attempts: queued.attempts + 1, lastError: 'The cloud record changed since this device last read it.' })
        await database.syncConflicts.put({ id: queued.id, ownerUserId: userId, entity: 'tracker', entityId: row.id, localPayload: queued.payload as StoredTrackerDefinition, remoteRecord: row as unknown as Record<string, unknown>, detectedAt: new Date().toISOString() })
        return { downloaded: 0, conflicts: 1 }
      }
      return { downloaded: 0, conflicts: 0 }
    }
    if (local && !state) {
      await database.syncConflicts.put({ id: `pull:tracker:${row.id}`, ownerUserId: userId, entity: 'tracker', entityId: row.id, localPayload: local, remoteRecord: row as unknown as Record<string, unknown>, detectedAt: new Date().toISOString() })
      return { downloaded: 0, conflicts: 1 }
    }
    if (!state || row.server_revision >= state.serverRevision) {
      await database.trackers.put(remote)
      await database.syncRecords.put({ key: stateKey, ownerUserId: userId, entity: 'tracker', entityId: row.id, serverRevision: row.server_revision })
      return { downloaded: local ? 0 : 1, conflicts: 0 }
    }
    return { downloaded: 0, conflicts: 0 }
  })
}

async function applyRemoteEntry(database: ProgressTrackerDatabase, userId: string, row: ServerEntry): Promise<{ downloaded: number; conflicts: number }> {
  if (row.user_id !== userId) throw new Error('Cloud response contained an entry owned by another account.')
  const remote = entryFromServer(row)
  const stateKey = keyFor('tracker_entry', row.id)
  return database.transaction('rw', [database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts], async () => {
    const queued = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', row.id]).first()
    const state = await database.syncRecords.get(stateKey)
    const local = await database.trackerEntries.get(row.id)
    if (queued) {
      if (queued.status === 'pending' && queued.expectedRevision !== row.server_revision) {
        await database.syncOperations.put({ ...queued, status: 'conflict', attempts: queued.attempts + 1, lastError: 'The cloud record changed since this device last read it.' })
        await database.syncConflicts.put({ id: queued.id, ownerUserId: userId, entity: 'tracker_entry', entityId: row.id, localPayload: queued.payload as StoredTrackerEntry, remoteRecord: row as unknown as Record<string, unknown>, detectedAt: new Date().toISOString() })
        return { downloaded: 0, conflicts: 1 }
      }
      return { downloaded: 0, conflicts: 0 }
    }
    if (local && !state) {
      await database.syncConflicts.put({ id: `pull:tracker_entry:${row.id}`, ownerUserId: userId, entity: 'tracker_entry', entityId: row.id, localPayload: local, remoteRecord: row as unknown as Record<string, unknown>, detectedAt: new Date().toISOString() })
      return { downloaded: 0, conflicts: 1 }
    }
    if (!state || row.server_revision >= state.serverRevision) {
      await database.trackerEntries.put(remote)
      await database.syncRecords.put({ key: stateKey, ownerUserId: userId, entity: 'tracker_entry', entityId: row.id, serverRevision: row.server_revision })
      return { downloaded: local ? 0 : 1, conflicts: 0 }
    }
    return { downloaded: 0, conflicts: 0 }
  })
}

async function pullTable<T extends ServerTracker | ServerEntry>(database: ProgressTrackerDatabase, client: SyncClient, userId: string, table: 'trackers' | 'tracker_entries', apply: (row: T) => Promise<{ downloaded: number; conflicts: number }>) {
  let cursor = ''
  let downloaded = 0
  let conflicts = 0
  for (;;) {
    await accountState(database, userId)
    await assertUser(client, userId)
    let query = client.from(table).select('*').order('id', { ascending: true }).limit(pageSize)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    if (!rows.length) break
    for (const row of rows) {
      if (row.user_id !== userId) throw new Error('The cloud returned a record for a different account; this page was not merged.')
      // A session may change while the page request is in flight. Recheck before
      // applying each row so a response fetched under an old session is discarded.
      await accountState(database, userId)
      await assertUser(client, userId)
      const result = await apply(row)
      downloaded += result.downloaded
      conflicts += result.conflicts
    }
    cursor = rows[rows.length - 1]!.id
    if (rows.length < pageSize) break
  }
  return { downloaded, conflicts }
}

async function runSynchronization(userId: string, injectedClient?: SupabaseClient): Promise<SyncSummary> {
  const client = (injectedClient ?? getSupabaseClient()) as SyncClient | null
  if (!client) throw new Error('Supabase is not configured; local changes remain saved on this device.')
  const database = await openDatabase()
  await accountState(database, userId)
  await assertUser(client, userId)

  if (isPermanentDeletionEnabled()) await reconcileServerDeletionLedger(database, client, userId)

  const trackers = await uploadQueue(database, client, userId, 'tracker')
  const deletionRequests = trackers.failed || trackers.conflicts ? { deleted: 0, conflicts: 0, failed: 0 } : await processPermanentDeletionRequests(database, client, userId)
  const entries = trackers.failed || trackers.conflicts || deletionRequests.failed || deletionRequests.conflicts ? { uploaded: 0, conflicts: 0, failed: 0 } : await uploadQueue(database, client, userId, 'tracker_entry')
  const trackerPull = await pullTable<ServerTracker>(database, client, userId, 'trackers', (row) => applyRemoteTracker(database, userId, row))
  const entryPull = await pullTable<ServerEntry>(database, client, userId, 'tracker_entries', (row) => applyRemoteEntry(database, userId, row))
  const openConflicts = await database.syncConflicts.where('ownerUserId').equals(userId).count()
  return { uploaded: trackers.uploaded + entries.uploaded + deletionRequests.deleted, downloaded: trackerPull.downloaded + entryPull.downloaded, conflicts: openConflicts, failed: trackers.failed + entries.failed + deletionRequests.failed }
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
