import { getSupabaseClient } from '../services/supabase/client'
import { openDatabase, type ProgressTrackerDatabase } from './database'
import type { SyncOperation } from './models'
import { migrateLegacyRejectedConflicts } from './legacySyncRejections'

const permanentlyRejectedCodes = new Set(['22001', '22007', '22008', '22023', '22P02', '23502', '23503', '23505', '23514'])
const retryableTransientCodes = new Set(['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'FETCH_ERROR', 'NETWORK_ERROR', 'TIMEOUT'])

export function isRetryableTransientSyncFailure(code: string | undefined, message?: string | null): boolean {
  if (code && permanentlyRejectedCodes.has(code)) return false
  if (code && (/^5\d\d$/.test(code) || retryableTransientCodes.has(code))) return true
  return !code && Boolean(message && /\b(network|connection|timed? ?out|timeout|temporarily unavailable|service unavailable|gateway timeout)\b/i.test(message))
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export type RetryBlockedResult = 'queued' | 'conflict'
type RetryCloudTracker = { id: string; user_id: string; server_revision: number; definition: unknown; kind?: unknown; status?: unknown; name?: unknown; schema_version?: unknown; updated_at?: unknown; deleted_at?: unknown } | null
type RetryBlockedOptions = {
  database?: ProgressTrackerDatabase
  readCloudTracker?: (userId: string, trackerId: string) => Promise<RetryCloudTracker>
}

async function readCurrentCloudTracker(userId: string, trackerId: string): Promise<RetryCloudTracker> {
  const client = getSupabaseClient()
  if (!client) throw new Error('Sync cannot be retried because Supabase is not configured.')
  const { data: auth, error: authError } = await client.auth.getUser()
  if (authError || auth.user?.id !== userId) throw new Error('Sync retry stopped because the authenticated account changed.')
  const { data, error } = await client.from('trackers').select('id,user_id,server_revision,definition,kind,status,name,schema_version,updated_at,deleted_at')
    .eq('user_id', userId).eq('id', trackerId).maybeSingle()
  if (error) throw new Error(`The latest cloud revision could not be checked; nothing was retried. ${error.message}`)
  if (data && (data.user_id !== userId || data.id !== trackerId || !Number.isInteger(data.server_revision))) throw new Error('The cloud revision check returned an invalid tracker row; nothing was retried.')
  return data as RetryCloudTracker
}

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

/** Requeues only a verified transient rejection after checking local identity and the latest cloud revision. */
export async function retryBlockedSyncOperation(userId: string, operationId: string, options: RetryBlockedOptions = {}): Promise<RetryBlockedResult> {
  const database = options.database ?? await openDatabase()
  const initial = await database.transaction('r', [database.workspaceMetadata, database.syncOperations], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== userId) throw new Error('The open local workspace does not belong to this account.')
    const operation = await database.syncOperations.get(operationId)
    if (!operation || operation.ownerUserId !== userId || operation.status !== 'blocked') throw new Error('This blocked sync operation is no longer available.')
    if (operation.entity !== 'tracker') throw new Error('Only blocked tracker-definition writes can be retried from Account → Sync.')
    if (permanentlyRejectedCodes.has(operation.failureCode ?? '')) throw new Error(`This operation was permanently rejected by server validation (${operation.failureCode}) and cannot be retried unchanged. Correct it or use guarded recovery.`)
    if (!isRetryableTransientSyncFailure(operation.failureCode, operation.lastError)) throw new Error('This blocked operation has no verified transient error and cannot be replayed unchanged.')
    return operation
  })
  let cloud: RetryCloudTracker
  try {
    cloud = await (options.readCloudTracker ?? readCurrentCloudTracker)(userId, initial.entityId)
  } catch (cause) {
    throw new Error(`The latest cloud revision could not be checked; nothing was retried. ${cause instanceof Error ? cause.message : 'unknown read error'}`)
  }
  if (cloud && cloud.user_id !== userId) throw new Error('The cloud revision check returned another account’s tracker; nothing was retried.')
  return database.transaction('rw', [database.workspaceMetadata, database.trackers, database.syncRecords, database.syncOperations, database.syncConflicts], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== userId) throw new Error('The open local workspace changed accounts; nothing was retried.')
    const operation = await database.syncOperations.get(operationId)
    if (!operation || operation.ownerUserId !== userId || operation.status !== 'blocked') throw new Error('This blocked sync operation changed while retry was being checked; nothing was retried.')
    if (permanentlyRejectedCodes.has(operation.failureCode ?? '') || !isRetryableTransientSyncFailure(operation.failureCode, operation.lastError)) throw new Error('This operation is no longer classified as a retryable transient failure.')
    const siblings = (await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker', operation.entityId]).toArray())
      .filter((row) => !['superseded', 'discarded'].includes(row.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    const latestBlocked = [...siblings].reverse().find((row) => row.status === 'blocked')
    if (operation.entity !== 'tracker' || latestBlocked?.id !== operation.id) throw new Error('Only the latest blocked tracker definition can be retried; save the intended current configuration first.')
    if (siblings.some((row) => row.id !== operation.id && ['pending', 'in-flight', 'conflict'].includes(row.status))) throw new Error('Another tracker write is pending, running, or conflicted; no duplicate retry was queued.')
    const current = await database.trackers.get(operation.entityId)
    if (!current || stable(current) !== stable(operation.payload)) throw new Error('The rejected payload is not the current local tracker definition. Save or safely revert the intended configuration first.')
    if (await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker', operation.entityId]).count()) throw new Error('This tracker already has a saved cloud conflict; resolve it before retrying.')
    const acknowledged = await database.syncRecords.get(`tracker:${operation.entityId}`)
    const expected = operation.expectedRevision
    const cloudRevision = cloud?.server_revision ?? null
    if ((expected ?? null) !== (acknowledged?.serverRevision ?? null) || (expected ?? null) !== cloudRevision) {
      const reason = 'The cloud revision changed since this blocked write was created. Review the local and cloud versions before retrying.'
      await database.syncOperations.put({ ...operation, status: 'conflict', lastError: operation.lastError ?? reason })
      await database.syncConflicts.put({
        id: operation.id, ownerUserId: userId, entity: 'tracker', entityId: operation.entityId,
        localPayload: current, remoteRecord: cloud ? { ...cloud } : null,
        detectedAt: new Date().toISOString(), reason,
      })
      return 'conflict'
    }
    await database.syncOperations.put({ ...operation, status: 'pending', attempts: 0 })
    return 'queued'
  })
}
