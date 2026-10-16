import type { ProgressTrackerDatabase } from './database'

const permanentCodes = new Set(['22001', '22007', '22008', '22023', '22P02', '23502', '23503', '23505', '23514'])

/** Converts only known old validation failures that were incorrectly persisted as cloud conflicts. */
export async function migrateLegacyRejectedConflicts(database: ProgressTrackerDatabase, userId: string): Promise<number> {
  const metadata = await database.workspaceMetadata.get('workspace')
  if (metadata?.userId !== userId) throw new Error('The open local workspace does not belong to this account.')
  const conflicts = await database.syncConflicts.where('ownerUserId').equals(userId).toArray()
  let migrated = 0
  for (const conflict of conflicts) {
    if (conflict.remoteRecord !== null) continue
    const operation = await database.syncOperations.get(conflict.id)
    if (!operation || operation.ownerUserId !== userId || operation.status !== 'conflict') continue
    const message = conflict.reason ?? operation.lastError ?? ''
    const code = /^The server rejected this saved change \((\d{5})\)\./.exec(message)?.[1]
    if (!code || !permanentCodes.has(code)) continue
    await database.syncOperations.put({ ...operation, status: 'blocked', failureCode: code, blockedAt: conflict.detectedAt, lastError: message })
    await database.syncConflicts.delete(conflict.id)
    migrated += 1
  }
  return migrated
}
