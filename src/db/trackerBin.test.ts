import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateWorkspace, db } from './database'
import { localRepository } from './localRepository'
import { createWorkspaceBackup, restoreWorkspaceBackup } from './workspaceBackup'
import type { StoredTrackerDefinition } from './models'

const tracker: StoredTrackerDefinition = {
  schemaVersion: 3, id: 'bin-tracker', name: 'Read more', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, deadline: '2026-12-31', metrics: [], customFields: [], milestones: [],
  goalPlanning: { mode: 'cumulative-deadline', progressSemantics: {}, dailyTargets: {}, cumulativeTargets: {}, planningTimeZone: 'UTC', allocations: {} },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

afterEach(async () => { vi.unstubAllEnvs(); db.close(); await db.delete() })

describe('synchronized tracker Bin', () => {
  it('keeps tracker, history, and planning data during the recovery period and restores the same records', async () => {
    await activateWorkspace('bin-owner')
    await localRepository.saveTracker(tracker)
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-01', outcome: 'recorded', values: {}, note: 'progress' })

    await localRepository.deleteTracker(tracker.id)

    await expect(localRepository.listTrackers()).resolves.toEqual([])
    await expect(localRepository.listDeletedTrackers()).resolves.toMatchObject([{ id: tracker.id, deletedAt: expect.any(String), goalPlanning: tracker.goalPlanning }])
    await expect(db.trackerEntries.get(savedEntry.id)).resolves.toMatchObject({ id: savedEntry.id, deletedAt: null })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['bin-owner', 'tracker', tracker.id]).first()).resolves.toMatchObject({ payload: { deletedAt: expect.any(String) } })

    await localRepository.restoreTracker(tracker.id)
    await expect(localRepository.listTrackers()).resolves.toMatchObject([{ id: tracker.id, deletedAt: null, goalPlanning: tracker.goalPlanning }])
    await expect(db.trackerEntries.get(savedEntry.id)).resolves.toMatchObject({ note: 'progress', deletedAt: null })
  })

  it('queues repeatable account-wide deletion requests without erasing local data before server confirmation', async () => {
    await activateWorkspace('bin-request-owner')
    await localRepository.saveTracker({ ...tracker, id: 'request-tracker' })
    await localRepository.saveTrackerEntry({ trackerId: 'request-tracker', date: '2026-10-01', outcome: 'recorded', values: {}, note: 'keep until server confirms' })
    await localRepository.deleteTracker('request-tracker')

    await expect(localRepository.requestPermanentDeletion('request-tracker')).resolves.toBe('queued')
    await expect(localRepository.requestPermanentDeletion('request-tracker')).resolves.toBe('queued')
    await expect(db.permanentDeletionRequests.where('ownerUserId').equals('bin-request-owner').toArray()).resolves.toHaveLength(1)
    await expect(db.trackers.get('request-tracker')).resolves.toMatchObject({ name: 'Read more', deletedAt: expect.any(String) })
    await expect(db.trackerEntries.where('trackerId').equals('request-tracker').count()).resolves.toBe(1)
  })

  it('keeps the durable account ledger authoritative over an old workspace backup', async () => {
    await activateWorkspace('bin-backup-owner')
    await localRepository.saveTracker({ ...tracker, id: 'backup-deleted-tracker' })
    await localRepository.saveTrackerEntry({ trackerId: 'backup-deleted-tracker', date: '2026-10-01', outcome: 'recorded', values: {}, note: 'old backup copy' })
    const oldBackup = await createWorkspaceBackup('bin-backup-owner')
    await localRepository.deleteTracker('backup-deleted-tracker')
    await localRepository.reconcilePermanentDeletionLedger('bin-backup-owner', [{ tracker_id: 'backup-deleted-tracker', permanently_deleted_at: '2026-10-10T00:00:00.000Z' }])

    await restoreWorkspaceBackup(oldBackup, 'bin-backup-owner')
    await expect(localRepository.listTrackers()).resolves.toEqual([])
    await expect(localRepository.reconcilePermanentDeletionLedger('bin-backup-owner', [{ tracker_id: 'backup-deleted-tracker', permanently_deleted_at: '2026-10-10T00:00:00.000Z' }])).resolves.toBeUndefined()
    await expect(db.trackers.get('backup-deleted-tracker')).resolves.toBeUndefined()
    await expect(db.trackerEntries.where('trackerId').equals('backup-deleted-tracker').count()).resolves.toBe(0)
    await expect(db.permanentDeletionLedger.get('bin-backup-owner:backup-deleted-tracker')).resolves.toMatchObject({ trackerId: 'backup-deleted-tracker' })
  })

  it('keeps an expired restored account tracker quarantined until its server write is acknowledged', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace('quarantined-owner')
    await localRepository.saveTracker({ ...tracker, id: 'quarantined-expired', deletedAt: '2026-01-01T00:00:00.000Z' })
    await localRepository.restoreTracker('quarantined-expired')
    await db.trackerVerification.put({ trackerId: 'quarantined-expired', status: 'pending-server-check' })
    await localRepository.reconcilePermanentDeletionLedger('quarantined-owner', [])

    await expect(localRepository.listTrackers()).resolves.toEqual([])
    await expect(db.trackerVerification.get('quarantined-expired')).resolves.toBeDefined()
  })

  it('purges only records belonging to the tracker even if another entry reuses its UUID', async () => {
    await activateWorkspace('collision-owner')
    await localRepository.saveTracker({ ...tracker, id: 'shared-uuid' })
    await localRepository.saveTracker({ ...tracker, id: 'other-parent' })
    const unrelatedEntry = { id: 'shared-uuid', trackerId: 'other-parent', date: '2026-10-01', outcome: 'recorded' as const, values: {}, note: 'unrelated entry', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null }
    await db.trackerEntries.put(unrelatedEntry)
    await db.syncOperations.put({ id: 'unrelated-entry-operation', ownerUserId: 'collision-owner', entity: 'tracker_entry', entityId: unrelatedEntry.id, operation: 'upsert', expectedRevision: 1, payload: unrelatedEntry, createdAt: '2026-10-01T00:00:00.000Z', attempts: 0, status: 'pending', lastError: null })
    await db.syncRecords.put({ key: 'tracker_entry:shared-uuid', ownerUserId: 'collision-owner', entity: 'tracker_entry', entityId: 'shared-uuid', serverRevision: 1 })

    await localRepository.reconcilePermanentDeletionLedger('collision-owner', [{ tracker_id: 'shared-uuid', permanently_deleted_at: '2026-10-10T00:00:00.000Z' }])

    await expect(db.trackerEntries.get('shared-uuid')).resolves.toMatchObject({ trackerId: 'other-parent', note: 'unrelated entry' })
    await expect(db.syncOperations.get('unrelated-entry-operation')).resolves.toMatchObject({ entity: 'tracker_entry', payload: { trackerId: 'other-parent' } })
    await expect(db.syncRecords.get('tracker_entry:shared-uuid')).resolves.toMatchObject({ entity: 'tracker_entry', serverRevision: 1 })
  })

  it('purges expired guest Bin contents on workspace opening without touching active guest trackers', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace(null)
    await db.trackers.bulkPut([
      { ...tracker, id: 'expired-guest', deletedAt: '2026-01-01T00:00:00.000Z' },
      { ...tracker, id: 'active-guest', deletedAt: null },
    ])
    await db.trackerEntries.put({ id: 'expired-guest-entry', trackerId: 'expired-guest', date: '2026-01-01', outcome: 'recorded', values: {}, note: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null })
    await activateWorkspace('temporary-other-account')
    await activateWorkspace(null)

    await expect(db.trackers.get('expired-guest')).resolves.toBeUndefined()
    await expect(db.trackerEntries.get('expired-guest-entry')).resolves.toBeUndefined()
    await expect(db.trackers.get('active-guest')).resolves.toMatchObject({ name: 'Read more', deletedAt: null })
  })
})
