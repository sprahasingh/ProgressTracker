import { z } from 'zod'
import { openDatabase } from './database'
import { trackerDefinitionSchema, trackerEntrySchema } from '../domain/trackers/schema'
import { isSchemaV3WriteEnabled } from '../domain/trackers/schemaVersionGate'
import { publishWorkspaceMutation } from './workspaceMutationEvents'

export const WORKSPACE_BACKUP_FORMAT = 'ProgressTracker local workspace backup'
export const WORKSPACE_BACKUP_VERSION = 2

const backupStores = [
  'categories', 'dailyEntries', 'dailyJournals', 'goals', 'goalMetrics', 'goalProgressLogs',
  'settings', 'trackers', 'trackerEntries', 'workspaceMetadata', 'syncOperations', 'syncRecords', 'syncConflicts',
  'permanentDeletionRequests', 'permanentDeletionLedger', 'trackerVerification',
] as const

export type WorkspaceBackup = {
  format: typeof WORKSPACE_BACKUP_FORMAT
  version: typeof WORKSPACE_BACKUP_VERSION
  exportedAt: string
  workspace: { kind: 'guest' | 'account'; ownerUserId: string | null }
  stores: Record<(typeof backupStores)[number], unknown[]>
}

export type WorkspaceRestorePreview = {
  backup: WorkspaceBackup
  added: Record<string, number>
  alreadyPresent: Record<string, number>
  conflicts: string[]
}

const timestamp = z.iso.datetime()
const rowId = z.string().min(1)
const nullableTimestamp = timestamp.nullable()
const categorySchedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every-day') }), z.object({ kind: z.literal('weekdays') }),
  z.object({ kind: z.literal('selected-weekdays'), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }),
  z.object({ kind: z.literal('times-per-week'), count: z.number().int().min(1).max(7), preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional() }),
])
const categoryRow = z.object({ id: rowId, name: z.string().min(1), icon: z.string(), description: z.string().optional(), accent: z.string(), schedule: categorySchedule, position: z.number().int(), createdAt: timestamp, updatedAt: timestamp, archivedAt: nullableTimestamp, deletedAt: nullableTimestamp })
const dailyEntryRow = z.object({ id: rowId, categoryId: rowId, date: z.iso.date(), status: z.enum(['completed', 'skipped']), note: z.string(), createdAt: timestamp, updatedAt: timestamp, deletedAt: nullableTimestamp })
const dailyJournalRow = z.object({ id: rowId, date: z.iso.date(), body: z.string(), createdAt: timestamp, updatedAt: timestamp, deletedAt: nullableTimestamp })
const goalRow = z.object({ id: rowId, title: z.string().min(1), description: z.string(), categoryId: rowId.nullable(), startDate: z.iso.date(), targetDate: z.iso.date(), status: z.enum(['active', 'paused', 'completed', 'archived']), completedAt: nullableTimestamp, createdAt: timestamp, updatedAt: timestamp, deletedAt: nullableTimestamp }).refine((goal) => goal.targetDate >= goal.startDate, 'Goal target must not precede its start date.')
const goalMetricRow = z.object({ id: rowId, goalId: rowId, name: z.string().min(1), unit: z.string(), target: z.number().finite().positive(), weight: z.number().finite().nonnegative().nullable(), position: z.number().int(), createdAt: timestamp, updatedAt: timestamp, deletedAt: nullableTimestamp })
const goalProgressRow = z.object({ id: rowId, metricId: rowId, date: z.iso.date(), value: z.number().finite().nonnegative(), recordedAt: timestamp, updatedAt: timestamp, deletedAt: nullableTimestamp, note: z.string().optional() })
const settingsRow = z.object({ id: z.literal('general'), timezone: z.string(), appearance: z.enum(['light', 'dark', 'system']), backupReminderDays: z.number().int().positive().nullable(), updatedAt: timestamp })
const operationRow = z.object({ id: rowId, ownerUserId: rowId.nullable().optional(), entity: z.enum(['category', 'daily-entry', 'daily-journal', 'goal', 'goal-metric', 'goal-progress', 'settings', 'tracker', 'tracker_entry']), entityId: rowId, operation: z.literal('upsert'), expectedRevision: z.number().int().positive().nullable().optional(), payload: z.unknown().optional(), createdAt: timestamp.optional(), updatedAt: timestamp.optional(), attempts: z.number().int().nonnegative().optional(), status: z.enum(['pending', 'conflict']).optional(), lastError: z.string().nullable().optional() })
const syncRecordRow = z.object({ key: rowId, ownerUserId: rowId, entity: z.enum(['tracker', 'tracker_entry']), entityId: rowId, serverRevision: z.number().int().positive() })
const syncConflictRow = z.object({ id: rowId, ownerUserId: rowId, entity: z.enum(['tracker', 'tracker_entry']), entityId: rowId, localPayload: z.unknown(), remoteRecord: z.record(z.string(), z.json()).nullable(), detectedAt: timestamp })
const deletionRequestRow = z.object({ id: rowId, ownerUserId: rowId, trackerId: rowId, requestedAt: timestamp, status: z.enum(['pending', 'conflict', 'failed']), lastError: z.string().nullable() })
const deletionLedgerRow = z.object({ key: rowId, ownerUserId: rowId, trackerId: rowId, permanentlyDeletedAt: timestamp })
const trackerVerificationRow = z.object({ trackerId: rowId, status: z.literal('pending-server-check') })
const metadataRow = z.object({ key: z.literal('workspace'), userId: rowId.nullable(), guestDecision: z.enum(['imported', 'imported-as-copies', 'kept-separate']).optional(), importedAt: timestamp.optional() })
const backupSchema = z.object({
  format: z.literal(WORKSPACE_BACKUP_FORMAT), version: z.union([z.literal(1), z.literal(WORKSPACE_BACKUP_VERSION)]), exportedAt: timestamp,
  workspace: z.object({ kind: z.enum(['guest', 'account']), ownerUserId: rowId.nullable() }),
  stores: z.object({
    categories: z.array(categoryRow), dailyEntries: z.array(dailyEntryRow), dailyJournals: z.array(dailyJournalRow),
    goals: z.array(goalRow), goalMetrics: z.array(goalMetricRow), goalProgressLogs: z.array(goalProgressRow),
    settings: z.array(settingsRow), trackers: z.array(trackerDefinitionSchema), trackerEntries: z.array(trackerEntrySchema),
    workspaceMetadata: z.array(metadataRow), syncOperations: z.array(operationRow), syncRecords: z.array(syncRecordRow), syncConflicts: z.array(syncConflictRow),
    permanentDeletionRequests: z.array(deletionRequestRow).optional().default([]),
    permanentDeletionLedger: z.array(deletionLedgerRow).optional().default([]),
    trackerVerification: z.array(trackerVerificationRow).optional().default([]),
  }),
})

const primaryKeyFor: Record<(typeof backupStores)[number], string> = {
  categories: 'id', dailyEntries: 'id', dailyJournals: 'id', goals: 'id', goalMetrics: 'id', goalProgressLogs: 'id',
  settings: 'id', trackers: 'id', trackerEntries: 'id', workspaceMetadata: 'key', syncOperations: 'id', syncRecords: 'key', syncConflicts: 'id',
  permanentDeletionRequests: 'id', permanentDeletionLedger: 'key', trackerVerification: 'trackerId',
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function parseAndCheckBackup(value: unknown, expectedOwnerUserId: string | null): WorkspaceBackup {
  const parsed = backupSchema.safeParse(value)
  if (!parsed.success) throw new Error(`Backup validation failed: ${parsed.error.issues[0]?.path.join('.') || 'invalid backup'} — ${parsed.error.issues[0]?.message ?? 'unsupported data'}`)
  const backup = { ...parsed.data, version: WORKSPACE_BACKUP_VERSION } as WorkspaceBackup
  if (backup.workspace.ownerUserId !== expectedOwnerUserId || backup.workspace.kind !== (expectedOwnerUserId === null ? 'guest' : 'account')) {
    throw new Error('This backup belongs to a different workspace. Sign into the matching account or open the guest workspace.')
  }
  const metadata = parsed.data.stores.workspaceMetadata
  if (metadata.length !== 1 || metadata[0]?.userId !== expectedOwnerUserId) throw new Error('Backup workspace metadata does not match its owner.')
  for (const record of parsed.data.stores.syncOperations) {
    if ((record.ownerUserId ?? null) !== expectedOwnerUserId) throw new Error('Backup contains a sync operation for another workspace.')
    if (record.entity === 'tracker' && record.payload !== undefined) {
      const payload = trackerDefinitionSchema.safeParse(record.payload)
      if (!payload.success || payload.data.id !== record.entityId) throw new Error('Backup contains an invalid tracker sync operation.')
    }
    if (record.entity === 'tracker_entry' && record.payload !== undefined) {
      const payload = trackerEntrySchema.safeParse(record.payload)
      if (!payload.success || payload.data.id !== record.entityId) throw new Error('Backup contains an invalid tracker-entry sync operation.')
    }
  }
  for (const record of parsed.data.stores.syncRecords) {
    if (record.key !== `${record.entity}:${record.entityId}`) throw new Error('Backup contains inconsistent sync revision metadata.')
  }
  for (const name of ['syncRecords', 'syncConflicts'] as const) {
    for (const record of parsed.data.stores[name]) {
      if (expectedOwnerUserId === null || record.ownerUserId !== expectedOwnerUserId) throw new Error(`Backup contains ${name} data for another workspace.`)
    }
  }
  for (const record of parsed.data.stores.permanentDeletionRequests) {
    if (expectedOwnerUserId === null || record.ownerUserId !== expectedOwnerUserId) throw new Error('Backup contains a permanent deletion request for another workspace.')
  }
  for (const record of parsed.data.stores.permanentDeletionLedger) {
    if (expectedOwnerUserId === null || record.ownerUserId !== expectedOwnerUserId || record.key !== `${expectedOwnerUserId}:${record.trackerId}`) throw new Error('Backup contains an invalid permanent-deletion ledger record.')
  }
  for (const conflict of parsed.data.stores.syncConflicts) {
    const local = conflict.entity === 'tracker' ? trackerDefinitionSchema.safeParse(conflict.localPayload) : trackerEntrySchema.safeParse(conflict.localPayload)
    if (!local.success || local.data.id !== conflict.entityId) throw new Error('Backup contains an invalid local conflict copy.')
    if (conflict.remoteRecord?.user_id !== undefined && conflict.remoteRecord.user_id !== expectedOwnerUserId) throw new Error('Backup contains a conflict snapshot owned by another account.')
  }
  const trackerIds = new Set(parsed.data.stores.trackers.map((tracker) => tracker.id))
  const entryRows = new Set(parsed.data.stores.trackerEntries.map((entry) => entry.id))
  if (entryRows.size !== parsed.data.stores.trackerEntries.length) throw new Error('Backup contains duplicate tracker entry IDs.')
  for (const entry of parsed.data.stores.trackerEntries) {
    if (!trackerIds.has(entry.trackerId)) {
      throw new Error(`Backup tracker entry ${entry.id} refers to a missing tracker.`)
    }
  }
  return backup
}

async function compareBackupWithWorkspace(backup: WorkspaceBackup, database: Awaited<ReturnType<typeof openDatabase>>) {
  const added: Record<string, number> = {}
  const alreadyPresent: Record<string, number> = {}
  const conflicts: string[] = []
  const plannedUniqueKeys = new Map<string, string>()

  for (const storeName of backupStores) {
    const candidates = backup.stores[storeName] as Array<Record<string, unknown>>
    const keyName = primaryKeyFor[storeName]
    if (storeName === 'workspaceMetadata') {
      added[storeName] = 0
      alreadyPresent[storeName] = candidates.length
      continue
    }
    const table = database.table(storeName)
    const current = await table.toArray() as Array<Record<string, unknown>>
    const currentByKey = new Map(current.map((row) => [String(row[keyName]), row]))
    const candidateKeys = new Set<string>()
    let addCount = 0
    let sameCount = 0
    for (const row of candidates) {
      const key = String(row[keyName])
      if (candidateKeys.has(key)) conflicts.push(`${storeName}.${key}: duplicate key inside backup`)
      candidateKeys.add(key)
      const existing = currentByKey.get(key)
      if (existing) {
        if (stableJson(existing) === stableJson(row)) sameCount++
        else conflicts.push(`${storeName}.${key}: a different local record already uses this ID`)
        continue
      }
      let uniqueValue: string | null = null
      if (storeName === 'dailyEntries') uniqueValue = `${row.categoryId}:${row.date}`
      if (storeName === 'dailyJournals') uniqueValue = String(row.date)
      if (storeName === 'trackerEntries') uniqueValue = `${row.trackerId}:${row.date}`
      if (uniqueValue !== null) {
        const indexKey = `${storeName}:${uniqueValue}`
        const previous = plannedUniqueKeys.get(indexKey)
        if (previous) conflicts.push(`${storeName}.${uniqueValue}: multiple backup records share a unique date key`)
        plannedUniqueKeys.set(indexKey, key)
        const currentCollision = current.find((candidate) => {
          if (storeName === 'dailyEntries' || storeName === 'trackerEntries') return `${candidate[storeName === 'dailyEntries' ? 'categoryId' : 'trackerId']}:${candidate.date}` === uniqueValue
          return String(candidate.date) === uniqueValue
        })
        if (currentCollision) conflicts.push(`${storeName}.${uniqueValue}: another local record already uses this date`)
      }
      addCount++
    }
    added[storeName] = addCount
    alreadyPresent[storeName] = sameCount
  }
  return { added, alreadyPresent, conflicts }
}

/** Validate a JSON-parsed backup and show a non-mutating restore preview. */
export async function previewWorkspaceRestore(value: unknown, expectedOwnerUserId: string | null): Promise<WorkspaceRestorePreview> {
  const backup = parseAndCheckBackup(value, expectedOwnerUserId)
  const database = await openDatabase()
  return database.transaction('r', [...backupStores.map((name) => database.table(name))], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== expectedOwnerUserId) throw new Error('The active workspace changed. Reopen Account and select the backup again.')
    return { backup, ...await compareBackupWithWorkspace(backup, database) }
  })
}

/** Add only missing records. Existing identical rows are skipped; all other collisions abort atomically. */
export async function restoreWorkspaceBackup(value: unknown, expectedOwnerUserId: string | null): Promise<WorkspaceRestorePreview> {
  const backup = parseAndCheckBackup(value, expectedOwnerUserId)
  if (!isSchemaV3WriteEnabled() && backup.stores.trackers.some((tracker) => typeof tracker === 'object' && tracker !== null && 'schemaVersion' in tracker && tracker.schemaVersion === 3)) {
    throw new Error('This production build cannot restore schema v3 trackers until the hosted migration is applied and verified.')
  }
  const database = await openDatabase()
  const result = await database.transaction('rw', [...backupStores.map((name) => database.table(name))], async () => {
    const metadata = await database.workspaceMetadata.get('workspace')
    if (metadata?.userId !== expectedOwnerUserId) throw new Error('The active workspace changed. Reopen Account and select the backup again.')
    const comparison = await compareBackupWithWorkspace(backup, database)
    if (comparison.conflicts.length) throw new Error(`Restore stopped without changing data: ${comparison.conflicts[0]}`)
    for (const storeName of backupStores) {
      if (storeName === 'workspaceMetadata') continue
      const candidates = backup.stores[storeName] as Array<Record<string, unknown>>
      const table = database.table(storeName)
      const additions = []
      for (const row of candidates) {
        const existing = await table.get(row[primaryKeyFor[storeName]] as never) as Record<string, unknown> | undefined
        if (!existing) {
          if (storeName === 'permanentDeletionRequests') additions.push({ ...row, status: 'failed', lastError: 'Imported deletion requests are inert. Confirm permanent deletion again from the Bin.' })
          else additions.push(row)
          if (storeName === 'trackers' && expectedOwnerUserId) {
            const verification = database.table('trackerVerification')
            const trackerId = String(row.id)
            if (!await verification.get(trackerId)) await verification.put({ trackerId, status: 'pending-server-check' })
          }
        }
      }
      if (additions.length) await table.bulkAdd(additions as never[])
    }
    return { backup, ...comparison }
  })
  if (expectedOwnerUserId && Object.values(result.added).some((count) => count > 0)) publishWorkspaceMutation(expectedOwnerUserId)
  return result
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
