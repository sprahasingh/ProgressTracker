import { afterEach, describe, expect, it } from 'vitest'
import { activateWorkspace, db } from './database'
import { localRepository } from './localRepository'
import { listSyncConflicts, resolveSyncConflict } from './syncConflictRepository'
import type { StoredTrackerDefinition } from './models'

const tracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'conflicted-tracker', name: 'Local name', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [], customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', archivedAt: null, deletedAt: null,
}
const remote = { id: tracker.id, user_id: 'conflict-user', schema_version: 1, kind: 'habit', status: 'active', name: 'Cloud name', definition: { ...tracker, name: 'Cloud name' }, created_at: tracker.createdAt, updated_at: '2026-01-03T00:00:00.000Z', deleted_at: null, server_revision: 4 }

afterEach(async () => {
  db.close()
  await db.delete()
})

describe('sync conflict recovery', () => {
  it('keeps the local version and queues it against the cloud revision the user reviewed', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const operation = await db.syncOperations.toCollection().first()
    if (!operation) throw new Error('Expected a queued operation')
    await db.syncOperations.put({ ...operation, status: 'conflict' })
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: remote, detectedAt: '2026-01-03T00:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'keep-local')

    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: 'Local name' })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeUndefined()
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', tracker.id]).first()).resolves.toMatchObject({ status: 'pending', expectedRevision: 4, payload: { name: 'Local name' } })
    await expect(listSyncConflicts('conflict-user')).resolves.toEqual([])
  })

  it('uses the cloud version, updates revision metadata, and removes its stale local operation', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const operation = await db.syncOperations.toCollection().first()
    if (!operation) throw new Error('Expected a queued operation')
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: remote, detectedAt: '2026-01-03T00:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'use-cloud')

    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: 'Cloud name' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', tracker.id]).count()).resolves.toBe(0)
    await expect(db.syncRecords.get(`tracker:${tracker.id}`)).resolves.toMatchObject({ serverRevision: 4, ownerUserId: 'conflict-user' })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeUndefined()
  })

  it('does not expose or resolve another account’s local conflicts', async () => {
    await activateWorkspace('conflict-user')
    await db.syncConflicts.put({ id: 'private-conflict', ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: remote, detectedAt: '2026-01-03T00:00:00.000Z' })
    await activateWorkspace('different-user')

    await expect(listSyncConflicts('conflict-user')).rejects.toThrow('does not belong to this account')
    await expect(resolveSyncConflict('conflict-user', 'private-conflict', 'use-cloud')).rejects.toThrow('does not belong to this account')
    await expect(db.syncConflicts.count()).resolves.toBe(0)
  })

  it('retains both copies when the server cannot provide an account-readable cloud record', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const operation = await db.syncOperations.toCollection().first()
    if (!operation) throw new Error('Expected a queued operation')
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: null, detectedAt: '2026-01-03T00:00:00.000Z' })

    await expect(resolveSyncConflict('conflict-user', operation.id, 'keep-local')).rejects.toThrow('Both copies remain preserved')
    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: 'Local name' })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeDefined()
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', tracker.id]).count()).resolves.toBe(1)
  })
})
