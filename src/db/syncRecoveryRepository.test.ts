import { afterEach, describe, expect, it } from 'vitest'
import { activateWorkspace, db } from './database'
import { isRetryableTransientSyncFailure, listBlockedSyncOperations, listSyncRecoveryOperations, retryBlockedSyncOperation } from './syncRecoveryRepository'
import { listSyncConflicts } from './syncConflictRepository'
import type { SyncConflict } from './models'
import { localRepository } from './localRepository'

afterEach(async () => {
  db.close()
  await db.delete()
})

describe('blocked sync recovery', () => {
  it('classifies only explicit transient failures as retryable', () => {
    expect(isRetryableTransientSyncFailure('23514', 'network timeout')).toBe(false)
    expect(isRetryableTransientSyncFailure('503')).toBe(true)
    expect(isRetryableTransientSyncFailure(undefined, 'Request timed out')).toBe(true)
    expect(isRetryableTransientSyncFailure(undefined, 'The server rejected this saved change')).toBe(false)
  })

  it('lists only active account blocked writes and refuses to replay a permanent validation rejection', async () => {
    await activateWorkspace('recovery-user')
    const blocked = { id: 'blocked-payload', ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: 'tracker-one', operation: 'upsert' as const, expectedRevision: 3, payload: { id: 'tracker-one', name: 'Preserved' } as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked' as const, lastError: 'Rejected (23514)', failureCode: '23514', blockedAt: '2026-01-01T00:00:01.000Z' }
    await db.syncOperations.put(blocked)

    await expect(listBlockedSyncOperations('recovery-user')).resolves.toEqual([blocked])
    await expect(retryBlockedSyncOperation('recovery-user', blocked.id)).rejects.toThrow(/permanently rejected.*cannot be retried unchanged/i)
    await expect(db.syncOperations.get(blocked.id)).resolves.toMatchObject({ status: 'blocked', attempts: 1, payload: blocked.payload, lastError: blocked.lastError, failureCode: '23514', blockedAt: blocked.blockedAt })
  })

  it('rechecks the cloud revision before queueing a retryable transient tracker failure', async () => {
    await activateWorkspace('recovery-user')
    const tracker = { id: 'tracker-one', name: 'Preserved', schemaVersion: 8, updatedAt: '2026-01-01T00:00:00.000Z' }
    const blocked = { id: 'transient-503', ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: tracker.id, operation: 'upsert' as const, expectedRevision: 3, payload: tracker as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked' as const, lastError: 'Service unavailable', failureCode: '503' }
    await db.trackers.put(tracker as never)
    await db.syncRecords.put({ key: `tracker:${tracker.id}`, ownerUserId: 'recovery-user', entity: 'tracker', entityId: tracker.id, serverRevision: 3 })
    await db.syncOperations.put(blocked)

    await expect(retryBlockedSyncOperation('recovery-user', blocked.id, { database: db, readCloudTracker: async () => ({ id: tracker.id, user_id: 'recovery-user', server_revision: 3, definition: tracker }) })).resolves.toBe('queued')
    await expect(db.syncOperations.get(blocked.id)).resolves.toMatchObject({ status: 'pending', attempts: 0, payload: tracker, lastError: 'Service unavailable', failureCode: '503' })
  })

  it('converts a stale transient retry into a conflict without queueing its payload', async () => {
    await activateWorkspace('recovery-user')
    const tracker = { id: 'tracker-one', name: 'Local version', schemaVersion: 8, updatedAt: '2026-01-01T00:00:00.000Z' }
    const cloudDefinition = { ...tracker, name: 'Cloud version' }
    const blocked = { id: 'transient-stale', ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: tracker.id, operation: 'upsert' as const, expectedRevision: 3, payload: tracker as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked' as const, lastError: 'Gateway timeout', failureCode: '504' }
    await db.trackers.put(tracker as never)
    await db.syncRecords.put({ key: `tracker:${tracker.id}`, ownerUserId: 'recovery-user', entity: 'tracker', entityId: tracker.id, serverRevision: 3 })
    await db.syncOperations.put(blocked)

    await expect(retryBlockedSyncOperation('recovery-user', blocked.id, { database: db, readCloudTracker: async () => ({ id: tracker.id, user_id: 'recovery-user', server_revision: 4, definition: cloudDefinition }) })).resolves.toBe('conflict')
    await expect(db.syncOperations.get(blocked.id)).resolves.toMatchObject({ status: 'conflict', payload: tracker, failureCode: '504' })
    await expect(db.syncConflicts.get(blocked.id)).resolves.toMatchObject({ localPayload: tracker, remoteRecord: { server_revision: 4, definition: cloudDefinition }, reason: expect.stringContaining('cloud revision changed') })
  })

  it('preserves the original operation when the fresh cloud revision read fails', async () => {
    await activateWorkspace('recovery-user')
    const tracker = { id: 'tracker-one', name: 'Preserved', schemaVersion: 8, updatedAt: '2026-01-01T00:00:00.000Z' }
    const blocked = { id: 'transient-unavailable', ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: tracker.id, operation: 'upsert' as const, expectedRevision: 3, payload: tracker as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked' as const, lastError: 'Gateway timeout', failureCode: '504' }
    await db.trackers.put(tracker as never)
    await db.syncRecords.put({ key: `tracker:${tracker.id}`, ownerUserId: 'recovery-user', entity: 'tracker', entityId: tracker.id, serverRevision: 3 })
    await db.syncOperations.put(blocked)

    await expect(retryBlockedSyncOperation('recovery-user', blocked.id, { database: db, readCloudTracker: async () => { throw new Error('offline') } })).rejects.toThrow(/latest cloud revision could not be checked/)
    await expect(db.syncOperations.get(blocked.id)).resolves.toEqual(blocked)
  })

  it('queues at most one retry under repeated concurrent requests', async () => {
    await activateWorkspace('recovery-user')
    const tracker = { id: 'tracker-one', name: 'Preserved', schemaVersion: 8, updatedAt: '2026-01-01T00:00:00.000Z' }
    const blocked = { id: 'transient-duplicate', ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: tracker.id, operation: 'upsert' as const, expectedRevision: 3, payload: tracker as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked' as const, lastError: 'Timeout', failureCode: 'ETIMEDOUT' }
    await db.trackers.put(tracker as never)
    await db.syncRecords.put({ key: `tracker:${tracker.id}`, ownerUserId: 'recovery-user', entity: 'tracker', entityId: tracker.id, serverRevision: 3 })
    await db.syncOperations.put(blocked)
    const options = { database: db, readCloudTracker: async () => ({ id: tracker.id, user_id: 'recovery-user', server_revision: 3, definition: tracker }) }

    const results = await Promise.allSettled([retryBlockedSyncOperation('recovery-user', blocked.id, options), retryBlockedSyncOperation('recovery-user', blocked.id, options)])
    expect(results.filter((result) => result.status === 'fulfilled' && result.value === 'queued')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(db.syncOperations.get(blocked.id)).resolves.toMatchObject({ status: 'pending', payload: tracker, failureCode: 'ETIMEDOUT' })
  })

  it('never retries an older blocked tracker definition ahead of a newer blocked operation', async () => {
    await activateWorkspace('recovery-user')
    const current = { id: 'tracker-one', name: 'Latest local version', schemaVersion: 8, updatedAt: '2026-01-02T00:00:00.000Z' }
    const older = { id: 'older-transient', ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: current.id, operation: 'upsert' as const, expectedRevision: 3, payload: { ...current, name: 'Obsolete version' } as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked' as const, lastError: 'Gateway timeout', failureCode: '504' }
    const latest = { ...older, id: 'latest-transient', payload: current as never, createdAt: '2026-01-02T00:00:00.000Z' }
    await db.trackers.put(current as never)
    await db.syncRecords.put({ key: `tracker:${current.id}`, ownerUserId: 'recovery-user', entity: 'tracker', entityId: current.id, serverRevision: 3 })
    await db.syncOperations.bulkPut([older, latest])

    await expect(retryBlockedSyncOperation('recovery-user', older.id, { database: db, readCloudTracker: async () => ({ id: current.id, user_id: 'recovery-user', server_revision: 3, definition: current }) })).rejects.toThrow(/Only the latest blocked tracker definition/)
    await expect(db.syncOperations.get(older.id)).resolves.toMatchObject({ status: 'blocked', payload: older.payload })
    await expect(db.syncOperations.get(latest.id)).resolves.toMatchObject({ status: 'blocked', payload: current })
  })

  it('does not expose or retry blocked operations from another workspace', async () => {
    await activateWorkspace('recovery-user')
    await db.syncOperations.put({ id: 'private-blocked', ownerUserId: 'recovery-user', entity: 'tracker', entityId: 'private', operation: 'upsert', expectedRevision: null, payload: { id: 'private', name: 'Private' } as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked', lastError: 'Rejected', failureCode: '23514' })
    await activateWorkspace('different-user')

    await expect(listBlockedSyncOperations('recovery-user')).rejects.toThrow('does not belong to this account')
    await expect(retryBlockedSyncOperation('recovery-user', 'private-blocked')).rejects.toThrow('does not belong to this account')
    await expect(db.workspaceMetadata.get('workspace')).resolves.toMatchObject({ userId: 'different-user' })
  })

  it('keeps superseded rejected payloads distinguishable from current blocked changes', async () => {
    await activateWorkspace('recovery-user')
    const common = { ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: 'legacy-tracker', operation: 'upsert' as const, expectedRevision: 1, payload: { id: 'legacy-tracker', name: 'Retained' } as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, lastError: 'Rejected (23514)', failureCode: '23514' }
    await db.syncOperations.bulkAdd([
      { ...common, id: 'blocked-current', status: 'blocked' as const },
      { ...common, id: 'blocked-old', status: 'superseded' as const, supersededAt: '2026-01-02T00:00:00.000Z', supersededByRevision: 4 },
    ] as never[])
    await expect(listSyncRecoveryOperations('recovery-user')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'blocked-current', status: 'blocked' }),
      expect.objectContaining({ id: 'blocked-old', status: 'superseded', supersededByRevision: 4 }),
    ]))
  })

  it('retains discarded payloads for audit and refuses to retry them', async () => {
    await activateWorkspace('recovery-user')
    const discarded = { id: 'discarded-audit', ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: 'tracker-one', operation: 'upsert' as const, expectedRevision: 3, payload: { id: 'tracker-one', name: 'Preserved' } as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'discarded' as const, discardedAt: '2026-01-02T00:00:00.000Z', lastError: 'Rejected (23514)', failureCode: '23514' }
    await db.syncOperations.put(discarded)
    await expect(listSyncRecoveryOperations('recovery-user')).resolves.toContainEqual(expect.objectContaining({ id: discarded.id, status: 'discarded', payload: discarded.payload }))
    await expect(retryBlockedSyncOperation('recovery-user', discarded.id)).rejects.toThrow(/no longer available/)
    await expect(db.syncOperations.get(discarded.id)).resolves.toMatchObject({ status: 'discarded', discardedAt: discarded.discardedAt, payload: discarded.payload })
  })

  it('migrates an old server-validation false conflict to a retained blocked payload', async () => {
    await activateWorkspace('recovery-user')
    const message = 'The server rejected this saved change (23514). Review the local record and resolve the sync issue before retrying.'
    const operation = { id: 'old-validation', ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: 'legacy-v6', operation: 'upsert' as const, expectedRevision: 1, payload: { id: 'legacy-v6', name: '100 Days Of MERN', schemaVersion: 6 } as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'conflict' as const, lastError: message }
    await db.syncOperations.put(operation)
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'recovery-user', entity: 'tracker', entityId: operation.entityId, localPayload: operation.payload, remoteRecord: null, detectedAt: '2026-01-02T00:00:00.000Z', reason: message } satisfies SyncConflict)
    await db.syncRecords.put({ key: 'tracker:legacy-v6', ownerUserId: 'recovery-user', entity: 'tracker', entityId: 'legacy-v6', serverRevision: 1 })

    await expect(listSyncConflicts('recovery-user')).resolves.toEqual([])
    await expect(db.syncOperations.get(operation.id)).resolves.toMatchObject({ status: 'blocked', failureCode: '23514', payload: operation.payload, lastError: message })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeUndefined()
    await expect(listBlockedSyncOperations('recovery-user')).resolves.toContainEqual(expect.objectContaining({ id: operation.id, status: 'blocked', failureCode: '23514' }))
    const corrected = { schemaVersion: 6 as const, id: 'legacy-v6', name: 'Corrected MERN plan', description: '', kind: 'habit' as const, status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const }, scheduling: { mode: 'ongoing' as const }, metrics: [], customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', archivedAt: null, deletedAt: null }
    await expect(localRepository.saveTracker(corrected)).resolves.toMatchObject({ name: 'Corrected MERN plan' })
    await expect(db.syncOperations.get(operation.id)).resolves.toMatchObject({ status: 'blocked', payload: operation.payload, failureCode: '23514' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['recovery-user', 'tracker', 'legacy-v6']).toArray()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'pending', expectedRevision: 1, payload: expect.objectContaining({ name: 'Corrected MERN plan' }) })]))
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['recovery-user', 'tracker', 'legacy-v6']).count()).resolves.toBe(2)
  })
})
