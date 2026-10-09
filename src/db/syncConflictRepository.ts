import { openDatabase, queueSyncMutation } from './database'
import type { AccountHoliday, StoredTrackerDefinition, StoredTrackerEntry, SyncConflict, SyncOperation, SyncRecordState } from './models'
import { trackerDefinitionSchema, trackerEntrySchema } from '../domain/trackers/schema'
import { normalizeTrackerEntryTimestamps, normalizeTrackerTimestamps } from '../services/supabase/syncTimestamps'
import { publishWorkspaceMutation } from './workspaceMutationEvents'

function parseTracker(value: unknown): StoredTrackerDefinition {
  return trackerDefinitionSchema.parse(normalizeTrackerTimestamps(value)) as StoredTrackerDefinition
}

function parseEntry(value: unknown): StoredTrackerEntry {
  return trackerEntrySchema.parse(normalizeTrackerEntryTimestamps(value)) as StoredTrackerEntry
}

function trackerFromRemote(row: Record<string, unknown>): StoredTrackerDefinition {
  const tracker = parseTracker(row.definition)
  if (row.user_id === undefined || row.id !== tracker.id || row.kind !== tracker.kind || row.status !== tracker.status || row.name !== tracker.name || row.schema_version !== tracker.schemaVersion) {
    throw new Error('The cloud tracker does not match its stored definition.')
  }
  return tracker as StoredTrackerDefinition
}

function entryFromRemote(row: Record<string, unknown>): StoredTrackerEntry {
  return parseEntry({
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
  let queuedLocalChanges = false
  await database.transaction('rw', [database.workspaceMetadata, database.trackers, database.trackerEntries, database.accountHolidays, database.syncOperations, database.syncRecords, database.syncConflicts], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== userId) throw new Error('The open local workspace does not belong to this account.')
    const conflict = await database.syncConflicts.get(conflictId)
    if (!conflict || conflict.ownerUserId !== userId) throw new Error('This conflict is no longer available in the current account.')

    const existing = await database.syncOperations.get(conflict.id)
    const remote = conflict.remoteRecord
    const remoteIsOwned = remote?.user_id === userId
    const revision = remoteIsOwned && typeof remote.server_revision === 'number' ? remote.server_revision : null
    const stateKey = `${conflict.entity}:${conflict.entityId}`
    const supportedEntity = conflict.entity === 'tracker' || conflict.entity === 'tracker_entry' || conflict.entity === 'account_holiday'
    if (!supportedEntity) throw new Error('This record type cannot be resolved by the current sync client.')

    if (choice === 'fork-local') {
      if (conflict.entity === 'account_holiday') throw new Error('A holiday is unique per date and cannot be forked. Choose the local or cloud holiday.')
      if (remoteIsOwned) throw new Error('A readable cloud record exists. Choose which version to keep instead of creating a duplicate.')
      if (remote !== null) throw new Error('The cloud record cannot be safely inspected. The local copy remains preserved.')
      if (conflict.entity === 'tracker') {
        const local = await database.trackers.get(conflict.entityId) ?? parseTracker(conflict.localPayload)
        const fork = parseTracker({ ...local, id: crypto.randomUUID(), updatedAt: new Date().toISOString() })
        if (existing?.ownerUserId === userId) await database.syncOperations.delete(existing.id)
        await database.trackers.delete(conflict.entityId)
        await database.syncRecords.delete(stateKey)
        await database.trackers.put(fork)
        await queueSyncMutation(database, userId, 'tracker', fork)
        queuedLocalChanges = true
        const linkedEntries = await database.trackerEntries.where('trackerId').equals(conflict.entityId).toArray()
        for (const entry of linkedEntries) {
          const forkedEntry = parseEntry({ ...entry, trackerId: fork.id, updatedAt: new Date().toISOString() })
          await database.trackerEntries.put(forkedEntry)
          await queueSyncMutation(database, userId, 'tracker_entry', forkedEntry)
          queuedLocalChanges = true
          const entryConflict = await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', entry.id]).first()
          // The child is now a new pending operation against a different parent ID.
          // Drop its stale snapshot; the server will produce a fresh conflict if needed.
          if (entryConflict) await database.syncConflicts.delete(entryConflict.id)
        }
      } else {
        const local = await database.trackerEntries.get(conflict.entityId) ?? parseEntry(conflict.localPayload)
        const fork = parseEntry({ ...local, id: crypto.randomUUID(), updatedAt: new Date().toISOString() })
        if (existing?.ownerUserId === userId) await database.syncOperations.delete(existing.id)
        await database.trackerEntries.delete(conflict.entityId)
        await database.syncRecords.delete(stateKey)
        await database.trackerEntries.put(fork)
        await queueSyncMutation(database, userId, 'tracker_entry', fork)
        queuedLocalChanges = true
      }
      await database.syncConflicts.delete(conflict.id)
      return
    }

    if (choice === 'use-cloud') {
      if (!remote || !remoteIsOwned || revision === null) throw new Error('The cloud copy is unavailable, so the local record was kept unchanged.')
      let recordId = conflict.entityId
      if (conflict.entity === 'tracker') await database.trackers.put(trackerFromRemote(remote))
      else if (conflict.entity === 'tracker_entry') {
        const cloudEntry = entryFromRemote(remote)
        recordId = cloudEntry.id
        if (recordId !== conflict.entityId) await database.trackerEntries.delete(conflict.entityId)
        await database.trackerEntries.put(cloudEntry)
      } else {
        if (typeof remote.holiday_date !== 'string' || !(remote.reason === null || ['travel', 'exam', 'personal', 'other'].includes(String(remote.reason)))) throw new Error('The cloud holiday is invalid; the local copy remains unchanged.')
        recordId = String(remote.id)
        const cloudDate = remote.holiday_date as AccountHoliday['date']
        const duplicateDate = await database.accountHolidays.where('date').equals(cloudDate).first()
        if (duplicateDate && duplicateDate.id !== String(remote.id)) {
          await database.accountHolidays.delete(duplicateDate.id)
          const localOperation = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'account_holiday', duplicateDate.id]).first()
          if (localOperation) await database.syncOperations.delete(localOperation.id)
          await database.syncRecords.delete(`account_holiday:${duplicateDate.id}`)
        }
        await database.accountHolidays.put({ id: String(remote.id), date: remote.holiday_date as AccountHoliday['date'], reason: remote.reason as AccountHoliday['reason'], createdAt: String(remote.created_at), updatedAt: String(remote.updated_at), deletedAt: remote.deleted_at === null ? null : String(remote.deleted_at) })
      }
      await database.syncRecords.put({ key: `${conflict.entity}:${recordId}`, ownerUserId: userId, entity: conflict.entity, entityId: recordId, serverRevision: revision } satisfies SyncRecordState)
      if (existing?.ownerUserId === userId) await database.syncOperations.delete(existing.id)
      if (recordId !== conflict.entityId) await database.syncRecords.delete(stateKey)
      await database.syncConflicts.delete(conflict.id)
      return
    }

    if (!remoteIsOwned || revision === null) throw new Error('The cloud record is unavailable or not readable by this account. Both copies remain preserved; use “Save local copy as new” to resolve the ID collision safely.')
    let payload: StoredTrackerDefinition | StoredTrackerEntry | AccountHoliday | undefined
    if (existing?.ownerUserId === userId && existing.entityId === conflict.entityId) payload = existing.payload
    if (!payload) payload = conflict.localPayload
    if (conflict.entity === 'tracker') payload = parseTracker(payload)
    else if (conflict.entity === 'tracker_entry') payload = parseEntry(payload)
    else {
      const holiday = payload as AccountHoliday
      if (!holiday || holiday.id !== conflict.entityId || !/^\d{4}-\d{2}-\d{2}$/.test(holiday.date)) throw new Error('The local holiday is invalid; both copies remain preserved.')
    }
    let targetEntityId = conflict.entity === 'tracker_entry' && remote.id !== conflict.entityId ? String(remote.id) : conflict.entityId
    if (conflict.entity === 'account_holiday' && remote.id !== conflict.entityId && remote.holiday_date === (payload as AccountHoliday).date) {
      // Two devices may create the same account/date with different local IDs.
      // Keep-local explicitly adopts the cloud identity and reviewed revision.
      const holiday = payload as AccountHoliday
      targetEntityId = String(remote.id)
      const duplicateDate = await database.accountHolidays.where('date').equals(holiday.date).first()
      if (duplicateDate && duplicateDate.id !== targetEntityId) await database.accountHolidays.delete(duplicateDate.id)
      const rebased: AccountHoliday = { ...holiday, id: targetEntityId }
      await database.accountHolidays.put(rebased)
      payload = rebased
    }
    await database.syncRecords.put({ key: `${conflict.entity}:${targetEntityId}`, ownerUserId: userId, entity: conflict.entity, entityId: targetEntityId, serverRevision: revision } satisfies SyncRecordState)
    if (targetEntityId !== conflict.entityId) await database.syncRecords.delete(stateKey)
    if (conflict.entity === 'tracker_entry' && remote.id !== conflict.entityId) {
      const replacement = parseEntry({ ...payload as StoredTrackerEntry, id: String(remote.id) })
      await database.trackerEntries.delete(conflict.entityId)
      await database.trackerEntries.put(replacement)
      if (existing?.ownerUserId === userId) await database.syncOperations.delete(existing.id)
      payload = replacement
    }
    await queueSyncMutation(database, userId, conflict.entity, payload)
    queuedLocalChanges = true
    // Ensure the newly queued operation always targets the revision the user reviewed.
    const replacement = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, conflict.entity, conflict.entityId]).first()
    if (replacement) await database.syncOperations.put({ ...replacement, expectedRevision: revision, status: 'pending', attempts: 0, lastError: null } satisfies SyncOperation)
    await database.syncConflicts.delete(conflict.id)
  })
  if (queuedLocalChanges) publishWorkspaceMutation(userId)
}
