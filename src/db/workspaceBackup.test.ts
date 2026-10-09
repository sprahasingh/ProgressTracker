import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateWorkspace, db, ProgressTrackerDatabase } from './database'
import { localRepository } from './localRepository'
import { backupRecordCount, createWorkspaceBackup, downloadWorkspaceBackup, previewWorkspaceRestore, restoreWorkspaceBackup, WORKSPACE_BACKUP_FORMAT, WORKSPACE_BACKUP_VERSION, type WorkspaceBackup } from './workspaceBackup'

const accountIds: string[] = []
const restoreTracker = {
  schemaVersion: 1, id: 'restore-tracker', name: 'Restore me', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [], customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

async function emptyActiveAccountExceptMetadata() {
  await db.transaction('rw', [db.categories, db.dailyEntries, db.dailyJournals, db.goals, db.goalMetrics, db.goalProgressLogs, db.settings, db.trackers, db.trackerEntries, db.syncOperations, db.syncRecords, db.syncConflicts], async () => {
    await Promise.all([db.categories.clear(), db.dailyEntries.clear(), db.dailyJournals.clear(), db.goals.clear(), db.goalMetrics.clear(), db.goalProgressLogs.clear(), db.settings.clear(), db.trackers.clear(), db.trackerEntries.clear(), db.syncOperations.clear(), db.syncRecords.clear(), db.syncConflicts.clear()])
  })
}

afterEach(async () => {
  vi.unstubAllEnvs()
  db.close()
  const names = ['ProgressTracker', ...accountIds.splice(0).map((id) => `ProgressTracker:account:${encodeURIComponent(id)}`)]
  await Promise.all(names.map(async (name) => {
    const database = new ProgressTrackerDatabase(name)
    await database.delete()
  }))
})

describe('workspace backups', () => {
  it('validates and restores v2 planning data with its pending sync payload intact', async () => {
    const accountId = `planning-backup-${crypto.randomUUID()}`
    accountIds.push(accountId)
    const planned = {
      ...restoreTracker, id: 'backup-planned-goal', schemaVersion: 2 as const, kind: 'goal' as const,
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' as const, unit: 'pages', thresholds: { direction: 'increase' as const, minimum: 2, target: 5, stretch: 8, streakQualification: 'minimum' as const } }],
      deadline: '2026-12-31', goalPlanning: { mode: 'cumulative-deadline' as const, progressSemantics: { pages: 'incremental' as const }, dailyTargets: { pages: 3 }, cumulativeTargets: { pages: 100 } },
    }
    await activateWorkspace(accountId)
    await localRepository.saveTracker(planned as never)
    const backup = await createWorkspaceBackup(accountId)
    await emptyActiveAccountExceptMetadata()
    await expect(previewWorkspaceRestore(backup, accountId)).resolves.toMatchObject({ conflicts: [] })
    await restoreWorkspaceBackup(backup, accountId)
    await expect(db.trackers.get(planned.id)).resolves.toMatchObject({ schemaVersion: 2, goalPlanning: planned.goalPlanning })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals([accountId, 'tracker', planned.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 2, goalPlanning: planned.goalPlanning } })
  })

  it('exports and restores v3 allocations and timezone together with the queued cloud payload', async () => {
    const accountId = `planning-v3-backup-${crypto.randomUUID()}`
    accountIds.push(accountId)
    const planned = {
      ...restoreTracker, id: 'backup-v3-goal', schemaVersion: 3 as const, kind: 'goal' as const, deadline: '2026-12-31',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' as const, unit: 'pages' }],
      goalPlanning: { mode: 'cumulative-deadline' as const, progressSemantics: { pages: 'incremental' as const }, dailyTargets: {}, cumulativeTargets: { pages: 100 }, planningTimeZone: 'Asia/Kolkata', allocations: { pages: { '2026-10-09': 4 } } },
    }
    await activateWorkspace(accountId)
    await localRepository.saveTracker(planned as never)
    const backup = await createWorkspaceBackup(accountId)
    await emptyActiveAccountExceptMetadata()
    await expect(previewWorkspaceRestore(backup, accountId)).resolves.toMatchObject({ conflicts: [] })
    await restoreWorkspaceBackup(backup, accountId)
    await expect(db.trackers.get(planned.id)).resolves.toMatchObject({ schemaVersion: 3, goalPlanning: planned.goalPlanning })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals([accountId, 'tracker', planned.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 3, goalPlanning: planned.goalPlanning } })
  })

  it('refuses to restore a v3 backup in production while migration readiness is disabled', async () => {
    const accountId = `planning-v3-gate-${crypto.randomUUID()}`
    accountIds.push(accountId)
    const planned = {
      ...restoreTracker, id: 'backup-v3-gate-goal', schemaVersion: 3 as const, kind: 'goal' as const, deadline: '2026-12-31',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' as const }],
      goalPlanning: { mode: 'cumulative-deadline' as const, progressSemantics: { pages: 'incremental' as const }, dailyTargets: {}, cumulativeTargets: { pages: 100 }, planningTimeZone: 'UTC', allocations: { pages: { '2026-10-09': 4 } } },
    }
    await activateWorkspace(accountId)
    await localRepository.saveTracker(planned as never)
    const backup = await createWorkspaceBackup(accountId)
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V3', '')
    await expect(restoreWorkspaceBackup(backup, accountId)).rejects.toThrow(/cannot restore schema v3/)
    await expect(db.trackers.get(planned.id)).resolves.toMatchObject({ schemaVersion: 3 })
  })

  it('exports a consistent, versioned snapshot of the current workspace, including pending sync data', async () => {
    const accountId = `backup-${crypto.randomUUID()}`
    accountIds.push(accountId)
    await activateWorkspace(null)
    await db.trackers.put({ id: 'guest-tracker', name: 'Guest only' } as never)

    await activateWorkspace(accountId)
    await db.trackers.put({ id: 'account-tracker', name: 'Account only' } as never)
    await db.syncOperations.put({ id: 'queued-write', ownerUserId: accountId, entity: 'tracker', entityId: 'account-tracker', operation: 'upsert', expectedRevision: null, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'pending', lastError: 'offline' })
    await db.syncConflicts.put({ id: 'conflict-copy', ownerUserId: accountId, entity: 'tracker', entityId: 'account-tracker', localPayload: { id: 'account-tracker' } as never, remoteRecord: null, detectedAt: '2026-01-02T00:00:00.000Z' })

    const backup = await createWorkspaceBackup(accountId)
    expect(backup).toMatchObject({
      format: WORKSPACE_BACKUP_FORMAT,
      version: WORKSPACE_BACKUP_VERSION,
      workspace: { kind: 'account', ownerUserId: accountId },
      stores: {
        trackers: [{ id: 'account-tracker' }],
        syncOperations: [{ id: 'queued-write', lastError: 'offline' }],
        syncConflicts: [{ id: 'conflict-copy' }],
      },
    })
    expect(JSON.stringify(backup)).not.toContain('guest-tracker')
    expect(backupRecordCount(backup)).toBeGreaterThanOrEqual(3)
  })

  it('refuses an export when the expected owner is not the active workspace', async () => {
    const activeId = `active-${crypto.randomUUID()}`
    const staleId = `stale-${crypto.randomUUID()}`
    accountIds.push(activeId, staleId)
    await activateWorkspace(activeId)
    await expect(createWorkspaceBackup(staleId)).rejects.toThrow('workspace changed')
  })

  it('exports guest data only when the guest workspace is active', async () => {
    await activateWorkspace(null)
    await db.dailyJournals.put({ id: 'guest-journal', date: '2026-10-09', body: 'private guest note' } as never)
    const backup = await createWorkspaceBackup(null)
    expect(backup.workspace).toEqual({ kind: 'guest', ownerUserId: null })
    expect(backup.stores.dailyJournals).toContainEqual(expect.objectContaining({ id: 'guest-journal' }))
  })

  it('downloads a JSON file and releases its temporary object URL', () => {
    const oldCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const oldRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const createObjectURL = vi.fn(() => 'blob:workspace-backup')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.useFakeTimers()
    const backup = {
      format: WORKSPACE_BACKUP_FORMAT, version: WORKSPACE_BACKUP_VERSION,
      exportedAt: '2026-10-09T00:00:00.000Z', workspace: { kind: 'guest', ownerUserId: null },
      stores: Object.fromEntries(['categories','dailyEntries','dailyJournals','goals','goalMetrics','goalProgressLogs','settings','trackers','trackerEntries','workspaceMetadata','syncOperations','syncRecords','syncConflicts'].map((name) => [name, []])),
    } as unknown as WorkspaceBackup
    try {
      downloadWorkspaceBackup(backup)
      expect(createObjectURL).toHaveBeenCalledOnce()
      expect(click).toHaveBeenCalledOnce()
      expect(document.querySelector('a[download="progresstracker-guest-2026-10-09.json"]')).toBeNull()
      expect(revokeObjectURL).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1000)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:workspace-backup')
    } finally {
      vi.useRealTimers()
      click.mockRestore()
      if (oldCreate) Object.defineProperty(URL, 'createObjectURL', oldCreate)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (oldRevoke) Object.defineProperty(URL, 'revokeObjectURL', oldRevoke)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })

  it('restores missing records atomically and skips identical records on repeated restore', async () => {
    const accountId = `restore-${crypto.randomUUID()}`
    accountIds.push(accountId)
    await activateWorkspace(accountId)
    await db.trackers.put(restoreTracker as never)
    await db.trackerEntries.put({ id: 'restore-entry', trackerId: restoreTracker.id, date: '2026-10-08', outcome: 'skipped', values: {}, note: '', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', deletedAt: null })
    await db.syncOperations.put({ id: 'restore-job', ownerUserId: accountId, entity: 'tracker', entityId: restoreTracker.id, operation: 'upsert', expectedRevision: null, payload: restoreTracker as never, createdAt: '2026-10-08T00:00:00.000Z', attempts: 0, status: 'pending', lastError: null })
    const backup = await createWorkspaceBackup(accountId)
    await emptyActiveAccountExceptMetadata()

    const preview = await previewWorkspaceRestore(backup, accountId)
    expect(preview.conflicts).toEqual([])
    expect(preview.added).toMatchObject({ trackers: 1, trackerEntries: 1, syncOperations: 1 })
    const restored = await restoreWorkspaceBackup(backup, accountId)
    expect(restored.added).toMatchObject({ trackers: 1, trackerEntries: 1, syncOperations: 1 })
    await expect(db.trackers.get(restoreTracker.id)).resolves.toMatchObject({ name: restoreTracker.name })
    await expect(db.trackerEntries.get('restore-entry')).resolves.toMatchObject({ trackerId: restoreTracker.id })
    await expect(db.syncOperations.get('restore-job')).resolves.toMatchObject({ ownerUserId: accountId, status: 'pending' })

    const repeated = await restoreWorkspaceBackup(backup, accountId)
    expect(Object.values(repeated.added).reduce((sum, count) => sum + count, 0)).toBe(0)
    expect(repeated.alreadyPresent.trackers).toBe(1)
  })

  it('blocks ID collisions without overwriting the current workspace', async () => {
    const accountId = `restore-conflict-${crypto.randomUUID()}`
    accountIds.push(accountId)
    await activateWorkspace(accountId)
    await db.trackers.put(restoreTracker as never)
    const backup = await createWorkspaceBackup(accountId)
    await emptyActiveAccountExceptMetadata()
    await db.trackers.put({ ...restoreTracker, name: 'Newer local value' } as never)

    const preview = await previewWorkspaceRestore(backup, accountId)
    expect(preview.conflicts).toContain(`trackers.${restoreTracker.id}: a different local record already uses this ID`)
    await expect(restoreWorkspaceBackup(backup, accountId)).rejects.toThrow('Restore stopped without changing data')
    await expect(db.trackers.get(restoreTracker.id)).resolves.toMatchObject({ name: 'Newer local value' })
  })
})
