import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateWorkspace, db, ProgressTrackerDatabase } from './database'
import { backupRecordCount, createWorkspaceBackup, downloadWorkspaceBackup, WORKSPACE_BACKUP_FORMAT, WORKSPACE_BACKUP_VERSION, type WorkspaceBackup } from './workspaceBackup'

const accountIds: string[] = []

afterEach(async () => {
  db.close()
  const names = ['ProgressTracker', ...accountIds.splice(0).map((id) => `ProgressTracker:account:${encodeURIComponent(id)}`)]
  await Promise.all(names.map(async (name) => {
    const database = new ProgressTrackerDatabase(name)
    await database.delete()
  }))
})

describe('workspace backups', () => {
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
})
