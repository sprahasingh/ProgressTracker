import type { SupabaseClient } from '@supabase/supabase-js'
import { trackerEvaluationSignature } from '../domain/trackers/ruleVersions'
import type { TrackerDefinition } from '../domain/trackers/types'
import { db, openDatabase, queueSyncMutation, type ProgressTrackerDatabase } from './database'
import type { PermanentDeletionLedgerEntry, PermanentDeletionRequest, StoredTrackerDefinition, StoredTrackerEntry, SyncConflict, SyncOperation, SyncRecordState } from './models'
import { getSupabaseClient } from '../services/supabase/client'
import { trackerDefinitionSchema, trackerEntrySchema, validateTrackerEntryValues } from '../domain/trackers/schema'
import { publishWorkspaceMutation } from './workspaceMutationEvents'

export const TRACKER_RECOVERY_TARGETS = [
  {
    trackerId: '8e0c514e-ad75-47e1-abed-a770023b545e', name: '100 Days Of MERN', metricId: '1d3ebaa0-6b7e-4b5d-a7aa-2cbb62e2b0ef',
    expectedCloudRevision: 1, expectedCloudSchemaVersion: 6, expectedLocalSchemaVersion: 10,
    operationIds: [
      { id: 'f4d5f15b-b890-437b-9fe2-bb9d8d23b1c6', schemaVersion: 8, expectedRevision: 1, obsolete: true },
      { id: '28bf5f83-9c6b-4ab4-b61f-acfee4e74d2e', schemaVersion: 10, expectedRevision: 1, obsolete: false },
    ],
  },
  {
    trackerId: '7d9798c5-9671-4139-9e59-56bb4544a805', name: '100 Days Of CP', metricId: '40de0b2b-ad9e-4392-a5aa-ce53d9c2ff70',
    expectedCloudRevision: 3, expectedCloudSchemaVersion: 8, expectedLocalSchemaVersion: 8,
    operationIds: [{ id: '3f00df8b-5d9b-42e6-9693-312e3995035e', schemaVersion: 8, expectedRevision: 3, obsolete: false }],
  },
] as const

export const TRACKER_RECOVERY_BACKUP_FORMAT = 'ProgressTracker blocked tracker recovery backup'
export const TRACKER_RECOVERY_BACKUP_VERSION = 1

export type RecoveryCloudTracker = {
  id: string; user_id: string; schema_version: number; server_revision: number; definition: unknown
  kind: string; status: string; name: string; updated_at: string; deleted_at: string | null
}
export type RecoveryCloudEntry = {
  id: string; user_id: string; tracker_id: string; entry_date: string; outcome: string; entry_values: Record<string, unknown>
  note: string; created_at: string; updated_at: string; deleted_at: string | null; server_revision: number
}
export type TrackerRecoveryCloudReader = {
  readTrackers(userId: string, trackerIds: string[]): Promise<RecoveryCloudTracker[]>
  readEntries(userId: string, trackerIds: string[]): Promise<RecoveryCloudEntry[]>
}

export type TrackerRecoveryBackup = {
  format: typeof TRACKER_RECOVERY_BACKUP_FORMAT
  version: typeof TRACKER_RECOVERY_BACKUP_VERSION
  exportedAt: string
  workspace: { ownerUserId: string }
  scope: { trackerIds: string[]; requiredOperationIds: string[] }
  stores: {
    workspaceMetadata: Array<{ key: string; userId: string | null; [key: string]: unknown }>
    trackers: StoredTrackerDefinition[]
    trackerEntries: StoredTrackerEntry[]
    syncOperations: SyncOperation[]
    syncRecords: SyncRecordState[]
    syncConflicts: SyncConflict[]
    permanentDeletionRequests: PermanentDeletionRequest[]
    permanentDeletionLedger: PermanentDeletionLedgerEntry[]
    trackerVerification: Array<{ trackerId: string; status: 'pending-server-check'; purpose?: 'restore' | 'import' }>
  }
  manifest: { trackerCount: number; entryCount: number; operationCount: number; syncRecordCount: number; conflictCount: number; deletionRequestCount: number; deletionLedgerCount: number; verificationCount: number }
}

export type TrackerRecoveryPreview = {
  generatedAt: string
  ownerUserId: string
  cloudReadOnly: true
  readyForReview: boolean
  safeToExecute: false
  genericScope: boolean
  status: 'ready-for-review' | 'conflict' | 'incomplete'
  blockers: string[]
  trackers: Array<{
    trackerId: string; name: string; localSchemaVersion: number | null; localAcknowledgedRevision: number | null
    cloudSchemaVersion: number | null; cloudRevision: number | null; cloudMetricType: string | null
    localMetricType: string | null; proposedMetricType: 'quantity' | null
    metricSummary: Array<{ id: string; name: string; localType: string | null; cloudType: string | null }>
    latestRuleVersion: null | { revision: number; application: string; effectiveFrom: string; metricType: string | null; matchesCurrentAfterCorrection: boolean }
    historicalRuleVersions: Array<{ revision: number; application: string; effectiveFrom: string; metricType: string | null }>
    milestoneSnapshots: Array<{ id: string; title: string; measureTypeSnapshot: string | null }>
    diffs: Array<{ path: string; before: unknown; after: unknown }>
    discardDiffs: Array<{ path: string; before: unknown; after: unknown }>
    discardBlockers: string[]
    proposedDefinition: TrackerDefinition | null
    localConflicts: Array<{ id: string; entity: string; entityId: string; detectedAt: string; reason: string | null }>
    permanentDeletionRequests: Array<{ id: string; status: string; requestedAt: string; lastError: string | null; winsRetention?: string }>
    permanentDeletionLedger: Array<{ permanentlyDeletedAt: string }>
    localEntries: Array<{ id: string; date: string; outcome: string; values: StoredTrackerEntry['values']; note: string; createdAt: string; updatedAt: string; deletedAt: string | null; syncStatus: string; acknowledgedRevision: number | null }>
    cloudEntries: Array<{ id: string; date: string; outcome: string; values: Record<string, unknown>; note: string; createdAt: string; updatedAt: string; deletedAt: string | null; serverRevision: number }>
    entryConflicts: string[]
    operations: Array<{ id: string; entity: string; entityId: string; status: string; expectedRevision: number | null; schemaVersion: number | null; obsolete: boolean; payload: SyncOperation['payload']; failureCode: string | null; databaseTable: string | null; databaseConstraint: string | null; serverError: string | null; lastError: string | null }>
  }>
  unrelatedPendingOperationsExcluded: true
  progressionState: { localMaterializedRecords: false; note: string }
  backup: TrackerRecoveryBackup
}

type RecoveryReadClient = Pick<SupabaseClient, 'auth'> & {
  from: (table: string) => any
}

function requireRows<T>(data: unknown, label: string): T[] {
  if (!Array.isArray(data)) throw new Error(`Fresh cloud ${label} could not be read.`)
  return data as T[]
}

/** Only performs authenticated SELECTs. This reader never invokes an RPC or writes to Supabase. */
export function createTrackerRecoveryCloudReader(clientInput: SupabaseClient | null = getSupabaseClient()): TrackerRecoveryCloudReader {
  if (!clientInput) throw new Error('Cloud state cannot be checked because Supabase is not configured.')
  const client = clientInput as RecoveryReadClient
  return {
    async readTrackers(userId, trackerIds) {
      const { data: auth, error: authError } = await client.auth.getUser()
      if (authError || auth.user?.id !== userId) throw new Error('Cloud preview stopped because the authenticated account changed.')
      const { data, error } = await client.from('trackers')
        .select('id,user_id,schema_version,server_revision,definition,kind,status,name,updated_at,deleted_at')
        .eq('user_id', userId).in('id', trackerIds)
      if (error) throw new Error(`Fresh cloud tracker state could not be read: ${error.message}`)
      return requireRows<RecoveryCloudTracker>(data, 'tracker state')
    },
    async readEntries(userId, trackerIds) {
      const { data: auth, error: authError } = await client.auth.getUser()
      if (authError || auth.user?.id !== userId) throw new Error('Cloud preview stopped because the authenticated account changed.')
      const result: RecoveryCloudEntry[] = []
      const pageSize = 500
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await client.from('tracker_entries')
          .select('id,user_id,tracker_id,entry_date,outcome,entry_values,note,created_at,updated_at,deleted_at,server_revision')
          .eq('user_id', userId).in('tracker_id', trackerIds).order('id', { ascending: true }).range(offset, offset + pageSize - 1)
        if (error) throw new Error(`Fresh cloud check-in state could not be read: ${error.message}`)
        const page = requireRows<RecoveryCloudEntry>(data, 'check-in state')
        result.push(...page)
        if (page.length < pageSize) return result
      }
    },
  }
}

type LocalSnapshot = {
  metadata: Array<{ key: string; userId: string | null; [key: string]: unknown }>
  trackers: StoredTrackerDefinition[]
  entries: StoredTrackerEntry[]
  operations: SyncOperation[]
  syncRecords: SyncRecordState[]
  conflicts: SyncConflict[]
  permanentDeletionRequests: PermanentDeletionRequest[]
  permanentDeletionLedger: PermanentDeletionLedgerEntry[]
  verification: Array<{ trackerId: string; status: 'pending-server-check'; purpose?: 'restore' | 'import' }>
}

async function readLocalSnapshot(database: ProgressTrackerDatabase, userId: string, requestedTrackerIds: string[] = TRACKER_RECOVERY_TARGETS.map((target) => target.trackerId)): Promise<LocalSnapshot> {
  // Requiring an already open account DB prevents this read-only feature from
  // opening IndexedDB and implicitly running a version upgrade.
  if (!database.isOpen()) throw new Error('Open the signed-in account workspace before inspecting local recovery data.')
  return database.transaction('r', [database.workspaceMetadata, database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts, database.permanentDeletionRequests, database.permanentDeletionLedger, database.trackerVerification], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== userId) throw new Error('The open local workspace does not belong to this account.')
    const [trackers, entries, operations, syncRecords, conflicts, deletionRequests, deletionLedger, verification] = await Promise.all([
      database.trackers.where('id').anyOf(requestedTrackerIds).toArray(),
      database.trackerEntries.where('trackerId').anyOf(requestedTrackerIds).toArray(),
      database.syncOperations.where('ownerUserId').equals(userId).toArray(),
      database.syncRecords.where('ownerUserId').equals(userId).toArray(),
      database.syncConflicts.where('ownerUserId').equals(userId).toArray(),
      database.permanentDeletionRequests.where('ownerUserId').equals(userId).toArray(),
      database.permanentDeletionLedger.where('ownerUserId').equals(userId).toArray(),
      database.trackerVerification.where('trackerId').anyOf(requestedTrackerIds).toArray(),
    ])
    const entryIds = new Set<string>(entries.map((entry) => entry.id))
    const targetIds = new Set<string>(requestedTrackerIds)
    const conflictEntryIds = new Set(conflicts.filter((conflict) => conflict.entity === 'tracker_entry' && (targetIds.has((conflict.localPayload as StoredTrackerEntry | undefined)?.trackerId ?? '') || entryIds.has(conflict.entityId))).map((conflict) => conflict.entityId))
    const relatedOperation = (operation: SyncOperation) => targetIds.has(operation.entityId) && operation.entity === 'tracker'
      || operation.entity === 'tracker_entry' && (entryIds.has(operation.entityId) || conflictEntryIds.has(operation.entityId) || (operation.payload as StoredTrackerEntry | undefined)?.trackerId && targetIds.has((operation.payload as StoredTrackerEntry).trackerId))
    const relatedConflict = (conflict: SyncConflict) => targetIds.has(conflict.entityId) && conflict.entity === 'tracker'
      || conflict.entity === 'tracker_entry' && (entryIds.has(conflict.entityId) || (conflict.localPayload as StoredTrackerEntry | undefined)?.trackerId && targetIds.has((conflict.localPayload as StoredTrackerEntry).trackerId))
    const relatedOperations = operations.filter(relatedOperation)
    const relatedEntryOperationIds = new Set<string>(relatedOperations.filter((operation) => operation.entity === 'tracker_entry').map((operation) => operation.entityId))
    return {
      metadata: [metadata], trackers, entries,
      operations: relatedOperations,
      syncRecords: syncRecords.filter((record) => record.entity === 'tracker' && targetIds.has(record.entityId) || record.entity === 'tracker_entry' && (entryIds.has(record.entityId) || conflictEntryIds.has(record.entityId) || relatedEntryOperationIds.has(record.entityId))),
      conflicts: conflicts.filter(relatedConflict),
      permanentDeletionRequests: deletionRequests.filter((request) => targetIds.has(request.trackerId)),
      permanentDeletionLedger: deletionLedger.filter((record) => targetIds.has(record.trackerId)),
      verification,
    }
  })
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function normalizedTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sameEntry(local: StoredTrackerEntry, cloud: RecoveryCloudEntry): boolean {
  return local.id === cloud.id && local.trackerId === cloud.tracker_id && local.date === cloud.entry_date
    && local.outcome === cloud.outcome && stable(local.values) === stable(cloud.entry_values) && local.note === cloud.note
    && normalizedTime(local.createdAt) === normalizedTime(cloud.created_at)
    && normalizedTime(local.updatedAt) === normalizedTime(cloud.updated_at)
    && normalizedTime(local.deletedAt) === normalizedTime(cloud.deleted_at)
}

function correctedDefinition(tracker: TrackerDefinition, metricId: string, blockers: string[]) {
  const copy = JSON.parse(JSON.stringify(tracker)) as TrackerDefinition
  const metricIndex = copy.metrics.findIndex((metric) => metric.id === metricId)
  if (metricIndex < 0) {
    blockers.push(`Tracker ${tracker.id}: the expected existing measure is missing.`)
    return { definition: copy, diffs: [] as TrackerRecoveryPreview['trackers'][number]['diffs'], latest: null, historical: [], milestoneSnapshots: [] }
  }
  const measure = copy.metrics[metricIndex]!
  const diffs: TrackerRecoveryPreview['trackers'][number]['diffs'] = []
  if (measure.valueType === 'duration') {
    diffs.push({ path: `metrics[${metricId}].valueType`, before: 'duration', after: 'quantity' })
    measure.valueType = 'quantity'
  } else if (measure.valueType !== 'quantity') {
    blockers.push(`Tracker ${tracker.id}: the existing measure has unexpected type ${measure.valueType}.`)
  }

  const versions = copy.ruleVersions ?? []
  const latestVersion = versions.at(-1)
  const historical = versions.slice(0, -1).map((version) => ({
    revision: version.revision, application: version.application, effectiveFrom: version.effectiveFrom,
    metricType: version.evaluation.metrics.find((metric) => metric.id === metricId)?.valueType ?? null,
  }))
  let latest: TrackerRecoveryPreview['trackers'][number]['latestRuleVersion'] = null
  if (copy.schemaVersion === 10) {
    if (!latestVersion) blockers.push(`Tracker ${tracker.id}: schema v10 has no rule-version history.`)
    else {
      const latestMetric = latestVersion.evaluation.metrics.find((metric) => metric.id === metricId)
      if (!latestMetric) blockers.push(`Tracker ${tracker.id}: the latest rule evaluation is missing the expected measure.`)
      else if (latestMetric.valueType === 'duration') {
        latestMetric.valueType = 'quantity'
        diffs.push({ path: `ruleVersions[${latestVersion.revision}].evaluation.metrics[${metricId}].valueType`, before: 'duration', after: 'quantity' })
      } else if (latestMetric.valueType !== 'quantity') {
        blockers.push(`Tracker ${tracker.id}: the latest rule evaluation has unexpected measure type ${latestMetric.valueType}.`)
      }
      latest = {
        revision: latestVersion.revision, application: latestVersion.application, effectiveFrom: latestVersion.effectiveFrom,
        metricType: latestMetric?.valueType ?? null,
        matchesCurrentAfterCorrection: latestMetric?.valueType === measure.valueType && trackerEvaluationSignature(latestVersion.evaluation) === trackerEvaluationSignature(copy),
      }
      if (latestVersion.revision !== 2 || latestVersion.application !== 'recalculate-all-history') blockers.push(`Tracker ${tracker.id}: latest rule version is not the expected revision 2 recalculate-all-history configuration.`)
      if (!latest.matchesCurrentAfterCorrection) blockers.push(`Tracker ${tracker.id}: latest rule-version evaluation does not match the corrected current definition.`)
    }
  }
  const milestoneSnapshots = copy.milestones.filter((milestone) => milestone.metricId === metricId)
    .map((milestone) => ({ id: milestone.id, title: milestone.title, measureTypeSnapshot: milestone.measureTypeSnapshot ?? null }))
  for (const milestone of milestoneSnapshots) {
    if (milestone.measureTypeSnapshot && milestone.measureTypeSnapshot !== 'quantity') {
      blockers.push(`Tracker ${tracker.id}: milestone “${milestone.title}” snapshots ${milestone.measureTypeSnapshot}; review its historical meaning before recovery.`)
    }
  }
  return { definition: copy, diffs, latest, historical, milestoneSnapshots }
}

function buildBackup(userId: string, local: LocalSnapshot): TrackerRecoveryBackup {
  const expectedTrackerIds = local.trackers.map((tracker) => tracker.id).sort()
  if (local.metadata.length !== 1 || expectedTrackerIds.length === 0) throw new Error('Recovery backup stopped: a required account or tracker record is missing.')
  const scopedTargets = TRACKER_RECOVERY_TARGETS.filter((target) => expectedTrackerIds.includes(target.trackerId))
  const requiredOperationIds = [...new Set([
    ...scopedTargets.flatMap((target) => target.operationIds.map((operation) => operation.id)),
    ...(scopedTargets.length ? [] : local.operations.filter((operation) => operation.entity === 'tracker' && expectedTrackerIds.includes(operation.entityId) && ['blocked', 'pending'].includes(operation.status)).map((operation) => operation.id)),
  ])].sort()
  if (requiredOperationIds.some((id) => !local.operations.some((operation) => operation.id === id))) {
    throw new Error('Recovery backup stopped: a blocked or pending tracker operation is missing.')
  }
  const backup: TrackerRecoveryBackup = {
    format: TRACKER_RECOVERY_BACKUP_FORMAT, version: TRACKER_RECOVERY_BACKUP_VERSION, exportedAt: new Date().toISOString(),
    workspace: { ownerUserId: userId }, scope: { trackerIds: expectedTrackerIds, requiredOperationIds },
    stores: { workspaceMetadata: local.metadata, trackers: local.trackers, trackerEntries: local.entries, syncOperations: local.operations, syncRecords: local.syncRecords, syncConflicts: local.conflicts, permanentDeletionRequests: local.permanentDeletionRequests, permanentDeletionLedger: local.permanentDeletionLedger, trackerVerification: local.verification },
    manifest: { trackerCount: local.trackers.length, entryCount: local.entries.length, operationCount: local.operations.length, syncRecordCount: local.syncRecords.length, conflictCount: local.conflicts.length, deletionRequestCount: local.permanentDeletionRequests.length, deletionLedgerCount: local.permanentDeletionLedger.length, verificationCount: local.verification.length },
  }
  return parseTrackerRecoveryBackup(JSON.parse(JSON.stringify(backup)), userId)
}

/** Validates completeness and referential integrity after JSON serialization, before a file is offered. */
export function parseTrackerRecoveryBackup(value: unknown, expectedOwnerUserId: string): TrackerRecoveryBackup {
  if (!value || typeof value !== 'object') throw new Error('Recovery backup is not a JSON object.')
  const backup = value as TrackerRecoveryBackup
  if (backup.format !== TRACKER_RECOVERY_BACKUP_FORMAT || backup.version !== TRACKER_RECOVERY_BACKUP_VERSION) throw new Error('Recovery backup format or version is unsupported.')
  if (backup.workspace?.ownerUserId !== expectedOwnerUserId) throw new Error('Recovery backup belongs to a different account.')
  const expectedTrackerIds = backup.scope?.trackerIds
  if (!Array.isArray(expectedTrackerIds) || expectedTrackerIds.length === 0 || expectedTrackerIds.some((id) => typeof id !== 'string' || !id) || new Set(expectedTrackerIds).size !== expectedTrackerIds.length) throw new Error('Recovery backup scope is incomplete.')
  const knownOperationIds = TRACKER_RECOVERY_TARGETS.filter((target) => expectedTrackerIds.includes(target.trackerId)).flatMap((target) => target.operationIds.map((operation) => operation.id))
  const requiredOperationIds = backup.scope.requiredOperationIds
  if (!Array.isArray(requiredOperationIds) || new Set(requiredOperationIds).size !== requiredOperationIds.length || knownOperationIds.some((id) => !requiredOperationIds.includes(id))) throw new Error('Recovery backup operation manifest is incomplete.')
  if (backup.stores?.workspaceMetadata?.length !== 1 || backup.stores.workspaceMetadata[0]?.userId !== expectedOwnerUserId) throw new Error('Recovery backup workspace metadata is missing or mismatched.')
  if (backup.stores.trackers?.length !== expectedTrackerIds.length || expectedTrackerIds.some((id) => !backup.stores.trackers.some((row) => row.id === id))) throw new Error('Recovery backup is missing an affected tracker.')
  if (requiredOperationIds.some((id) => !backup.stores.syncOperations?.some((row) => row.id === id && row.ownerUserId === expectedOwnerUserId && row.entity === 'tracker' && expectedTrackerIds.includes(row.entityId)))) throw new Error('Recovery backup is missing a required tracker operation.')
  if (!Array.isArray(backup.stores.trackerEntries) || !Array.isArray(backup.stores.syncOperations) || !Array.isArray(backup.stores.syncRecords) || !Array.isArray(backup.stores.syncConflicts) || !Array.isArray(backup.stores.permanentDeletionRequests) || !Array.isArray(backup.stores.permanentDeletionLedger) || !Array.isArray(backup.stores.trackerVerification)) throw new Error('Recovery backup is missing a required record collection.')
  for (const row of backup.stores.trackers) {
    const parsed = trackerDefinitionSchema.safeParse(row)
    if (!parsed.success || parsed.data.id !== row.id) throw new Error(`Recovery backup contains an invalid tracker definition (${row.id}).`)
  }
  const entryIds = new Set<string>()
  const trackerDates = new Set<string>()
  for (const entry of backup.stores.trackerEntries) {
    const parsed = trackerEntrySchema.safeParse(entry)
    const dateKey = `${entry.trackerId}:${entry.date}`
    if (!parsed.success || !expectedTrackerIds.includes(entry.trackerId) || entryIds.has(entry.id) || trackerDates.has(dateKey)) throw new Error('Recovery backup contains an invalid, duplicate, or unrelated tracker check-in.')
    entryIds.add(entry.id)
    trackerDates.add(dateKey)
  }
  for (const operation of backup.stores.syncOperations) {
    if (operation.ownerUserId !== expectedOwnerUserId) throw new Error('Recovery backup contains an operation from a different account.')
    if (operation.entity === 'tracker') {
      const parsed = trackerDefinitionSchema.safeParse(operation.payload)
      if (!expectedTrackerIds.includes(operation.entityId) || !parsed.success || parsed.data.id !== operation.entityId) throw new Error('Recovery backup contains an invalid tracker operation.')
      const target = TRACKER_RECOVERY_TARGETS.find((item) => item.trackerId === operation.entityId)
      const identity = target?.operationIds.find((item) => item.id === operation.id)
      if (identity && parsed.data.schemaVersion !== identity.schemaVersion) throw new Error(`Recovery backup original operation ${operation.id} has an unexpected schema payload.`)
    } else if (operation.entity === 'tracker_entry') {
      const parsed = trackerEntrySchema.safeParse(operation.payload)
      if (!parsed.success || parsed.data.id !== operation.entityId || !expectedTrackerIds.includes(parsed.data.trackerId)) throw new Error('Recovery backup contains an invalid tracker-entry operation.')
      entryIds.add(parsed.data.id)
    } else throw new Error('Recovery backup contains an unrelated operation type.')
  }
  const expectedOperationIds = [...new Set([
    ...knownOperationIds,
    ...(knownOperationIds.length ? [] : backup.stores.syncOperations.filter((operation) => operation.entity === 'tracker' && expectedTrackerIds.includes(operation.entityId) && ['blocked', 'pending'].includes(operation.status)).map((operation) => operation.id)),
  ])].sort()
  if ([...requiredOperationIds].sort().join('\n') !== expectedOperationIds.join('\n')) throw new Error('Recovery backup operation manifest does not cover every blocked or pending tracker write.')
  if (backup.stores.trackerEntries.some((entry) => !expectedTrackerIds.includes(entry.trackerId))) throw new Error('Recovery backup contains an unrelated tracker check-in.')
  if (backup.stores.syncOperations?.some((operation) => operation.ownerUserId !== expectedOwnerUserId)) throw new Error('Recovery backup contains an operation from a different account.')
  if (backup.stores.syncRecords.some((record) => record.ownerUserId !== expectedOwnerUserId || record.key !== `${record.entity}:${record.entityId}` || !(record.entity === 'tracker' && expectedTrackerIds.includes(record.entityId) || record.entity === 'tracker_entry' && entryIds.has(record.entityId)))) throw new Error('Recovery backup contains invalid or unrelated sync metadata.')
  for (const conflict of backup.stores.syncConflicts) {
    if (conflict.ownerUserId !== expectedOwnerUserId) throw new Error('Recovery backup contains a conflict from a different account.')
    if (conflict.entity === 'tracker') {
      const parsed = trackerDefinitionSchema.safeParse(conflict.localPayload)
      if (!expectedTrackerIds.includes(conflict.entityId) || !parsed.success || parsed.data.id !== conflict.entityId) throw new Error('Recovery backup contains an invalid tracker conflict.')
    } else if (conflict.entity === 'tracker_entry') {
      const parsed = trackerEntrySchema.safeParse(conflict.localPayload)
      if (!parsed.success || parsed.data.id !== conflict.entityId || !expectedTrackerIds.includes(parsed.data.trackerId)) throw new Error('Recovery backup contains an invalid tracker-entry conflict.')
    } else throw new Error('Recovery backup contains an unrelated conflict type.')
    if (conflict.remoteRecord?.user_id !== undefined && conflict.remoteRecord.user_id !== expectedOwnerUserId) throw new Error('Recovery backup contains a conflict snapshot from a different account.')
  }
  if (backup.stores.trackerVerification.some((row) => !expectedTrackerIds.includes(row.trackerId))) throw new Error('Recovery backup contains unrelated verification state.')
  if (backup.stores.permanentDeletionRequests.some((row) => row.ownerUserId !== expectedOwnerUserId || !expectedTrackerIds.includes(row.trackerId))) throw new Error('Recovery backup contains an invalid or unrelated permanent-deletion request.')
  if (backup.stores.permanentDeletionLedger.some((row) => row.ownerUserId !== expectedOwnerUserId || !expectedTrackerIds.includes(row.trackerId) || row.key !== `${expectedOwnerUserId}:${row.trackerId}`)) throw new Error('Recovery backup contains an invalid or unrelated permanent-deletion ledger record.')
  const { manifest } = backup
  if (!manifest || manifest.trackerCount !== backup.stores.trackers.length || manifest.entryCount !== backup.stores.trackerEntries.length || manifest.operationCount !== backup.stores.syncOperations.length || manifest.syncRecordCount !== backup.stores.syncRecords.length || manifest.conflictCount !== backup.stores.syncConflicts.length || manifest.deletionRequestCount !== backup.stores.permanentDeletionRequests.length || manifest.deletionLedgerCount !== backup.stores.permanentDeletionLedger.length || manifest.verificationCount !== backup.stores.trackerVerification.length) {
    throw new Error('Recovery backup manifest does not match the serialized records.')
  }
  return backup
}

function entrySyncStatus(entry: StoredTrackerEntry, records: SyncRecordState[], operations: SyncOperation[]): { syncStatus: string; acknowledgedRevision: number | null } {
  const revision = records.find((record) => record.entity === 'tracker_entry' && record.entityId === entry.id)?.serverRevision ?? null
  const rows = operations.filter((operation) => operation.entity === 'tracker_entry' && operation.entityId === entry.id)
  return { syncStatus: rows.at(-1)?.status ?? (revision === null ? 'unsynced' : 'acknowledged'), acknowledgedRevision: revision }
}

/** Reads exact local records and fresh cloud state. No IndexedDB writes, retries, or sync RPCs occur. */
export async function createTrackerRecoveryPreview(
  userId: string,
  options: { database?: ProgressTrackerDatabase; cloudReader?: TrackerRecoveryCloudReader; client?: SupabaseClient | null; trackerIds?: string[] } = {},
): Promise<TrackerRecoveryPreview> {
  const database = options.database ?? db
  const incidentIds: string[] = TRACKER_RECOVERY_TARGETS.map((target) => target.trackerId)
  const targetsToInspect = options.trackerIds ?? incidentIds
  if (!targetsToInspect.length || new Set(targetsToInspect).size !== targetsToInspect.length) throw new Error('Choose one or more distinct tracker IDs to inspect.')
  const genericRecovery = targetsToInspect.some((id) => !incidentIds.includes(id))
  if (genericRecovery && targetsToInspect.length !== 1) throw new Error('Inspect one generic blocked tracker at a time so its backup and operation set remain exact.')
  const local = await readLocalSnapshot(database, userId, targetsToInspect)
  if (genericRecovery && !local.operations.some((operation) => operation.entity === 'tracker' && operation.entityId === targetsToInspect[0] && operation.status === 'blocked')) throw new Error('This tracker has no blocked configuration write to revert.')
  const backup = buildBackup(userId, local)
  type RecoveryTarget = { trackerId: string; name: string; metricId: string | null; expectedCloudRevision?: number; expectedCloudSchemaVersion?: number; expectedLocalSchemaVersion?: number; operationIds: Array<{ id: string; schemaVersion: number; expectedRevision: number | null; obsolete: boolean }> }
  const targets: RecoveryTarget[] = targetsToInspect.map((trackerId) => {
    const known = TRACKER_RECOVERY_TARGETS.find((target) => target.trackerId === trackerId)
    if (known) return { ...known, operationIds: [...known.operationIds] }
    const tracker = local.trackers.find((row) => row.id === trackerId)
    if (!tracker) throw new Error(`Tracker ${trackerId} is not present in this local workspace.`)
    const operations = local.operations.filter((operation) => operation.entity === 'tracker' && operation.entityId === trackerId && ['blocked', 'pending'].includes(operation.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    return {
      trackerId, name: tracker.name, metricId: null,
      operationIds: operations.map((operation, index) => ({ id: operation.id, schemaVersion: (operation.payload as StoredTrackerDefinition).schemaVersion, expectedRevision: operation.expectedRevision, obsolete: index < operations.length - 1 })),
    }
  })
  const cloudReader = options.cloudReader ?? createTrackerRecoveryCloudReader(options.client)
  const [trackerRead, entryRead] = await Promise.allSettled([cloudReader.readTrackers(userId, targetsToInspect), cloudReader.readEntries(userId, targetsToInspect)])
  const cloudTrackers = trackerRead.status === 'fulfilled' ? trackerRead.value : []
  const cloudEntries = entryRead.status === 'fulfilled' ? entryRead.value : []
  const blockers: string[] = []
  if (trackerRead.status === 'rejected') blockers.push(`Fresh cloud tracker read failed: ${trackerRead.reason instanceof Error ? trackerRead.reason.message : 'unknown read error'}`)
  if (entryRead.status === 'rejected') blockers.push(`Fresh cloud check-in read failed: ${entryRead.reason instanceof Error ? entryRead.reason.message : 'unknown read error'}`)
  if (cloudTrackers.some((row) => row.user_id !== userId) || cloudEntries.some((row) => row.user_id !== userId)) {
    blockers.push('Cloud read returned a row outside the active account; those rows were withheld from the preview.')
  }
  const ownedCloudTrackers = cloudTrackers.filter((row) => row.user_id === userId)
  const ownedCloudEntries = cloudEntries.filter((row) => row.user_id === userId)
  const previewTrackers: TrackerRecoveryPreview['trackers'] = targets.map((target) => {
    const discardBlockers: string[] = []
    const discardDiffs: TrackerRecoveryPreview['trackers'][number]['discardDiffs'] = []
    const localTracker = local.trackers.find((tracker) => tracker.id === target.trackerId)
    const cloudTracker = ownedCloudTrackers.find((tracker) => tracker.id === target.trackerId)
    if (!localTracker) blockers.push(`${target.name}: local tracker record is missing.`)
    if (!cloudTracker) blockers.push(`${target.name}: fresh cloud tracker record is missing.`)
    const localDefinition = localTracker && trackerDefinitionSchema.safeParse(localTracker).success ? localTracker as TrackerDefinition : undefined
    const parsedCloudDefinition = cloudTracker ? trackerDefinitionSchema.safeParse(cloudTracker.definition) : null
    const cloudDefinition = parsedCloudDefinition?.success ? parsedCloudDefinition.data as TrackerDefinition : undefined
    const correction = localDefinition && target.metricId ? correctedDefinition(localDefinition, target.metricId, blockers) : { definition: undefined, diffs: [], latest: null, historical: localDefinition?.ruleVersions?.slice(0, -1).map((version) => ({ revision: version.revision, application: version.application, effectiveFrom: version.effectiveFrom, metricType: null })) ?? [], milestoneSnapshots: localDefinition?.milestones.map((milestone) => ({ id: milestone.id, title: milestone.title, measureTypeSnapshot: milestone.measureTypeSnapshot ?? null })) ?? [] }
    if (localTracker && !localDefinition) blockers.push(`${target.name}: local tracker definition does not validate in this build.`)
    if (cloudTracker && !cloudDefinition) blockers.push(`${target.name}: fresh cloud tracker definition does not validate in this build.`)
    if (localDefinition && cloudDefinition) {
      if (localDefinition.schemaVersion !== cloudDefinition.schemaVersion) discardBlockers.push('Local and cloud schema versions differ. No verified conversion preserves every setting and historical reference, so Revert to Cloud is disabled.')
      const localRecord = localDefinition as unknown as Record<string, unknown>
      const cloudRecord = cloudDefinition as unknown as Record<string, unknown>
      for (const key of [...new Set([...Object.keys(localRecord), ...Object.keys(cloudRecord)])].sort()) {
        if (stable(localRecord[key]) !== stable(cloudRecord[key])) discardDiffs.push({ path: key, before: localRecord[key], after: cloudRecord[key] })
      }
    }
    if (target.expectedLocalSchemaVersion && localTracker && localTracker.schemaVersion !== target.expectedLocalSchemaVersion) blockers.push(`${target.name}: local schema is ${localTracker.schemaVersion}, expected ${target.expectedLocalSchemaVersion}.`)
    if (target.expectedCloudRevision !== undefined && cloudTracker && cloudTracker.server_revision !== target.expectedCloudRevision) blockers.push(`${target.name}: cloud revision is ${cloudTracker.server_revision}, expected ${target.expectedCloudRevision}; do not recover against changed cloud state.`)
    if (target.expectedCloudSchemaVersion && cloudTracker && cloudTracker.schema_version !== target.expectedCloudSchemaVersion) blockers.push(`${target.name}: cloud schema is ${cloudTracker.schema_version}, expected ${target.expectedCloudSchemaVersion}.`)
    const localMetricType = target.metricId ? localDefinition?.metrics.find((metric) => metric.id === target.metricId)?.valueType ?? null : null
    const cloudMetricType = target.metricId ? cloudDefinition?.metrics.find((metric) => metric.id === target.metricId)?.valueType ?? null : null
    if (target.metricId && cloudMetricType !== 'quantity') blockers.push(`${target.name}: cloud measure type is ${cloudMetricType ?? 'unavailable'}, expected quantity.`)
    if (cloudTracker && (!cloudDefinition || cloudDefinition.id !== cloudTracker.id || cloudDefinition.schemaVersion !== cloudTracker.schema_version || cloudDefinition.kind !== cloudTracker.kind || cloudDefinition.status !== cloudTracker.status || cloudDefinition.name !== cloudTracker.name)) blockers.push(`${target.name}: cloud tracker columns do not match its definition payload.`)
    const acknowledgedTrackerRevision = local.syncRecords.find((row) => row.entity === 'tracker' && row.entityId === target.trackerId)?.serverRevision ?? null
    if (target.expectedCloudRevision !== undefined && acknowledgedTrackerRevision !== target.expectedCloudRevision) blockers.push(`${target.name}: local acknowledged revision is ${acknowledgedTrackerRevision ?? 'missing'}, expected ${target.expectedCloudRevision}.`)
    if (genericRecovery && cloudTracker && acknowledgedTrackerRevision !== cloudTracker.server_revision) discardBlockers.push(`The last acknowledged local cloud revision (${acknowledgedTrackerRevision ?? 'missing'}) differs from fresh cloud revision ${cloudTracker.server_revision}. Refresh or resolve the cloud conflict first.`)
    if (target.metricId && localMetricType !== 'duration' && localMetricType !== 'quantity') blockers.push(`${target.name}: local measure type is ${localMetricType ?? 'unavailable'}.`)

    const targetOps = local.operations.filter((operation) => target.operationIds.some((identity) => identity.id === operation.id) || operation.entity === 'tracker' && operation.entityId === target.trackerId)
    for (const expected of (TRACKER_RECOVERY_TARGETS.some((row) => row.trackerId === target.trackerId) ? target.operationIds : [])) {
      const operation = local.operations.find((item) => item.id === expected.id)
      if (!operation) blockers.push(`${target.name}: original operation ${expected.id} is missing.`)
      else if (operation.status !== 'blocked') blockers.push(`${target.name}: expected operation ${expected.id} is ${operation.status}, not blocked.`)
      else if (operation.entity !== 'tracker' || operation.entityId !== target.trackerId || (operation.payload as StoredTrackerDefinition | undefined)?.schemaVersion !== expected.schemaVersion) blockers.push(`${target.name}: original operation ${expected.id} does not match its expected tracker and schema.`)
      else if (operation.expectedRevision !== expected.expectedRevision) blockers.push(`${target.name}: operation ${expected.id} expects cloud revision ${operation.expectedRevision ?? 'unknown'}, expected ${expected.expectedRevision}.`)
    }
    if (targetOps.some((operation) => operation.entity === 'tracker' && ['in-flight', 'conflict'].includes(operation.status))) blockers.push(`${target.name}: a tracker write is in flight or conflicted.`)
    const currentOperation = targetOps.filter((operation) => operation.entity === 'tracker' && ['blocked', 'pending'].includes(operation.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).at(-1)
    if (!currentOperation) blockers.push(`${target.name}: no blocked or pending tracker configuration operation remains to revert.`)
    if (localTracker && currentOperation && stable(currentOperation.payload) !== stable(localTracker)) blockers.push(`${target.name}: current local tracker differs from the latest saved configuration operation.`)
    const localEntries = local.entries.filter((entry) => entry.trackerId === target.trackerId)
    const conflictEntryIds = new Set(local.conflicts.filter((conflict) => conflict.entity === 'tracker_entry' && (localEntries.some((entry) => entry.id === conflict.entityId) || (conflict.localPayload as StoredTrackerEntry | undefined)?.trackerId === target.trackerId)).map((conflict) => conflict.entityId))
    const relevantOps = local.operations.filter((operation) => targetOps.includes(operation) || operation.entity === 'tracker_entry' && (localEntries.some((entry) => entry.id === operation.entityId) || conflictEntryIds.has(operation.entityId) || (operation.payload as StoredTrackerEntry | undefined)?.trackerId === target.trackerId))
    const targetCloudEntries = ownedCloudEntries.filter((entry) => entry.tracker_id === target.trackerId)
    const entryConflicts: string[] = []
    for (const entry of localEntries) {
      const byId = targetCloudEntries.find((cloud) => cloud.id === entry.id)
      const byDate = targetCloudEntries.find((cloud) => cloud.entry_date === entry.date && cloud.id !== entry.id)
      const entryWrites = relevantOps.filter((row) => row.entity === 'tracker_entry' && row.entityId === entry.id && ['pending', 'blocked'].includes(row.status))
      if (byDate) entryConflicts.push(`${entry.date}: local entry ${entry.id} and cloud entry ${byDate.id} occupy the same tracker date.`)
      else if (byId && !sameEntry(entry, byId) && (!genericRecovery || !entryWrites.length)) entryConflicts.push(`${entry.date}: local entry ${entry.id} differs from cloud copy revision ${byId.server_revision}.`)
      const state = entrySyncStatus(entry, local.syncRecords, local.operations)
      if (!byId && state.acknowledgedRevision !== null) entryConflicts.push(`${entry.date}: locally acknowledged entry ${entry.id} is absent from the current cloud read.`)
      if (byId && state.acknowledgedRevision !== null && state.acknowledgedRevision !== byId.server_revision && (!genericRecovery || !entryWrites.length)) entryConflicts.push(`${entry.date}: local check-in revision ${state.acknowledgedRevision} differs from cloud revision ${byId.server_revision}.`)
      for (const operation of relevantOps.filter((row) => row.entity === 'tracker_entry' && row.entityId === entry.id && row.status !== 'superseded')) {
        if (byId && operation.expectedRevision !== byId.server_revision && (!genericRecovery || ['pending', 'blocked'].includes(operation.status))) entryConflicts.push(`${entry.date}: operation ${operation.id} expects check-in revision ${operation.expectedRevision ?? 'new row'}, cloud is revision ${byId.server_revision}.`)
        if (!byId && operation.expectedRevision !== null) entryConflicts.push(`${entry.date}: operation ${operation.id} expects existing check-in revision ${operation.expectedRevision}, but its cloud row is absent.`)
      }
    }
    for (const operation of relevantOps.filter((row) => row.entity === 'tracker_entry' && row.status !== 'superseded')) {
      const payloadTrackerId = (operation.payload as StoredTrackerEntry | undefined)?.trackerId
      if (payloadTrackerId === target.trackerId && !localEntries.some((entry) => entry.id === operation.entityId)) {
        entryConflicts.push(`Operation ${operation.id} references a missing local check-in ${operation.entityId}.`)
      }
    }
    for (const conflict of entryConflicts) blockers.push(`${target.name}: ${conflict}`)
    const localConflicts = local.conflicts.filter((conflict) => conflict.entity === 'tracker' && conflict.entityId === target.trackerId || conflict.entity === 'tracker_entry' && (localEntries.some((entry) => entry.id === conflict.entityId) || (conflict.localPayload as StoredTrackerEntry | undefined)?.trackerId === target.trackerId))
    for (const conflict of localConflicts) blockers.push(`${target.name}: unresolved local ${conflict.entity} conflict ${conflict.id}.`)
    if (localConflicts.length) discardBlockers.push('Unresolved tracker or check-in conflicts exist.')
    if (local.permanentDeletionRequests.some((request) => request.trackerId === target.trackerId) || local.permanentDeletionLedger.some((record) => record.trackerId === target.trackerId)) discardBlockers.push('A permanent deletion request or ledger record exists.')
    if (local.operations.some((operation) => operation.entity === 'tracker' && operation.entityId === target.trackerId && (['in-flight', 'conflict'].includes(operation.status) || !genericRecovery && operation.status === 'pending'))) discardBlockers.push('A tracker operation is pending, in flight, or conflicted.')
    if (relevantOps.some((operation) => operation.entity === 'tracker_entry' && ['in-flight', 'conflict'].includes(operation.status))) discardBlockers.push('A dependent check-in operation is in flight or conflicted; resolve it before reverting the tracker.')
    if (entryConflicts.length) discardBlockers.push('One or more local check-ins differ from cloud or have a revision conflict.')
    const unsafeEntryState = localEntries.some((entry) => {
      const cloudEntry = targetCloudEntries.find((row) => row.id === entry.id)
      const state = entrySyncStatus(entry, local.syncRecords, local.operations)
      const hasPendingWrite = relevantOps.some((operation) => operation.entity === 'tracker_entry' && operation.entityId === entry.id && ['pending', 'blocked'].includes(operation.status))
      if (!genericRecovery) return !cloudEntry || !sameEntry(entry, cloudEntry) || state.acknowledgedRevision !== cloudEntry.server_revision
      if (!cloudEntry) return state.acknowledgedRevision !== null
      return (!sameEntry(entry, cloudEntry) || state.acknowledgedRevision !== null && state.acknowledgedRevision !== cloudEntry.server_revision) && !hasPendingWrite
    })
    if (unsafeEntryState) discardBlockers.push('A saved check-in is missing from cloud or is not confirmed at the current revision.')
    if (genericRecovery && cloudDefinition) {
      for (const entry of localEntries) {
        const valueError = validateTrackerEntryValues(cloudDefinition, entry.values, { enforcePrecision: false, existingValues: entry.values })
        if (valueError) discardBlockers.push(`Check-in ${entry.id} cannot be preserved under the cloud definition: ${valueError}`)
      }
      const localMetrics = new Map((localDefinition?.metrics ?? []).map((metric) => [metric.id, metric]))
      for (const metric of cloudDefinition.metrics) {
        const localMetric = localMetrics.get(metric.id)
        if (localMetric && localMetric.valueType !== metric.valueType) discardBlockers.push(`Measure ${metric.id} changes type from ${localMetric.valueType} to ${metric.valueType}; this recovery path cannot prove its historical meaning is preserved.`)
      }
    }
    const permanentDeletionRequests = local.permanentDeletionRequests.filter((request) => request.trackerId === target.trackerId)
    const permanentDeletionLedger = local.permanentDeletionLedger.filter((record) => record.trackerId === target.trackerId)
    for (const request of permanentDeletionRequests) blockers.push(`${target.name}: a permanent-deletion request is ${request.status}; do not recover until it is reviewed.`)
    if (permanentDeletionLedger.length) blockers.push(`${target.name}: a permanent-deletion ledger record exists; do not recover until it is reviewed.`)
    if (correction.latest?.matchesCurrentAfterCorrection === false) blockers.push(`${target.name}: latest rule evaluation remains inconsistent after the proposed type correction.`)
    return {
      trackerId: target.trackerId, name: target.name, localSchemaVersion: localTracker?.schemaVersion ?? null,
      localAcknowledgedRevision: acknowledgedTrackerRevision,
      cloudSchemaVersion: cloudTracker?.schema_version ?? null, cloudRevision: cloudTracker?.server_revision ?? null,
      cloudMetricType, localMetricType, proposedMetricType: correction.diffs.length || localMetricType === 'duration' ? 'quantity' : null,
      metricSummary: [...new Set([...(localDefinition?.metrics ?? []).map((metric) => metric.id), ...(cloudDefinition?.metrics ?? []).map((metric) => metric.id)])].map((id) => ({ id, name: localDefinition?.metrics.find((metric) => metric.id === id)?.name ?? cloudDefinition?.metrics.find((metric) => metric.id === id)?.name ?? id, localType: localDefinition?.metrics.find((metric) => metric.id === id)?.valueType ?? null, cloudType: cloudDefinition?.metrics.find((metric) => metric.id === id)?.valueType ?? null })),
      latestRuleVersion: correction.latest, historicalRuleVersions: correction.historical, milestoneSnapshots: correction.milestoneSnapshots,
      diffs: correction.diffs, proposedDefinition: correction.definition ?? null,
      discardDiffs, discardBlockers,
      localConflicts: localConflicts.map((conflict) => ({ id: conflict.id, entity: conflict.entity, entityId: conflict.entityId, detectedAt: conflict.detectedAt, reason: conflict.reason ?? null })),
      permanentDeletionRequests: permanentDeletionRequests.map(({ id, status, requestedAt, lastError, winsRetention }) => ({ id, status, requestedAt, lastError, ...(winsRetention ? { winsRetention } : {}) })),
      permanentDeletionLedger: permanentDeletionLedger.map((record) => ({ permanentlyDeletedAt: record.permanentlyDeletedAt })),
      localEntries: localEntries.map((entry) => ({ id: entry.id, date: entry.date, outcome: entry.outcome, values: entry.values, note: entry.note, createdAt: entry.createdAt, updatedAt: entry.updatedAt, deletedAt: entry.deletedAt, ...entrySyncStatus(entry, local.syncRecords, local.operations) })),
      cloudEntries: targetCloudEntries.map((entry) => ({ id: entry.id, date: entry.entry_date, outcome: entry.outcome, values: entry.entry_values, note: entry.note, createdAt: entry.created_at, updatedAt: entry.updated_at, deletedAt: entry.deleted_at, serverRevision: entry.server_revision })),
      entryConflicts,
      operations: relevantOps.map((operation) => ({
        id: operation.id, entity: operation.entity, entityId: operation.entityId, status: operation.status,
        expectedRevision: operation.expectedRevision, schemaVersion: operation.entity === 'tracker' ? ((operation.payload as StoredTrackerDefinition | undefined)?.schemaVersion ?? null) : null,
        obsolete: target.operationIds.find((identity) => identity.id === operation.id)?.obsolete ?? false,
        payload: operation.payload,
        failureCode: operation.failureDiagnostic?.code ?? operation.failureCode ?? null,
        databaseTable: operation.failureDiagnostic?.table ?? null,
        databaseConstraint: operation.failureDiagnostic?.constraint ?? null,
        serverError: operation.failureDiagnostic?.message ?? null,
        lastError: operation.lastError,
      })),
    }
  })
  const requiredOps = targets.flatMap((target) => target.operationIds.map((operation) => operation.id))
  if (requiredOps.some((id) => !local.operations.some((operation) => operation.id === id))) blockers.push('One or more blocked or pending tracker operations changed while previewing; inspect again before recovery.')
  const status = blockers.length ? (previewTrackers.some((tracker) => tracker.localSchemaVersion === null || tracker.cloudSchemaVersion === null) ? 'incomplete' : 'conflict') : 'ready-for-review'
  return {
    generatedAt: new Date().toISOString(), ownerUserId: userId, cloudReadOnly: true, genericScope: genericRecovery,
    readyForReview: status === 'ready-for-review', safeToExecute: false, status, blockers,
    trackers: previewTrackers, unrelatedPendingOperationsExcluded: true,
    progressionState: { localMaterializedRecords: false, note: 'This build stores tracker check-ins and rule/milestone snapshots locally; XP, streak, and achievement values are derived. Their before/after cloud state must be verified in the separately approved recovery phase.' },
    backup,
  }
}

function snapshotMatchesBackup(snapshot: LocalSnapshot, backup: TrackerRecoveryBackup): boolean {
  const rowsEqual = <T extends Record<string, unknown>>(left: T[], right: T[], key: keyof T) => stable(JSON.parse(JSON.stringify([...left].sort((a, b) => String(a[key]).localeCompare(String(b[key])))))) === stable(JSON.parse(JSON.stringify([...right].sort((a, b) => String(a[key]).localeCompare(String(b[key]))))))
  return rowsEqual(snapshot.metadata, backup.stores.workspaceMetadata, 'key')
    && rowsEqual(snapshot.trackers, backup.stores.trackers, 'id')
    && rowsEqual(snapshot.entries, backup.stores.trackerEntries, 'id')
    && rowsEqual(snapshot.operations, backup.stores.syncOperations, 'id')
    && rowsEqual(snapshot.syncRecords, backup.stores.syncRecords, 'key')
    && rowsEqual(snapshot.conflicts, backup.stores.syncConflicts, 'id')
    && rowsEqual(snapshot.permanentDeletionRequests, backup.stores.permanentDeletionRequests, 'id')
    && rowsEqual(snapshot.permanentDeletionLedger, backup.stores.permanentDeletionLedger, 'key')
    && rowsEqual(snapshot.verification, backup.stores.trackerVerification, 'trackerId')
}

function findRecoveryTarget(trackerId: string) { return TRACKER_RECOVERY_TARGETS.find((candidate) => candidate.trackerId === trackerId) }

export function canQueueConfirmedMeasureRepair(preview: TrackerRecoveryPreview, trackerId: string): boolean {
  const target = TRACKER_RECOVERY_TARGETS.find((candidate) => candidate.trackerId === trackerId)
  const tracker = preview.trackers.find((candidate) => candidate.trackerId === trackerId)
  if (!target || !tracker || !tracker.proposedDefinition || tracker.localSchemaVersion !== target.expectedLocalSchemaVersion || tracker.cloudSchemaVersion !== target.expectedCloudSchemaVersion || tracker.cloudRevision !== target.expectedCloudRevision || tracker.localAcknowledgedRevision !== target.expectedCloudRevision || tracker.cloudMetricType !== 'quantity' || !['duration', 'quantity'].includes(tracker.localMetricType ?? '') || tracker.entryConflicts.length || tracker.localConflicts.length || tracker.permanentDeletionRequests.length || tracker.permanentDeletionLedger.length) return false
  if (tracker.latestRuleVersion?.matchesCurrentAfterCorrection === false) return false
  const knownOperationIds = new Set<string>(target.operationIds.map((identity) => identity.id))
  if (tracker.operations.some((operation) => operation.entity === 'tracker' && !knownOperationIds.has(operation.id) && ['pending', 'in-flight', 'conflict'].includes(operation.status))) return false
  return target.operationIds.every((identity) => tracker.operations.some((operation) => operation.id === identity.id && operation.status === 'blocked' && operation.schemaVersion === identity.schemaVersion && operation.expectedRevision === identity.expectedRevision))
}

/** Queues only the proven quantity-type correction. It does not call Supabase or retry an old operation. */
export async function queueConfirmedMeasureRepair(
  preview: TrackerRecoveryPreview,
  trackerId: string,
  backupConfirmedSaved: boolean,
  options: { database?: ProgressTrackerDatabase; cloudReader?: TrackerRecoveryCloudReader } = {},
): Promise<void> {
  if (!backupConfirmedSaved) throw new Error('Save and verify the scoped recovery backup before repairing this tracker.')
  const target = findRecoveryTarget(trackerId)
  if (!target) throw new Error('The guarded measure repair applies only to the verified incident trackers.')
  if (!canQueueConfirmedMeasureRepair(preview, trackerId)) throw new Error('The selected tracker has blockers; no repair was queued.')
  const reviewed = preview.trackers.find((tracker) => tracker.trackerId === trackerId)
  if (!reviewed?.proposedDefinition || reviewed.cloudRevision !== target.expectedCloudRevision || reviewed.cloudSchemaVersion !== target.expectedCloudSchemaVersion) throw new Error('The reviewed tracker is missing or its expected cloud revision changed.')
  const backup = parseTrackerRecoveryBackup(preview.backup, preview.ownerUserId)
  const database = options.database ?? await openDatabase()
  const currentLocal = await readLocalSnapshot(database, preview.ownerUserId)
  if (!snapshotMatchesBackup(currentLocal, backup)) throw new Error('Local tracker data changed after the backup. Inspect again and create a new backup.')
  const reader = options.cloudReader ?? createTrackerRecoveryCloudReader()
  const cloudRows = await reader.readTrackers(preview.ownerUserId, [trackerId])
  const cloud = cloudRows.find((row) => row.id === trackerId && row.user_id === preview.ownerUserId)
  if (!cloud || cloud.server_revision !== reviewed.cloudRevision || cloud.schema_version !== reviewed.cloudSchemaVersion) throw new Error('Cloud tracker revision changed after inspection. No repair was queued.')
  const cloudDefinition = trackerDefinitionSchema.safeParse(cloud.definition)
  if (!cloudDefinition.success || cloudDefinition.data.schemaVersion !== cloud.schema_version) throw new Error('The fresh cloud definition is invalid or inconsistent; no repair was queued.')
  if ((cloudDefinition.data as TrackerDefinition).metrics.find((metric) => metric.id === target.metricId)?.valueType !== 'quantity') throw new Error('The fresh cloud measure type no longer matches the reviewed quantity type.')
  const localCurrent = currentLocal.trackers.find((tracker) => tracker.id === trackerId)
  if (!localCurrent || stable(localCurrent) !== stable(reviewed.operations.find((operation) => operation.id === target.operationIds.find((row) => !row.obsolete)?.id)?.payload)) throw new Error('The intended latest local operation no longer matches the reviewed tracker.')
  const corrected = trackerDefinitionSchema.safeParse(reviewed.proposedDefinition)
  if (!corrected.success || corrected.data.metrics.find((metric) => metric.id === target.metricId)?.valueType !== 'quantity') throw new Error('The proposed measure correction failed validation.')
  await database.transaction('rw', [database.workspaceMetadata, database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts, database.permanentDeletionRequests, database.permanentDeletionLedger, database.trackerVerification], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== preview.ownerUserId) throw new Error('The open local workspace belongs to a different account.')
    const latest = await readLocalSnapshot(database, preview.ownerUserId)
    if (!snapshotMatchesBackup(latest, backup)) throw new Error('Local tracker data changed during confirmation. No repair was queued.')
    const latestCloudState = await database.syncRecords.get(`tracker:${trackerId}`)
    if (latestCloudState?.serverRevision !== cloud.server_revision) throw new Error('The locally acknowledged cloud revision changed during confirmation.')
    const trackerOperation = target.operationIds.filter((identity) => !identity.obsolete).map((identity) => latest.operations.find((operation) => operation.id === identity.id)).find(Boolean)
    if (!trackerOperation || trackerOperation.status !== 'blocked') throw new Error('The current rejected operation changed status; no repair was queued.')
    if (latest.operations.some((operation) => operation.entity === 'tracker' && operation.entityId === trackerId && operation.status === 'pending')) throw new Error('A tracker write is already pending; no repair was queued.')
    if (latest.conflicts.some((conflict) => conflict.entity === 'tracker' && conflict.entityId === trackerId)) throw new Error('Resolve the tracker conflict before repair.')
    const record: StoredTrackerDefinition = { ...(corrected.data as TrackerDefinition), updatedAt: new Date().toISOString() }
    await database.trackers.put(record)
    await queueSyncMutation(database, preview.ownerUserId, 'tracker', record)
  })
  publishWorkspaceMutation(preview.ownerUserId)
}

/** Restores a same-schema cloud definition and audits rejected payloads as discarded; entries are never touched. */
export async function discardRejectedTrackerChanges(
  preview: TrackerRecoveryPreview,
  trackerId: string,
  backupConfirmedSaved: boolean,
  options: { database?: ProgressTrackerDatabase; cloudReader?: TrackerRecoveryCloudReader } = {},
): Promise<void> {
  if (!backupConfirmedSaved) throw new Error('Save and verify the scoped recovery backup before discarding rejected changes.')
  const target = findRecoveryTarget(trackerId)
  const reviewed = preview.trackers.find((tracker) => tracker.trackerId === trackerId)
  if (!reviewed || reviewed.cloudRevision === null || reviewed.cloudSchemaVersion === null) throw new Error('A fresh cloud tracker row is required before discard.')
  if (!preview.backup.scope.trackerIds.includes(trackerId)) throw new Error('The reviewed backup does not include this tracker; inspect it again before reverting.')
  if (reviewed.localSchemaVersion !== reviewed.cloudSchemaVersion) throw new Error('The local and cloud schemas differ. No verified conversion preserves every historical field and reference, so Revert to Cloud is disabled.')
  const reviewedTracker = preview.trackers.find((row) => row.trackerId === trackerId)!
  const reviewedCandidates = reviewedTracker.operations.filter((operation) => operation.entity === 'tracker' && (operation.status === 'blocked' || preview.genericScope && operation.status === 'pending'))
  if (!reviewedCandidates.length) throw new Error('There are no rejected tracker changes to discard.')
  if (reviewed.discardBlockers.length || preview.blockers.some((blocker) => blocker.startsWith(`${reviewed.name}:`))) throw new Error(`Revert is blocked: ${reviewed.discardBlockers.join(' ') || preview.blockers.filter((blocker) => blocker.startsWith(`${reviewed.name}:`)).join(' ')}`)
  const backup = parseTrackerRecoveryBackup(preview.backup, preview.ownerUserId)
  const database = options.database ?? await openDatabase()
  const initial = await readLocalSnapshot(database, preview.ownerUserId, backup.scope.trackerIds)
  if (!snapshotMatchesBackup(initial, backup)) throw new Error('Local tracker data changed after the backup. Inspect again and create a new backup.')
  const reader = options.cloudReader ?? createTrackerRecoveryCloudReader()
  const [trackerRows, cloudEntries] = await Promise.all([reader.readTrackers(preview.ownerUserId, [trackerId]), reader.readEntries(preview.ownerUserId, [trackerId])])
  const cloud = trackerRows.find((row) => row.id === trackerId && row.user_id === preview.ownerUserId)
  if (!cloud || cloud.server_revision !== reviewed.cloudRevision || cloud.server_revision !== reviewed.localAcknowledgedRevision || cloud.schema_version !== reviewed.cloudSchemaVersion) throw new Error('Cloud or acknowledged revision changed after inspection. No changes were discarded.')
  const parsedCloud = trackerDefinitionSchema.safeParse(cloud.definition)
  if (!parsedCloud.success || parsedCloud.data.schemaVersion !== cloud.schema_version || parsedCloud.data.id !== trackerId) throw new Error('Fresh cloud tracker definition is invalid or inconsistent.')
  if (target && (parsedCloud.data as TrackerDefinition).metrics.find((metric) => metric.id === target.metricId)?.valueType !== 'quantity') throw new Error('The confirmed cloud measure type differs from the safe recovery target.')
  if (!preview.genericScope && !target) throw new Error('The incident recovery preview does not include this tracker.')
  if (initial.permanentDeletionRequests.some((request) => request.trackerId === trackerId) || initial.permanentDeletionLedger.some((row) => row.trackerId === trackerId)) throw new Error('A deletion request or permanent-deletion record blocks safe discard.')
  if (initial.conflicts.some((conflict) => conflict.entity === 'tracker' && conflict.entityId === trackerId || conflict.entity === 'tracker_entry' && (initial.entries.some((entry) => entry.id === conflict.entityId && entry.trackerId === trackerId) || (conflict.localPayload as StoredTrackerEntry | undefined)?.trackerId === trackerId))) throw new Error('An unresolved tracker or check-in conflict blocks safe discard.')
  const discardableOperations = initial.operations.filter((operation) => operation.entity === 'tracker' && operation.entityId === trackerId && (operation.status === 'blocked' || preview.genericScope && operation.status === 'pending'))
  if (!discardableOperations.length) throw new Error('There are no blocked or pending tracker changes to discard.')
  if (initial.operations.some((operation) => operation.entity === 'tracker' && operation.entityId === trackerId && ['in-flight', 'conflict'].includes(operation.status))) throw new Error('An in-flight or conflicted tracker write blocks safe discard.')
  if (!preview.genericScope && initial.operations.some((operation) => operation.entity === 'tracker' && operation.entityId === trackerId && operation.status === 'pending')) throw new Error('A pending tracker write blocks incident recovery; sync or inspect it first.')
  const trackerEntries = initial.entries.filter((entry) => entry.trackerId === trackerId)
  if (preview.genericScope) {
    const localDefinition = trackerDefinitionSchema.safeParse(initial.trackers.find((row) => row.id === trackerId))
    if (!localDefinition.success) throw new Error('The latest local tracker definition is invalid; no data was changed.')
    for (const cloudMetric of parsedCloud.data.metrics) {
      const localMetric = localDefinition.data.metrics.find((metric) => metric.id === cloudMetric.id)
      if (localMetric && localMetric.valueType !== cloudMetric.valueType) throw new Error(`Measure ${cloudMetric.id} changes type from ${localMetric.valueType} to ${cloudMetric.valueType}; its historical meaning cannot be proven safe.`)
    }
  }
  const ownedCloudEntries = cloudEntries.filter((entry) => entry.user_id === preview.ownerUserId && entry.tracker_id === trackerId)
  for (const entry of trackerEntries) {
    const cloudEntry = ownedCloudEntries.find((row) => row.id === entry.id)
    const acknowledged = initial.syncRecords.find((row) => row.entity === 'tracker_entry' && row.entityId === entry.id)
    const entryOperations = initial.operations.filter((operation) => operation.entity === 'tracker_entry' && operation.entityId === entry.id)
    if (preview.genericScope) {
      const valueError = validateTrackerEntryValues(parsedCloud.data, entry.values, { enforcePrecision: false, existingValues: entry.values })
      if (valueError) throw new Error(`Check-in ${entry.id} cannot be preserved under the cloud definition: ${valueError}`)
      const activeEntryWrites = entryOperations.filter((operation) => ['pending', 'blocked'].includes(operation.status))
      if (entryOperations.some((operation) => ['in-flight', 'conflict'].includes(operation.status))) throw new Error(`Check-in ${entry.id} has an in-flight or conflicted write; resolve it before reverting.`)
      if (cloudEntry && activeEntryWrites.some((operation) => operation.expectedRevision !== cloudEntry.server_revision)) throw new Error(`Check-in ${entry.id} has a queued operation for a stale cloud revision.`)
      if (!cloudEntry && acknowledged) throw new Error(`Previously synchronized check-in ${entry.id} is missing from the current cloud state.`)
      if (cloudEntry && !activeEntryWrites.length && (!acknowledged || acknowledged.serverRevision !== cloudEntry.server_revision || !sameEntry(entry, cloudEntry))) throw new Error(`Check-in ${entry.id} is not confirmed identical in cloud; safe revert is disabled.`)
    } else {
      if (!cloudEntry || !acknowledged || acknowledged.serverRevision !== cloudEntry.server_revision || !sameEntry(entry, cloudEntry)) throw new Error(`Check-in ${entry.id} is not confirmed identical in cloud; safe discard is disabled.`)
      if (entryOperations.some((operation) => operation.status === 'pending' || operation.status === 'in-flight' || operation.status === 'conflict' || operation.status === 'blocked')) throw new Error(`Unsynced check-in ${entry.id} blocks safe discard.`)
    }
  }
  if (initial.operations.some((operation) => operation.entity === 'tracker_entry' && (operation.payload as StoredTrackerEntry | undefined)?.trackerId === trackerId && !trackerEntries.some((entry) => entry.id === operation.entityId) && ['pending', 'in-flight', 'conflict', 'blocked'].includes(operation.status))) throw new Error('A dependent check-in operation without a local row blocks safe discard.')
  if (!preview.genericScope && target && discardableOperations.some((operation) => operation.id === target.operationIds.find((identity) => identity.obsolete)?.id) && trackerId === TRACKER_RECOVERY_TARGETS[0].trackerId) {
    // Retain obsolete MERN rejections as audit records, but never make them retryable.
  }
  await database.transaction('rw', [database.workspaceMetadata, database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts, database.permanentDeletionRequests, database.permanentDeletionLedger, database.trackerVerification], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== preview.ownerUserId) throw new Error('The open local workspace belongs to a different account.')
    const latest = await readLocalSnapshot(database, preview.ownerUserId, backup.scope.trackerIds)
    if (!snapshotMatchesBackup(latest, backup)) throw new Error('Local tracker data changed during confirmation. No changes were discarded.')
    const state = await database.syncRecords.get(`tracker:${trackerId}`)
    if (state?.serverRevision !== cloud.server_revision) throw new Error('The locally acknowledged revision changed during confirmation.')
    const current = await database.trackers.get(trackerId)
    if (!current) throw new Error('Local tracker disappeared; no changes were discarded.')
    await database.trackers.put(parsedCloud.data as StoredTrackerDefinition)
    const discardedAt = new Date().toISOString()
    for (const operation of discardableOperations) await database.syncOperations.put({ ...operation, status: 'discarded', discardedAt, lastError: operation.lastError ?? 'Discarded by the user while restoring the confirmed cloud tracker.' })
  })
  publishWorkspaceMutation(preview.ownerUserId)
}

export function downloadTrackerRecoveryBackup(backupInput: TrackerRecoveryBackup): void {
  const backup = parseTrackerRecoveryBackup(backupInput, backupInput.workspace.ownerUserId)
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `progress-tracker-blocked-recovery-v${TRACKER_RECOVERY_BACKUP_VERSION}.json`
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function createTrackerRecoveryBackupFile(backupInput: TrackerRecoveryBackup): File {
  const backup = parseTrackerRecoveryBackup(backupInput, backupInput.workspace.ownerUserId)
  return new File([JSON.stringify(backup, null, 2)], `progress-tracker-blocked-recovery-v${TRACKER_RECOVERY_BACKUP_VERSION}.json`, { type: 'application/json' })
}
