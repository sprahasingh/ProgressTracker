import { openDatabase } from './database'
import type { SyncOperation } from './models'
import { migrateLegacyRejectedConflicts } from './legacySyncRejections'

export async function listBlockedSyncOperations(userId: string): Promise<SyncOperation[]> {
  const database = await openDatabase()
  await database.transaction('rw', [database.workspaceMetadata, database.syncOperations, database.syncConflicts], () => migrateLegacyRejectedConflicts(database, userId))
  return (await database.syncOperations.where('ownerUserId').equals(userId).toArray())
    .filter((operation) => operation.status === 'blocked')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

/** Includes retained rejections already superseded by a successful newer revision. */
export async function listSyncRecoveryOperations(userId: string): Promise<SyncOperation[]> {
  const database = await openDatabase()
  await database.transaction('rw', [database.workspaceMetadata, database.syncOperations, database.syncConflicts], () => migrateLegacyRejectedConflicts(database, userId))
  return (await database.syncOperations.where('ownerUserId').equals(userId).toArray())
    .filter((operation) => operation.status === 'blocked' || operation.status === 'superseded' || operation.status === 'discarded')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

/** Retries one permanently blocked payload only after an explicit user action. */
export async function retryBlockedSyncOperation(userId: string, operationId: string): Promise<void> {
  const database = await openDatabase()
  await database.transaction('rw', [database.workspaceMetadata, database.syncOperations], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== userId) throw new Error('The open local workspace does not belong to this account.')
    const operation = await database.syncOperations.get(operationId)
    if (!operation || operation.ownerUserId !== userId || operation.status !== 'blocked') throw new Error('This blocked sync operation is no longer available.')
    await database.syncOperations.put({ ...operation, status: 'pending', attempts: 0 })
  })
}
