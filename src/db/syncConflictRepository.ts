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
export async function resolveSyncConflict(userId: string, conflictId: string, choice: 'keep-local' | 'use-cloud' | 'fork-local'): Promise<void> {
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

    if (choice === 'fork-local') {
      if (remoteIsOwned) throw new Error('A readable cloud record exists. Choose which version to keep instead of creating a duplicate.')
      if (remote !== null) throw new Error('The cloud record cannot be safely inspected. The local copy remains preserved.')
      if (conflict.entity === 'tracker') {
        const local = await database.trackers.get(conflict.entityId) ?? trackerDefinitionSchema.parse(conflict.localPayload) as StoredTrackerDefinition
        const fork = trackerDefinitionSchema.parse({ ...local, id: crypto.randomUUID(), updatedAt: new Date().toISOString() }) as StoredTrackerDefinition
        if (existing?.ownerUserId === userId) await database.syncOperations.delete(existing.id)
        await database.trackers.delete(conflict.entityId)
        await database.syncRecords.delete(stateKey)
        await database.trackers.put(fork)
        await queueSyncMutation(database, userId, 'tracker', fork)
        const linkedEntries = await database.trackerEntries.where('trackerId').equals(conflict.entityId).toArray()
        for (const entry of linkedEntries) {
          const forkedEntry = trackerEntrySchema.parse({ ...entry, trackerId: fork.id, updatedAt: new Date().toISOString() }) as StoredTrackerEntry
          await database.trackerEntries.put(forkedEntry)
          await queueSyncMutation(database, userId, 'tracker_entry', forkedEntry)
          const entryConflict = await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', entry.id]).first()
          if (entryConflict) await database.syncConflicts.put({ ...entryConflict, localPayload: forkedEntry })
        }
      } else {
        const local = await database.trackerEntries.get(conflict.entityId) ?? trackerEntrySchema.parse(conflict.localPayload) as StoredTrackerEntry
        const fork = trackerEntrySchema.parse({ ...local, id: crypto.randomUUID(), updatedAt: new Date().toISOString() }) as StoredTrackerEntry
        if (existing?.ownerUserId === userId) await database.syncOperations.delete(existing.id)
        await database.trackerEntries.delete(conflict.entityId)
        await database.syncRecords.delete(stateKey)
        await database.trackerEntries.put(fork)
        await queueSyncMutation(database, userId, 'tracker_entry', fork)
      }
      await database.syncConflicts.delete(conflict.id)
      return
    }

    if (choice === 'use-cloud') {
      if (!remote || !remoteIsOwned || revision === null) throw new Error('The cloud copy is unavailable, so the local record was kept unchanged.')
      let recordId = conflict.entityId
      if (conflict.entity === 'tracker') await database.trackers.put(trackerFromRemote(remote))
      else {
        const cloudEntry = entryFromRemote(remote)
        recordId = cloudEntry.id
        if (recordId !== conflict.entityId) await database.trackerEntries.delete(conflict.entityId)
        await database.trackerEntries.put(cloudEntry)
      }
      await database.syncRecords.put({ key: `${conflict.entity}:${recordId}`, ownerUserId: userId, entity: conflict.entity, entityId: recordId, serverRevision: revision } satisfies SyncRecordState)
      if (existing?.ownerUserId === userId) await database.syncOperations.delete(existing.id)
      if (recordId !== conflict.entityId) await database.syncRecords.delete(stateKey)
      await database.syncConflicts.delete(conflict.id)
      return
    }

    if (!remoteIsOwned || revision === null) throw new Error('The cloud record is unavailable or not readable by this account. Both copies remain preserved; use “Save local copy as new” to resolve the ID collision safely.')
    let payload: StoredTrackerDefinition | StoredTrackerEntry | undefined
    if (existing?.ownerUserId === userId && existing.entityId === conflict.entityId) payload = existing.payload
    if (!payload) payload = conflict.localPayload
    if (conflict.entity === 'tracker') payload = trackerDefinitionSchema.parse(payload) as StoredTrackerDefinition
    else payload = trackerEntrySchema.parse(payload) as StoredTrackerEntry
    const targetEntityId = conflict.entity === 'tracker_entry' && remote.id !== conflict.entityId ? String(remote.id) : conflict.entityId
    await database.syncRecords.put({ key: `${conflict.entity}:${targetEntityId}`, ownerUserId: userId, entity: conflict.entity, entityId: targetEntityId, serverRevision: revision } satisfies SyncRecordState)
    if (targetEntityId !== conflict.entityId) await database.syncRecords.delete(stateKey)
    if (conflict.entity === 'tracker_entry' && remote.id !== conflict.entityId) {
      const replacement = trackerEntrySchema.parse({ ...payload as StoredTrackerEntry, id: String(remote.id) }) as StoredTrackerEntry
      await database.trackerEntries.delete(conflict.entityId)
      await database.trackerEntries.put(replacement)
      if (existing?.ownerUserId === userId) await database.syncOperations.delete(existing.id)
      payload = replacement
    }
    await queueSyncMutation(database, userId, conflict.entity, payload)
    // Ensure the newly queued operation always targets the revision the user reviewed.
    const replacement = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, conflict.entity, conflict.entityId]).first()
    if (replacement) await database.syncOperations.put({ ...replacement, expectedRevision: revision, status: 'pending', attempts: 0, lastError: null } satisfies SyncOperation)
    await database.syncConflicts.delete(conflict.id)
  })
}
