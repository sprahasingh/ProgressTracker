import type { SupabaseClient } from '@supabase/supabase-js'
import { trackerDefinitionSchema, trackerEntrySchema } from '../../domain/trackers/schema'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { getSupabaseClient } from './client'
import { normalizeSyncTimestamp, normalizeTrackerEntryTimestamps, normalizeTrackerTimestamps } from './syncTimestamps'

export type CloudRecoverySnapshot = {
  retrievedAt: string
  schemaCompatibility: 'current' | 'legacy-no-holiday-treatment'
  trackers: Array<{ record: StoredTrackerDefinition; serverRevision: number }>
  entries: Array<{ record: StoredTrackerEntry; serverRevision: number }>
}

export type CloudRecoveryFailureCategory = 'authentication' | 'authorization' | 'network' | 'schema-compatibility' | 'local-storage' | 'invalid-cloud-data' | 'not-configured' | 'unknown'
export type CloudRecoveryDiagnostic = { operation: string; category: CloudRecoveryFailureCategory; stage: 'authenticate' | 'read' | 'validate' | 'local'; browser: string; occurredAt: string; code?: string }
export const CLOUD_RECOVERY_DIAGNOSTIC_EVENT = 'progress-tracker:cloud-recovery-diagnostic'

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { code?: unknown; status?: unknown }
  const code = typeof value.code === 'string' || typeof value.code === 'number' ? String(value.code) : typeof value.status === 'number' ? `HTTP_${value.status}` : ''
  return /^(?:[0-9A-Z]{5}|PGRST\d{3}|HTTP_\d{3})$/.test(code) ? code : undefined
}

function reportCloudRecoveryFailure(operation: string, category: CloudRecoveryFailureCategory, stage: CloudRecoveryDiagnostic['stage'], code?: string) {
  if (typeof window === 'undefined') return
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const browser = /Firefox\//.test(ua) ? 'firefox' : /Edg\//.test(ua) ? 'edge' : /Chrome\//.test(ua) ? 'chromium' : /Safari\//.test(ua) ? 'safari' : 'other'
  window.dispatchEvent(new CustomEvent<CloudRecoveryDiagnostic>(CLOUD_RECOVERY_DIAGNOSTIC_EVENT, { detail: { operation, category, stage, browser, occurredAt: new Date().toISOString(), ...(code ? { code } : {}) } }))
}

export class CloudRecoveryFailure extends Error {
  constructor(readonly category: CloudRecoveryFailureCategory, readonly operation = 'cloudRecovery.snapshot', readonly stage: CloudRecoveryDiagnostic['stage'] = 'read', readonly code?: string) {
    super(category === 'authentication' ? 'The signed-in account could not be authorized to read this cloud snapshot. Verify the account session and access, then retry.'
      : category === 'authorization' ? 'The signed-in account does not have permission to read this cloud snapshot. Contact support with the error category and retry later.'
        : category === 'network' ? 'The cloud snapshot could not be reached. Check the connection and retry.'
          : category === 'schema-compatibility' ? 'The cloud database schema is not compatible with this recovery view. No records were changed.'
        : category === 'not-configured' ? 'Cloud recovery is unavailable because the account service is not configured.'
          : category === 'invalid-cloud-data' ? 'The cloud returned records this app version cannot safely display.'
            : category === 'local-storage' ? 'Local browser storage failed. Cloud recovery did not change local records.'
              : 'The cloud snapshot could not be read because of an unexpected error. No records were changed.')
    this.name = 'CloudRecoveryFailure'
  }
}

type RecoveryClient = Pick<SupabaseClient, 'auth'> & { from: (table: string) => any }
const pageSize = 500

export function classifyCloudRecoveryError(error: unknown): CloudRecoveryFailureCategory {
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; code?: unknown; status?: unknown; message?: unknown }
    const code = safeErrorCode(error)
    const message = typeof value.message === 'string' ? value.message : ''
    if (value.name === 'LocalStorageFailure' || ['QuotaExceededError', 'InvalidStateError', 'NotSupportedError', 'SecurityError'].includes(String(value.name))) return 'local-storage'
    if (['42501'].includes(String(value.code)) || value.status === 403) return 'authorization'
    if (['42703', '42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(String(value.code))) return 'schema-compatibility'
    if (value.name === 'AuthError' || value.name === 'AuthApiError' || ['401', 'PGRST301'].includes(String(value.code)) || value.status === 401 || /invalid jwt|jwt expired|session.*expired|invalid.*session/i.test(message)) return 'authentication'
    if (value.name === 'TypeError' || value.name === 'AbortError' || value.code === 'FETCH_ERROR' || (typeof value.status === 'number' && value.status >= 500)) return 'network'
    if (code) return 'unknown'
  }
  return 'unknown'
}

function classifyRemoteError(error: unknown, operation: string, stage: CloudRecoveryDiagnostic['stage']): CloudRecoveryFailure {
  const category = classifyCloudRecoveryError(error)
  return new CloudRecoveryFailure(category, operation, stage, safeErrorCode(error))
}

function isMissingOptionalHolidayColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; message?: unknown }
  return ['42703', 'PGRST204'].includes(String(value.code)) && /holiday_treatment/i.test(typeof value.message === 'string' ? value.message : '')
}

async function assertAuthenticatedOwner(client: RecoveryClient, userId: string) {
  let result: Awaited<ReturnType<RecoveryClient['auth']['getUser']>>
  try { result = await client.auth.getUser() }
  catch (error) { const failure = classifyRemoteError(error, 'cloudRecovery.auth.getUser', 'authenticate'); reportCloudRecoveryFailure(failure.operation, failure.category, failure.stage, failure.code); throw failure }
  if (result.error || result.data.user?.id !== userId) {
    const failure = result.error ? classifyRemoteError(result.error, 'cloudRecovery.auth.getUser', 'authenticate') : new CloudRecoveryFailure('authentication', 'cloudRecovery.auth.getUser', 'authenticate')
    reportCloudRecoveryFailure(failure.operation, failure.category, failure.stage, failure.code)
    throw failure
  }
}

async function readAll(client: RecoveryClient, table: 'trackers' | 'tracker_entries', userId: string, requestedColumns: string, allowLegacyHolidayColumn = false): Promise<{ rows: Record<string, unknown>[]; legacyHolidayTreatmentUnavailable: boolean }> {
  const result: Record<string, unknown>[] = []
  let cursor: string | null = null
  let columns = requestedColumns
  let legacyHolidayTreatmentUnavailable = false
  while (true) {
    let request = client.from(table).select(columns).eq('user_id', userId).order('id', { ascending: true }).limit(pageSize)
    if (cursor) request = request.gt('id', cursor)
    let response: { data: unknown; error: unknown }
    try { response = await request }
    catch (error) { const failure = classifyRemoteError(error, `cloudRecovery.${table}.select`, 'read'); reportCloudRecoveryFailure(failure.operation, failure.category, failure.stage, failure.code); throw failure }
    if (response.error) {
      if (allowLegacyHolidayColumn && !legacyHolidayTreatmentUnavailable && isMissingOptionalHolidayColumn(response.error)) {
        // This nullable column did not exist before the holiday-treatment migration, so no
        // explicit values could have been stored in that older schema. Retry read-only and
        // disclose the older schema in the recovery snapshot.
        legacyHolidayTreatmentUnavailable = true
        columns = columns.replace('holiday_treatment,', '')
        cursor = null
        result.length = 0
        continue
      }
      const failure = classifyRemoteError(response.error, `cloudRecovery.${table}.select`, 'read')
      reportCloudRecoveryFailure(failure.operation, failure.category, failure.stage, failure.code)
      throw failure
    }
    if (!Array.isArray(response.data)) { const failure = new CloudRecoveryFailure('unknown', `cloudRecovery.${table}.select`, 'validate'); reportCloudRecoveryFailure(failure.operation, failure.category, failure.stage); throw failure }
    const rows = response.data as Record<string, unknown>[]
    const ids = rows.map((row) => row.id)
    const ordered = ids.every((id, index) => typeof id === 'string' && (index === 0 ? !cursor || id > cursor : id > (ids[index - 1] as string)))
    if (rows.some((row) => row.user_id !== userId || typeof row.id !== 'string') || !ordered) { const failure = new CloudRecoveryFailure('invalid-cloud-data', `cloudRecovery.${table}.owner-validation`, 'validate'); reportCloudRecoveryFailure(failure.operation, failure.category, failure.stage); throw failure }
    result.push(...rows)
    if (rows.length < pageSize) break
    cursor = rows.at(-1)?.id as string
  }
  return { rows: result, legacyHolidayTreatmentUnavailable }
}

/** Reads only owner-scoped cloud tracker and entry rows. It never opens IndexedDB or writes to Supabase. */
export async function readCloudRecoverySnapshot(userId: string, clientInput: SupabaseClient | null = getSupabaseClient()): Promise<CloudRecoverySnapshot> {
  if (!clientInput) throw new CloudRecoveryFailure('not-configured')
  const client = clientInput as RecoveryClient
  await assertAuthenticatedOwner(client, userId)
  const [trackersRead, entriesRead] = await Promise.all([
    readAll(client, 'trackers', userId, 'id,user_id,server_revision,definition,kind,status,name,schema_version,created_at,updated_at,deleted_at'),
    readAll(client, 'tracker_entries', userId, 'id,user_id,tracker_id,entry_date,outcome,holiday_treatment,entry_values,note,created_at,updated_at,deleted_at,server_revision', true),
  ])
  const trackerRows = trackersRead.rows
  const entryRows = entriesRead.rows
  try {
    const trackers = trackerRows.map((row) => {
      const tracker = trackerDefinitionSchema.parse(normalizeTrackerTimestamps(row.definition)) as StoredTrackerDefinition
      const deletedAt = row.deleted_at === null ? null : normalizeSyncTimestamp(row.deleted_at, 'deleted_at')
      if (tracker.id !== row.id || tracker.kind !== row.kind || tracker.status !== row.status || tracker.schemaVersion !== row.schema_version || tracker.deletedAt !== deletedAt) throw new Error('Tracker row mismatch')
      if (!Number.isSafeInteger(row.server_revision) || (row.server_revision as number) < 1) throw new Error('Tracker revision is invalid')
      return { record: tracker, serverRevision: row.server_revision as number }
    })
    const entries = entryRows.map((row) => {
      const record = trackerEntrySchema.parse(normalizeTrackerEntryTimestamps({
      id: row.id,
      trackerId: row.tracker_id,
      date: row.entry_date,
      outcome: row.outcome,
      ...(row.holiday_treatment ? { holidayTreatment: row.holiday_treatment } : {}),
      values: row.entry_values,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      })) as StoredTrackerEntry
      if (!Number.isSafeInteger(row.server_revision) || (row.server_revision as number) < 1) throw new Error('Entry revision is invalid')
      return { record, serverRevision: row.server_revision as number }
    })
    return { retrievedAt: new Date().toISOString(), schemaCompatibility: entriesRead.legacyHolidayTreatmentUnavailable ? 'legacy-no-holiday-treatment' : 'current', trackers, entries }
  } catch {
    const failure = new CloudRecoveryFailure('invalid-cloud-data', 'cloudRecovery.snapshot.validation', 'validate')
    reportCloudRecoveryFailure(failure.operation, failure.category, failure.stage)
    throw failure
  }
}
