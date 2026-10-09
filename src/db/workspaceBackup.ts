import { openDatabase } from './database'

export const WORKSPACE_BACKUP_FORMAT = 'ProgressTracker local workspace backup'
export const WORKSPACE_BACKUP_VERSION = 1

const backupStores = [
  'categories', 'dailyEntries', 'dailyJournals', 'goals', 'goalMetrics', 'goalProgressLogs',
  'settings', 'trackers', 'trackerEntries', 'workspaceMetadata', 'syncOperations', 'syncRecords', 'syncConflicts',
] as const

export type WorkspaceBackup = {
  format: typeof WORKSPACE_BACKUP_FORMAT
  version: typeof WORKSPACE_BACKUP_VERSION
  exportedAt: string
  workspace: { kind: 'guest' | 'account'; ownerUserId: string | null }
  stores: Record<(typeof backupStores)[number], unknown[]>
}

/** Read a consistent snapshot of only the currently active, explicitly expected workspace. */
export async function createWorkspaceBackup(expectedOwnerUserId: string | null): Promise<WorkspaceBackup> {
  const database = await openDatabase()
  const storeTables = backupStores.map((name) => database.table(name))
  return database.transaction('r', storeTables, async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== expectedOwnerUserId) {
      throw new Error('The open local workspace changed. Reopen the account page and try the export again.')
    }

    const storeRows = await Promise.all(backupStores.map(async (name) => [name, await database.table(name).toArray()] as const))
    return {
      format: WORKSPACE_BACKUP_FORMAT,
      version: WORKSPACE_BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      workspace: { kind: expectedOwnerUserId === null ? 'guest' : 'account', ownerUserId: expectedOwnerUserId },
      stores: Object.fromEntries(storeRows) as WorkspaceBackup['stores'],
    }
  })
}

export function downloadWorkspaceBackup(backup: WorkspaceBackup): void {
  const date = backup.exportedAt.slice(0, 10)
  const workspace = backup.workspace.kind === 'guest' ? 'guest' : `account-${backup.workspace.ownerUserId}`
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `progresstracker-${workspace}-${date}.json`
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function backupRecordCount(backup: WorkspaceBackup): number {
  return Object.values(backup.stores).reduce((count, rows) => count + rows.length, 0)
}
