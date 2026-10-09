import { openDatabase, queueSyncMutation } from './database'
import type { StoredTrackerDefinition, StoredTrackerEntry, SyncConflict, SyncOperation, SyncRecordState } from './models'
import { trackerDefinitionSchema, trackerEntrySchema } from '../domain/trackers/schema'

function trackerFromRemote(row: Record<string, unknown>): StoredTrackerDefinition {
  const tracker = trackerDefinitionSchema.parse(row.definition)
  if (row.user_id === undefined || row.id !== tracker.id || row.kind !== tracker.kind || row.status !== tracker.status || row.name !== tracker.name) {
    throw new Error('The cloud tracker does not match its stored definition.')
  }
  return tracker as StoredTrackerDefinition
}

function entryFromRemote(row: Record<string, unknown>): StoredTrackerEntry {
  return trackerEntrySchema.parse({
    id: row.id, trackerId: row.tracker_id, date: row.entry_date, outcome: row.outcome,
    values: row.entry_values, note: row.note, createdAt: row.created_at,
    updatedAt: row.updated_at, deletedAt: row.deleted_at,
  }) as StoredTrackerEntry
}

/** Lists only conflicts attached to the currently opened account workspace. */
export async function listSyncConflicts(userId: string): Promise<SyncConflict[]> {
  const database = await openDatabase()
  const metadata = await database.workspaceMetadata.get('workspace')
  if (metadata?.userId !== userId) throw new Error('The open local workspace does not belong to this account.')
  return database.syncConflicts.where('ownerUserId').equals(userId).sortBy('detectedAt')
}

/** Explicitly resolves one conflict without discarding the other copy implicitly. */
export async function resolveSyncConflict(userId: string, conflictId: string, choice: 'keep-local' | 'use-cloud'): Promise<void> {
  const database = await openDatabase()
  await database.transaction('rw', [database.workspaceMetadata, database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== userId) throw new Error('The open local workspace does not belong to this account.')
    const conflict = await database.syncConflicts.get(conflictId)
    if (!conflict || conflict.ownerUserId !== userId) throw new Error('This conflict is no longer available in the current account.')

    const existing = await database.syncOperations.get(conflict.id)
    const remote = conflict.remoteRecord
    const remoteIsOwned = remote?.user_id === userId
    const revision = remoteIsOwned && typeof remote.server_revision === 'number' ? remote.server_revision : null
    const stateKey = `${conflict.entity}:${conflict.entityId}`
    const supportedEntity = conflict.entity === 'tracker' || conflict.entity === 'tracker_entry'
    if (!supportedEntity) throw new Error('This record type cannot be resolved by the current sync client.')

    if (choice === 'use-cloud') {
      if (!remote || !remoteIsOwned || revision === null) throw new Error('The cloud copy is unavailable, so the local record was kept unchanged.')
      if (conflict.entity === 'tracker') await database.trackers.put(trackerFromRemote(remote))
      else await database.trackerEntries.put(entryFromRemote(remote))
      await database.syncRecords.put({ key: stateKey, ownerUserId: userId, entity: conflict.entity, entityId: conflict.entityId, serverRevision: revision } satisfies SyncRecordState)
      if (existing?.ownerUserId === userId) await database.syncOperations.delete(existing.id)
      await database.syncConflicts.delete(conflict.id)
      return
    }

    if (!remoteIsOwned || revision === null) throw new Error('The cloud record is unavailable or not readable by this account. Both copies remain preserved and cannot be automatically replaced.')
    let payload: StoredTrackerDefinition | StoredTrackerEntry | undefined
    if (existing?.ownerUserId === userId && existing.entityId === conflict.entityId) payload = existing.payload
    if (!payload) payload = conflict.localPayload
    if (conflict.entity === 'tracker') payload = trackerDefinitionSchema.parse(payload) as StoredTrackerDefinition
    else payload = trackerEntrySchema.parse(payload) as StoredTrackerEntry
    await database.syncRecords.put({ key: stateKey, ownerUserId: userId, entity: conflict.entity, entityId: conflict.entityId, serverRevision: revision } satisfies SyncRecordState)
    await queueSyncMutation(database, userId, conflict.entity, payload)
    // Ensure the newly queued operation always targets the revision the user reviewed.
    const replacement = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, conflict.entity, conflict.entityId]).first()
    if (replacement) await database.syncOperations.put({ ...replacement, expectedRevision: revision, status: 'pending', attempts: 0, lastError: null } satisfies SyncOperation)
    await database.syncConflicts.delete(conflict.id)
  })
}
