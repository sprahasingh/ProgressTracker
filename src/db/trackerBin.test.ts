import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { activateWorkspace, db } from './database'
import { localRepository } from './localRepository'
import { createWorkspaceBackup, restoreWorkspaceBackup } from './workspaceBackup'
import type { StoredTrackerDefinition } from './models'
import { synchronizeWorkspace } from '../services/supabase/syncEngine'
import { resolveSyncConflict } from './syncConflictRepository'

const tracker: StoredTrackerDefinition = {
  schemaVersion: 3, id: 'bin-tracker', name: 'Read more', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, deadline: '2026-12-31', metrics: [], customFields: [], milestones: [],
  goalPlanning: { mode: 'cumulative-deadline', progressSemantics: {}, dailyTargets: {}, cumulativeTargets: {}, planningTimeZone: 'UTC', allocations: {} },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

beforeEach(() => { vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'false') })
afterEach(async () => { vi.unstubAllEnvs(); db.close(); await db.delete() })

function localSyncClient(userId: string): SupabaseClient {
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
    data: { status: 'applied', record: { ...(args.p_record as Record<string, unknown>), user_id: userId, server_revision: 1 } },
    error: null,
  }))
  const from = vi.fn((table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      gt: () => builder,
      maybeSingle: vi.fn().mockResolvedValue({ data: table === 'app_settings' ? { timezone: 'UTC', timezone_configured: true } : null, error: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      then: (resolve: (result: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null })),
    }
    return builder
  })
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: userId } } }, error: null }),
    },
    rpc,
    from,
  } as unknown as SupabaseClient
}

function rejectedRestoreSyncClient(userId: string, result: { data: unknown; error: { message: string; code?: string } | null }): SupabaseClient {
  const base = localSyncClient(userId)
  return { ...base, rpc: vi.fn().mockResolvedValue(result) } as unknown as SupabaseClient
}

describe('synchronized tracker Bin', () => {
  it('keeps guest tracker, history, and planning data during the recovery period and restores locally', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace(null)
    await localRepository.saveTracker(tracker)
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-01', outcome: 'recorded', values: {}, note: 'progress' })

    await localRepository.deleteTracker(tracker.id)

    await expect(localRepository.listTrackers()).resolves.toEqual([])
    await expect(localRepository.listDeletedTrackers()).resolves.toMatchObject([{ id: tracker.id, deletedAt: expect.any(String), goalPlanning: tracker.goalPlanning }])
    await expect(db.trackerEntries.get(savedEntry.id)).resolves.toMatchObject({ id: savedEntry.id, deletedAt: null })
    await expect(db.syncOperations.toArray()).resolves.toEqual([])

    await localRepository.restoreTracker(tracker.id)
    await expect(localRepository.listTrackers()).resolves.toMatchObject([{ id: tracker.id, deletedAt: null, goalPlanning: tracker.goalPlanning }])
    await expect(db.trackerVerification.get(tracker.id)).resolves.toBeUndefined()
    await expect(db.trackerEntries.get(savedEntry.id)).resolves.toMatchObject({ note: 'progress', deletedAt: null })
  })

  it('quarantines an account restore with all local data until sync acknowledges it', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace('bin-owner')
    await localRepository.saveTracker(tracker)
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-01', outcome: 'recorded', values: {}, note: 'progress' })
    await localRepository.deleteTracker(tracker.id)

    await localRepository.restoreTracker(tracker.id)

    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ id: tracker.id, deletedAt: null, goalPlanning: tracker.goalPlanning })
    await expect(db.trackerEntries.get(savedEntry.id)).resolves.toMatchObject({ note: 'progress', deletedAt: null })
    await expect(db.trackerVerification.get(tracker.id)).resolves.toMatchObject({ status: 'pending-server-check', purpose: 'restore' })
    await expect(localRepository.listTrackers()).resolves.toEqual([])
    await expect(localRepository.listDeletedTrackers()).resolves.toEqual([])
    await expect(localRepository.listPendingTrackerRestores('bin-owner')).resolves.toMatchObject([{ tracker: { id: tracker.id, deletedAt: null }, status: 'pending' }])
    await expect(localRepository.saveTracker({ ...tracker, name: 'Premature edit' })).rejects.toThrow(/waiting for server confirmation/)
    await expect(localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-02', outcome: 'recorded', values: {}, note: 'premature check-in' })).rejects.toThrow(/waiting for server confirmation/)
    await expect(localRepository.archiveTracker(tracker.id)).rejects.toThrow(/waiting for server confirmation/)
    await expect(localRepository.deleteTracker(tracker.id)).rejects.toThrow(/waiting for server confirmation/)
    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: tracker.name, status: tracker.status, deletedAt: null })
    await expect(db.trackerEntries.where('trackerId').equals(tracker.id).count()).resolves.toBe(1)

    const result = await synchronizeWorkspace('bin-owner', localSyncClient('bin-owner'))

    expect(result).toMatchObject({ uploaded: 2, failed: 0, conflicts: 0 })
    await expect(db.trackerVerification.get(tracker.id)).resolves.toBeUndefined()
    await expect(localRepository.listTrackers()).resolves.toMatchObject([{ id: tracker.id, deletedAt: null, goalPlanning: tracker.goalPlanning }])
    await expect(localRepository.listDeletedTrackers()).resolves.toEqual([])
    await expect(localRepository.listPendingTrackerRestores('bin-owner')).resolves.toEqual([])
    await expect(db.trackerEntries.get(savedEntry.id)).resolves.toMatchObject({ note: 'progress', deletedAt: null })
  })

  it('does not release a restore when an older in-flight deletion write is acknowledged', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace('bin-race-owner')
    await localRepository.saveTracker({ ...tracker, id: 'restore-race' })
    await localRepository.deleteTracker('restore-race')

    let releaseFirst!: () => void
    let startedFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve })
    const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve })
    const baseClient = localSyncClient('bin-race-owner')
    const racingClient = {
      ...baseClient,
      rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => {
        startedFirst()
        await firstResponse
        return { data: { status: 'applied', record: { ...(args.p_record as Record<string, unknown>), user_id: 'bin-race-owner', server_revision: 1 } }, error: null }
      }),
    } as unknown as SupabaseClient
    const firstSync = synchronizeWorkspace('bin-race-owner', racingClient)
    await firstStarted
    await localRepository.restoreTracker('restore-race')
    releaseFirst()
    await firstSync

    await expect(localRepository.listTrackers()).resolves.toEqual([])
    await expect(localRepository.listPendingTrackerRestores('bin-race-owner')).resolves.toMatchObject([{ tracker: { id: 'restore-race' }, status: 'pending' }])
    await expect(db.trackerVerification.get('restore-race')).resolves.toMatchObject({ purpose: 'restore' })

    await synchronizeWorkspace('bin-race-owner', localSyncClient('bin-race-owner'))
    await expect(db.trackerVerification.get('restore-race')).resolves.toBeUndefined()
    await expect(localRepository.listTrackers()).resolves.toMatchObject([{ id: 'restore-race', deletedAt: null }])
  })

  it('keeps a locally stored account restore pending after offline sync failure', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace('bin-offline-owner')
    await localRepository.saveTracker({ ...tracker, id: 'offline-restore' })
    await localRepository.deleteTracker('offline-restore')
    await localRepository.restoreTracker('offline-restore')

    const result = await synchronizeWorkspace('bin-offline-owner', rejectedRestoreSyncClient('bin-offline-owner', { data: null, error: { message: 'network unavailable' } }))

    expect(result.failed).toBeGreaterThan(0)
    db.close()
    await db.open()
    await expect(localRepository.listTrackers()).resolves.toEqual([])
    await expect(localRepository.listDeletedTrackers()).resolves.toEqual([])
    await expect(localRepository.listPendingTrackerRestores('bin-offline-owner')).resolves.toMatchObject([{ tracker: { id: 'offline-restore' }, status: 'pending', message: expect.stringContaining('will retry when sync is available') }])
    await expect(db.trackerVerification.get('offline-restore')).resolves.toMatchObject({ purpose: 'restore' })
    await expect(db.trackers.get('offline-restore')).resolves.toMatchObject({ deletedAt: null })
  })

  it('shows a conflicted restore as requiring attention while keeping it quarantined', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace('bin-conflict-owner')
    await localRepository.saveTracker({ ...tracker, id: 'conflicted-restore' })
    await localRepository.deleteTracker('conflicted-restore')
    await localRepository.restoreTracker('conflicted-restore')

    const result = await synchronizeWorkspace('bin-conflict-owner', rejectedRestoreSyncClient('bin-conflict-owner', { data: { status: 'conflict', record: null }, error: null }))

    expect(result.conflicts).toBeGreaterThan(0)
    await expect(localRepository.listTrackers()).resolves.toEqual([])
    await expect(localRepository.listPendingTrackerRestores('bin-conflict-owner')).resolves.toMatchObject([{ tracker: { id: 'conflicted-restore' }, status: 'attention', message: expect.stringContaining('cloud record changed') }])
    await expect(db.syncConflicts.where('entityId').equals('conflicted-restore').count()).resolves.toBe(1)
  })

  it('releases quarantine only after an explicit server-backed conflict resolution', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace('bin-resolved-owner')
    const local = { ...tracker, id: 'resolved-restore', deletedAt: null }
    await db.trackers.put(local)
    await db.trackerVerification.put({ trackerId: local.id, status: 'pending-server-check', purpose: 'restore' })
    await db.syncConflicts.put({ id: 'restore-conflict', ownerUserId: 'bin-resolved-owner', entity: 'tracker', entityId: local.id, localPayload: local, remoteRecord: { user_id: 'bin-resolved-owner', id: local.id, name: local.name, kind: local.kind, status: local.status, schema_version: local.schemaVersion, definition: local, server_revision: 3 }, detectedAt: new Date().toISOString() })
    await db.syncOperations.put({ id: 'restore-conflict', ownerUserId: 'bin-resolved-owner', entity: 'tracker', entityId: local.id, operation: 'upsert', expectedRevision: 2, payload: local, createdAt: new Date().toISOString(), attempts: 1, status: 'conflict', lastError: 'revision conflict' })

    await expect(localRepository.listPendingTrackerRestores('bin-resolved-owner')).resolves.toMatchObject([{ status: 'attention' }])
    await resolveSyncConflict('bin-resolved-owner', 'restore-conflict', 'use-cloud')

    await expect(db.trackerVerification.get(local.id)).resolves.toBeUndefined()
    await expect(localRepository.getTracker(local.id)).resolves.toMatchObject({ id: local.id, deletedAt: null })
    await expect(localRepository.listPendingTrackerRestores('bin-resolved-owner')).resolves.toEqual([])
  })

  it('never lists a pending restore when the permanent-deletion ledger contains the tracker', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace('bin-ledger-restore-owner')
    await db.trackers.put({ ...tracker, id: 'ledger-restore', deletedAt: null })
    await db.trackerVerification.put({ trackerId: 'ledger-restore', status: 'pending-server-check', purpose: 'restore' })
    await db.permanentDeletionLedger.put({ key: 'bin-ledger-restore-owner:ledger-restore', ownerUserId: 'bin-ledger-restore-owner', trackerId: 'ledger-restore', permanentlyDeletedAt: new Date().toISOString() })

    await expect(localRepository.listPendingTrackerRestores('bin-ledger-restore-owner')).resolves.toEqual([])
    await expect(localRepository.listTrackers()).resolves.toEqual([])
  })

  it('recognizes older pending restore markers without mislabeling imported copies', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace('bin-legacy-marker-owner')
    await db.trackers.bulkPut([
      { ...tracker, id: 'legacy-pending-restore', deletedAt: null },
      { ...tracker, id: 'imported-pending-copy', deletedAt: null },
    ])
    await db.trackerVerification.bulkPut([
      { trackerId: 'legacy-pending-restore', status: 'pending-server-check' },
      { trackerId: 'imported-pending-copy', status: 'pending-server-check' },
    ])
    await db.syncRecords.put({ key: 'tracker:legacy-pending-restore', ownerUserId: 'bin-legacy-marker-owner', entity: 'tracker', entityId: 'legacy-pending-restore', serverRevision: 2 })

    await expect(localRepository.listPendingTrackerRestores('bin-legacy-marker-owner')).resolves.toMatchObject([{ tracker: { id: 'legacy-pending-restore' }, status: 'pending' }])
  })

  it('persists deletion offline, supersedes only tracker-owned sync work, and locks the original Wins choice', async () => {
    await activateWorkspace('bin-request-owner')
    await localRepository.saveTracker({ ...tracker, id: 'request-tracker' })
    await localRepository.saveTracker({ ...tracker, id: 'unrelated-tracker' })
    await localRepository.saveTrackerEntry({ trackerId: 'request-tracker', date: '2026-10-01', outcome: 'recorded', values: {}, note: 'keep until server confirms' })
    await localRepository.deleteTracker('request-tracker')
    await db.syncOperations.put({ id: 'rejected-config-to-delete', ownerUserId: 'bin-request-owner', entity: 'tracker', entityId: 'request-tracker', operation: 'upsert', expectedRevision: 1, payload: { ...tracker, id: 'request-tracker', name: 'Rejected local config' }, createdAt: '2026-10-02T00:00:00Z', attempts: 1, status: 'blocked', lastError: 'server rejected', failureCode: '23514' })
    const targetEntry = await db.trackerEntries.where('trackerId').equals('request-tracker').first()
    await db.syncOperations.put({ id: 'rejected-entry-to-delete', ownerUserId: 'bin-request-owner', entity: 'tracker_entry', entityId: targetEntry!.id, operation: 'upsert', expectedRevision: null, payload: targetEntry!, createdAt: '2026-10-03T00:00:00Z', attempts: 1, status: 'conflict', lastError: 'revision conflict' })
    await db.syncOperations.put({ id: 'unrelated-operation', ownerUserId: 'bin-request-owner', entity: 'tracker', entityId: 'unrelated-tracker', operation: 'upsert', expectedRevision: 1, payload: { ...tracker, id: 'unrelated-tracker' }, createdAt: '2026-10-03T00:00:00Z', attempts: 0, status: 'pending', lastError: null })

    await expect(localRepository.requestPermanentDeletion('request-tracker', 'keep_wins')).resolves.toBe('queued')
    const request = await db.permanentDeletionRequests.where('ownerUserId').equals('bin-request-owner').first()
    await expect(localRepository.requestPermanentDeletion('request-tracker', 'keep_wins')).resolves.toBe('queued')
    await expect(db.permanentDeletionRequests.where('ownerUserId').equals('bin-request-owner').toArray()).resolves.toHaveLength(1)
    await expect(db.permanentDeletionRequests.where('ownerUserId').equals('bin-request-owner').first()).resolves.toMatchObject({ id: request!.id, winsRetention: 'keep_wins' })
    await expect(db.syncOperations.get('rejected-config-to-delete')).resolves.toMatchObject({ status: 'superseded', supersededByDeletionRequestId: request!.id })
    await expect(db.syncOperations.get('rejected-entry-to-delete')).resolves.toMatchObject({ status: 'superseded', supersededByDeletionRequestId: request!.id })
    await expect(db.syncOperations.get('unrelated-operation')).resolves.toMatchObject({ status: 'pending' })
    await expect(localRepository.requestPermanentDeletion('request-tracker', 'delete_wins')).rejects.toThrow(/different Wins choice/)
    await expect(db.permanentDeletionRequests.where('ownerUserId').equals('bin-request-owner').first()).resolves.toMatchObject({ winsRetention: 'keep_wins' })
    await expect(db.trackers.get('request-tracker')).resolves.toMatchObject({ name: 'Read more', deletedAt: expect.any(String) })
    await expect(db.trackerEntries.where('trackerId').equals('request-tracker').count()).resolves.toBe(1)
  })

  it('replaces only a definitively rejected Delete Wins request with a new Keep Wins operation', async () => {
    await activateWorkspace('bin-rejected-policy-owner')
    await localRepository.saveTracker({ ...tracker, id: 'rejected-policy-tracker' })
    await localRepository.deleteTracker('rejected-policy-tracker')
    const rejected = { id: 'rejected-delete-wins', ownerUserId: 'bin-rejected-policy-owner', trackerId: 'rejected-policy-tracker', requestedAt: '2026-10-10T00:00:00.000Z', status: 'failed' as const, lastError: 'The server rejected the selected Wins policy: Wins history contains reconstructed, incomplete, or unattributed rewards and cannot be removed safely.', winsRetention: 'delete_wins' as const }
    await db.permanentDeletionRequests.put(rejected)

    await expect(localRepository.requestPermanentDeletion('rejected-policy-tracker', 'keep_wins')).resolves.toBe('queued')

    const requests = await db.permanentDeletionRequests.where('[ownerUserId+trackerId]').equals(['bin-rejected-policy-owner', 'rejected-policy-tracker']).toArray()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ status: 'pending', winsRetention: 'keep_wins' })
    expect(requests[0]!.id).not.toBe(rejected.id)
    await expect(db.permanentDeletionRequests.get(rejected.id)).resolves.toBeUndefined()
    await expect(db.trackers.get('rejected-policy-tracker')).resolves.toMatchObject({ deletedAt: expect.any(String) })
  })

  it('removes guest tracker child records and queued references without touching other trackers', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace(null)
    await localRepository.saveTracker({ ...tracker, id: 'guest-permanent-delete' })
    await localRepository.saveTracker({ ...tracker, id: 'guest-unrelated' })
    const deletedEntry = await localRepository.saveTrackerEntry({ trackerId: 'guest-permanent-delete', date: '2026-10-01', outcome: 'recorded', values: {}, note: 'delete this' })
    const unrelatedEntry = await localRepository.saveTrackerEntry({ trackerId: 'guest-unrelated', date: '2026-10-01', outcome: 'recorded', values: {}, note: 'keep this' })
    await localRepository.deleteTracker('guest-permanent-delete')
    const queuedAt = new Date().toISOString()
    await db.syncOperations.bulkPut([
      { id: 'guest-stale-parent', ownerUserId: null, entity: 'tracker', entityId: 'guest-permanent-delete', operation: 'upsert', expectedRevision: null, payload: { ...tracker, id: 'guest-permanent-delete', deletedAt: new Date().toISOString() }, createdAt: queuedAt, attempts: 0, status: 'pending', lastError: null },
      { id: 'guest-stale-child', ownerUserId: null, entity: 'tracker_entry', entityId: deletedEntry.id, operation: 'upsert', expectedRevision: null, payload: deletedEntry, createdAt: queuedAt, attempts: 0, status: 'pending', lastError: null },
      { id: 'guest-unrelated-child', ownerUserId: null, entity: 'tracker_entry', entityId: unrelatedEntry.id, operation: 'upsert', expectedRevision: null, payload: unrelatedEntry, createdAt: queuedAt, attempts: 0, status: 'pending', lastError: null },
    ])
    await db.syncConflicts.put({ id: 'guest-child-conflict', ownerUserId: 'former-owner', entity: 'tracker_entry', entityId: deletedEntry.id, localPayload: deletedEntry, remoteRecord: null, detectedAt: new Date().toISOString() })
    await db.syncConflicts.put({ id: 'unrelated-child-conflict', ownerUserId: 'former-owner', entity: 'tracker_entry', entityId: unrelatedEntry.id, localPayload: unrelatedEntry, remoteRecord: null, detectedAt: new Date().toISOString() })

    await expect(localRepository.requestPermanentDeletion('guest-permanent-delete', 'keep_wins')).resolves.toBe('deleted')

    await expect(db.trackers.get('guest-permanent-delete')).resolves.toBeUndefined()
    await expect(db.trackerEntries.get(deletedEntry.id)).resolves.toBeUndefined()
    await expect(db.syncOperations.filter((operation) => (operation.payload as { trackerId?: string } | undefined)?.trackerId === 'guest-permanent-delete').count()).resolves.toBe(0)
    await expect(db.syncConflicts.get('guest-child-conflict')).resolves.toBeUndefined()
    await expect(db.trackers.get('guest-unrelated')).resolves.toMatchObject({ deletedAt: null })
    await expect(db.trackerEntries.get(unrelatedEntry.id)).resolves.toMatchObject({ note: 'keep this' })
    await expect(db.syncOperations.get('guest-unrelated-child')).resolves.toMatchObject({ payload: { trackerId: 'guest-unrelated' } })
    await expect(db.syncConflicts.get('unrelated-child-conflict')).resolves.toBeDefined()
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

  it('blocks a stale Bin copy when the account deletion ledger already contains the tracker', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    await activateWorkspace('ledger-stale-owner')
    const stale = { ...tracker, id: 'ledger-stale-tracker', deletedAt: '2026-10-01T00:00:00.000Z' }
    await db.trackers.put(stale)
    await db.permanentDeletionLedger.put({ key: 'ledger-stale-owner:ledger-stale-tracker', ownerUserId: 'ledger-stale-owner', trackerId: stale.id, permanentlyDeletedAt: '2026-10-10T00:00:00.000Z' })

    await expect(localRepository.getTracker(stale.id)).resolves.toBeUndefined()
    await expect(localRepository.listDeletedTrackers()).resolves.toEqual([])
    await expect(localRepository.restoreTracker(stale.id)).rejects.toThrow(/permanently deleted from the account/)
    await expect(db.trackers.get(stale.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })
    await db.trackers.put({ ...stale, deletedAt: null })
    await expect(localRepository.getTracker(stale.id)).resolves.toBeUndefined()
    await expect(localRepository.listTrackers()).resolves.toEqual([])
    await expect(localRepository.listDeletedTrackers()).resolves.toEqual([])
    await expect(localRepository.saveTracker({ ...stale, deletedAt: null })).rejects.toThrow(/permanently deleted from the account/)
    await expect(localRepository.saveTrackerEntry({ trackerId: stale.id, date: '2026-10-11', outcome: 'recorded', values: {}, note: 'stale write' })).rejects.toThrow(/permanently deleted from the account/)
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
