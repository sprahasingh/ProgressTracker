import { afterEach, describe, expect, it } from 'vitest'
import { activateWorkspace, db } from './database'
import { listBlockedSyncOperations, listSyncRecoveryOperations, retryBlockedSyncOperation } from './syncRecoveryRepository'
import { listSyncConflicts } from './syncConflictRepository'
import type { SyncConflict } from './models'
import { localRepository } from './localRepository'

afterEach(async () => {
  db.close()
  await db.delete()
})

describe('blocked sync recovery', () => {
  it('lists only the active account blocked writes and retries one without clearing its payload or diagnostic', async () => {
    await activateWorkspace('recovery-user')
    const blocked = { id: 'blocked-payload', ownerUserId: 'recovery-user', entity: 'tracker' as const, entityId: 'tracker-one', operation: 'upsert' as const, expectedRevision: 3, payload: { id: 'tracker-one', name: 'Preserved' } as never, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked' as const, lastError: 'Rejected (23514)', failureCode: '23514', blockedAt: '2026-01-01T00:00:01.000Z' }
    await db.syncOperations.put(blocked)

    await expect(listBlockedSyncOperations('recovery-user')).resolves.toEqual([blocked])
    await retryBlockedSyncOperation('recovery-user', blocked.id)
    await expect(db.syncOperations.get(blocked.id)).resolves.toMatchObject({ status: 'pending', attempts: 0, payload: blocked.payload, lastError: blocked.lastError, failureCode: '23514', blockedAt: blocked.blockedAt })
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
