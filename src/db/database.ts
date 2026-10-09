import Dexie, { type Table } from 'dexie'
import type {
  AppSettings,
  AccountHoliday,
  Category,
  DailyEntry,
  DailyJournal,
  Goal,
  GoalMetric,
  GoalProgressLog,
  StoredTrackerDefinition,
  StoredTrackerEntry,
  SyncOperation,
  SyncConflict,
  SyncRecordState,
  PermanentDeletionRequest,
  PermanentDeletionLedgerEntry,
  TrackerVerification,
} from './models'
import { categoryToTracker, dailyEntryToTrackerEntry } from '../domain/trackers/legacyAdapters'
import { isPermanentDeletionEnabled, isSchemaV3WriteEnabled, isSchemaV4WriteEnabled } from '../domain/trackers/schemaVersionGate'

type LegacySyncRecord = {
  createdAt?: string
  updatedAt?: string
  deletedAt?: string | null
}

const coreSchema = {
  categories: 'id, name, position, archivedAt, updatedAt, deletedAt',
  dailyEntries: 'id, categoryId, date, status, updatedAt, deletedAt, &[categoryId+date]',
  goals: 'id, categoryId, status, targetDate, updatedAt, deletedAt',
  goalMetrics: 'id, goalId, name, position, updatedAt, deletedAt',
  goalProgressLogs: 'id, metricId, date, recordedAt, updatedAt, deletedAt',
  settings: 'id, updatedAt',
}

export class ProgressTrackerDatabase extends Dexie {
  categories!: Table<Category, string>
  dailyEntries!: Table<DailyEntry, string>
  dailyJournals!: Table<DailyJournal, string>
  goals!: Table<Goal, string>
  goalMetrics!: Table<GoalMetric, string>
  goalProgressLogs!: Table<GoalProgressLog, string>
  settings!: Table<AppSettings, string>
  accountHolidays!: Table<AccountHoliday, string>
  syncOperations!: Table<SyncOperation, string>
  trackers!: Table<StoredTrackerDefinition, string>
  trackerEntries!: Table<StoredTrackerEntry, string>
  workspaceMetadata!: Table<{ key: string; userId: string | null; guestDecision?: 'imported' | 'imported-as-copies' | 'kept-separate'; importedAt?: string }, string>
  syncRecords!: Table<SyncRecordState, string>
  syncConflicts!: Table<SyncConflict, string>
  permanentDeletionRequests!: Table<PermanentDeletionRequest, string>
  permanentDeletionLedger!: Table<PermanentDeletionLedgerEntry, string>
  trackerVerification!: Table<TrackerVerification, string>

  constructor(name = 'ProgressTracker') {
    super(name)

    // Version 1 is retained so future changes can upgrade already-installed copies.
    this.version(1).stores({
      categories: 'id, name, position, archivedAt',
      dailyEntries: 'id, categoryId, date, status, &[categoryId+date]',
      goals: 'id, categoryId, status, targetDate',
      goalMetrics: 'id, goalId, name, position',
      goalProgressLogs: 'id, metricId, date, recordedAt',
      settings: 'id',
    })

    this.version(2)
      .stores({
        ...coreSchema,
        dailyJournals: 'id, &date, updatedAt, deletedAt',
        syncOperations: 'id, entity, entityId, operation, updatedAt, [entity+entityId]',
      })

    this.version(3)
      .stores({
        ...coreSchema,
        dailyJournals: 'id, &date, updatedAt, deletedAt',
        syncOperations: 'id, entity, entityId, operation, updatedAt, [entity+entityId]',
        trackers: 'id, kind, status, categoryId, updatedAt, deletedAt',
        trackerEntries: 'id, trackerId, date, outcome, updatedAt, deletedAt, &[trackerId+date]',
      })
      .upgrade(async (transaction) => {
        const [categories, entries] = await Promise.all([
          transaction.table('categories').toArray() as Promise<Category[]>,
          transaction.table('dailyEntries').toArray() as Promise<DailyEntry[]>,
        ])
        const trackers = transaction.table('trackers')
        const trackerEntries = transaction.table('trackerEntries')
        await trackers.bulkAdd(categories.map(categoryToTracker))
        await trackerEntries.bulkAdd(entries.map(dailyEntryToTrackerEntry))
      })
      .upgrade(async (transaction) => {
        const tables = ['categories', 'dailyEntries', 'goals', 'goalMetrics', 'goalProgressLogs', 'settings']
        await Promise.all(tables.map((tableName) => transaction.table(tableName).toCollection().modify((record) => {
          const legacyRecord = record as LegacySyncRecord
          legacyRecord.updatedAt ??= legacyRecord.createdAt ?? new Date().toISOString()
          legacyRecord.deletedAt ??= null
        })))
      })

    this.version(4).stores({
      ...coreSchema,
      dailyJournals: 'id, &date, updatedAt, deletedAt',
      syncOperations: 'id, entity, entityId, operation, updatedAt, [entity+entityId]',
      trackers: 'id, kind, status, categoryId, updatedAt, deletedAt',
      trackerEntries: 'id, trackerId, date, outcome, updatedAt, deletedAt, &[trackerId+date]',
      workspaceMetadata: 'key',
    })

    this.version(5).stores({
      ...coreSchema,
      dailyJournals: 'id, &date, updatedAt, deletedAt',
      syncOperations: 'id, ownerUserId, entity, entityId, status, createdAt, [ownerUserId+status+createdAt], [ownerUserId+entity+entityId]',
      trackers: 'id, kind, status, categoryId, updatedAt, deletedAt',
      trackerEntries: 'id, trackerId, date, outcome, updatedAt, deletedAt, &[trackerId+date]',
      workspaceMetadata: 'key',
      syncRecords: '&key, ownerUserId, entity, entityId, [ownerUserId+entity+entityId]',
      syncConflicts: 'id, ownerUserId, entity, entityId, [ownerUserId+entity+entityId]',
    }).upgrade(async (transaction) => {
      const metadata = await transaction.table('workspaceMetadata').get('workspace') as { userId?: string | null } | undefined
      if (!metadata?.userId) return
      const [trackers, entries] = await Promise.all([
        transaction.table('trackers').toArray() as Promise<StoredTrackerDefinition[]>,
        transaction.table('trackerEntries').toArray() as Promise<StoredTrackerEntry[]>,
      ])
      const operations = transaction.table('syncOperations')
      const now = new Date().toISOString()
      await operations.bulkAdd([
        ...trackers.map((payload) => ({ id: crypto.randomUUID(), ownerUserId: metadata.userId!, entity: 'tracker' as const, entityId: payload.id, operation: 'upsert' as const, expectedRevision: null, payload, createdAt: now, attempts: 0, status: 'pending' as const, lastError: null })),
        ...entries.map((payload) => ({ id: crypto.randomUUID(), ownerUserId: metadata.userId!, entity: 'tracker_entry' as const, entityId: payload.id, operation: 'upsert' as const, expectedRevision: null, payload, createdAt: now, attempts: 0, status: 'pending' as const, lastError: null })),
      ])
    })

    this.version(6).stores({
      ...coreSchema,
      dailyJournals: 'id, &date, updatedAt, deletedAt',
      syncOperations: 'id, ownerUserId, entity, entityId, status, createdAt, [ownerUserId+status+createdAt], [ownerUserId+entity+entityId]',
      trackers: 'id, kind, status, categoryId, updatedAt, deletedAt',
      trackerEntries: 'id, trackerId, date, outcome, updatedAt, deletedAt, &[trackerId+date]',
      workspaceMetadata: 'key',
      syncRecords: '&key, ownerUserId, entity, entityId, [ownerUserId+entity+entityId]',
      syncConflicts: 'id, ownerUserId, entity, entityId, [ownerUserId+entity+entityId]',
      permanentDeletionRequests: 'id, ownerUserId, trackerId, requestedAt, status, [ownerUserId+trackerId]',
      permanentDeletionLedger: '&key, ownerUserId, trackerId',
      trackerVerification: '&trackerId, status',
    })

    this.version(7).stores({
      ...coreSchema,
      dailyJournals: 'id, &date, updatedAt, deletedAt',
      syncOperations: 'id, ownerUserId, entity, entityId, status, createdAt, [ownerUserId+status+createdAt], [ownerUserId+entity+entityId]',
      trackers: 'id, kind, status, categoryId, updatedAt, deletedAt',
      trackerEntries: 'id, trackerId, date, outcome, updatedAt, deletedAt, &[trackerId+date]',
      accountHolidays: 'id, &date, updatedAt, deletedAt',
      workspaceMetadata: 'key',
      syncRecords: '&key, ownerUserId, entity, entityId, [ownerUserId+entity+entityId]',
      syncConflicts: 'id, ownerUserId, entity, entityId, [ownerUserId+entity+entityId]',
      permanentDeletionRequests: 'id, ownerUserId, trackerId, requestedAt, status, [ownerUserId+trackerId]',
      permanentDeletionLedger: '&key, ownerUserId, trackerId',
      trackerVerification: '&trackerId, status',
    })
  }
}

const guestDatabaseName = 'ProgressTracker'
export let db = new ProgressTrackerDatabase(guestDatabaseName)
let activeWorkspaceKey: string | null = null
let workspaceEpoch = 0
export const DATABASE_SCHEMA_VERSION = 7

export type GuestWorkspaceSummary = { hasData: boolean; counts: Record<string, number> }

const workspaceTables = ['categories', 'dailyEntries', 'dailyJournals', 'goals', 'goalMetrics', 'goalProgressLogs', 'settings', 'trackers', 'trackerEntries', 'accountHolidays'] as const

function databaseNameFor(userId: string | null): string {
  return userId === null ? guestDatabaseName : `ProgressTracker:account:${encodeURIComponent(userId)}`
}

/** Switches the active local repository to a guest or account-isolated database. */
export async function activateWorkspace(userId: string | null): Promise<number> {
  const epoch = ++workspaceEpoch
  const key = userId
  if (activeWorkspaceKey !== key) {
    db.close()
    db = new ProgressTrackerDatabase(databaseNameFor(userId))
    activeWorkspaceKey = key
  }
  await openDatabase()
  if (epoch !== workspaceEpoch) throw new Error('Workspace changed while it was opening.')
  const workspaceDb = db
  const metadata = await workspaceDb.workspaceMetadata.get('workspace')
  if (metadata?.userId !== userId) {
    await workspaceDb.workspaceMetadata.put({ key: 'workspace', userId, guestDecision: metadata?.guestDecision })
  }
  if (userId === null && isPermanentDeletionEnabled()) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    await workspaceDb.transaction('rw', [workspaceDb.trackers, workspaceDb.trackerEntries], async () => {
      const expired = (await workspaceDb.trackers.toArray()).filter((tracker) => tracker.deletedAt !== null && Date.parse(tracker.deletedAt) <= cutoff)
      for (const tracker of expired) {
        await workspaceDb.trackerEntries.where('trackerId').equals(tracker.id).delete()
        await workspaceDb.trackers.delete(tracker.id)
      }
    })
  }
  return epoch
}

export async function getGuestWorkspaceSummary(): Promise<GuestWorkspaceSummary> {
  const guest = new ProgressTrackerDatabase(guestDatabaseName)
  await guest.open()
  try {
    const entries = await Promise.all(workspaceTables.map(async (table) => [table, await guest.table(table).count()] as const))
    const counts = Object.fromEntries(entries)
    return { hasData: Object.values(counts).some((count) => count > 0), counts }
  } finally { guest.close() }
}

export type GuestDataDecision = 'imported' | 'imported-as-copies' | 'kept-separate'

export async function getGuestDecision(userId: string): Promise<GuestDataDecision | undefined> {
  const target = new ProgressTrackerDatabase(databaseNameFor(userId))
  await target.open()
  try { return (await target.workspaceMetadata.get('workspace'))?.guestDecision }
  finally { target.close() }
}

/** Imports guest rows once, transactionally; source rows are retained as a recovery copy. */
export async function decideGuestData(userId: string, decision: GuestDataDecision): Promise<void> {
  const guest = new ProgressTrackerDatabase(guestDatabaseName)
  const target = new ProgressTrackerDatabase(databaseNameFor(userId))
  await Promise.all([guest.open(), target.open()])
  try {
    // Read every source table from one IndexedDB snapshot. The guest database
    // stays available in other tabs while an account import is underway.
    const guestRows = await guest.transaction('r', workspaceTables.map((table) => guest.table(table)), async () =>
      new Map<string, unknown[]>(await Promise.all(workspaceTables.map(async (tableName) => [tableName, await guest.table(tableName).toArray()] as [string, unknown[]]))),
    )
    await target.transaction('rw', [target.workspaceMetadata, target.syncOperations, target.syncRecords, target.trackerVerification, ...workspaceTables.map((table) => target.table(table))], async () => {
      const metadata = await target.workspaceMetadata.get('workspace')
      if (metadata?.guestDecision) return
      if (decision === 'imported' || decision === 'imported-as-copies') {
        const remappedIds = new Map<string, Map<string, string>>()
        const forcedForkIds = new Map<string, Set<string>>()
        const copiedTrackers: StoredTrackerDefinition[] = []
        const copiedEntries: StoredTrackerEntry[] = []
        const copiedHolidays: AccountHoliday[] = []
        const remap = (tableName: string, id: unknown): unknown => typeof id === 'string' ? remappedIds.get(tableName)?.get(id) ?? id : id
        const transform = (tableName: string, source: unknown): Record<string, unknown> => {
          const row = source as Record<string, unknown>
          switch (tableName) {
            case 'dailyEntries': return { ...row, categoryId: remap('categories', row.categoryId) }
            case 'goals': return { ...row, categoryId: remap('categories', row.categoryId) }
            case 'goalMetrics': return { ...row, goalId: remap('goals', row.goalId) }
            case 'goalProgressLogs': return { ...row, metricId: remap('goalMetrics', row.metricId) }
            case 'trackers': return { ...row, categoryId: remap('categories', row.categoryId) }
            case 'trackerEntries': return { ...row, trackerId: remap('trackers', row.trackerId) }
            default: return { ...row }
          }
        }
        // Parents precede children so every copied foreign key uses its final ID.
        const importOrder = ['categories', 'dailyEntries', 'dailyJournals', 'goals', 'goalMetrics', 'goalProgressLogs', 'settings', 'trackers', 'trackerEntries', 'accountHolidays']
        if (decision === 'imported-as-copies') {
          const categoryForks = new Set<string>()
          for (const entry of (guestRows.get('dailyEntries') ?? []) as DailyEntry[]) {
            const collision = await target.dailyEntries.where('[categoryId+date]').equals([entry.categoryId, entry.date]).first()
            if (collision && JSON.stringify(collision) !== JSON.stringify(entry)) categoryForks.add(entry.categoryId)
          }
          forcedForkIds.set('categories', categoryForks)
          const trackerForks = new Set<string>()
          for (const entry of (guestRows.get('trackerEntries') ?? []) as StoredTrackerEntry[]) {
            const collision = await target.trackerEntries.where('[trackerId+date]').equals([entry.trackerId, entry.date]).first()
            if (collision && JSON.stringify(collision) !== JSON.stringify(entry)) trackerForks.add(entry.trackerId)
          }
          forcedForkIds.set('trackers', trackerForks)
        }
        for (const tableName of importOrder) {
          const sourceRows = guestRows.get(tableName) ?? []
          const targetTable = target.table(tableName)
          const idMap = new Map<string, string>()
          remappedIds.set(tableName, idMap)
          for (const source of sourceRows) {
            const sourceKey = (source as { id?: string; key?: string }).id ?? (source as { key: string }).key
            const candidate = transform(tableName, source)
            const existing = await targetTable.get(sourceKey)
            const forceFork = forcedForkIds.get(tableName)?.has(sourceKey) ?? false
            if (tableName === 'dailyJournals') {
              const journalDate = (source as { date?: string }).date
              const dateCollision = journalDate ? await target.dailyJournals.where('date').equals(journalDate).first() : undefined
              if (dateCollision && JSON.stringify(dateCollision) !== JSON.stringify(source)) {
                throw new Error(`Guest import stopped because both workspaces have a journal for ${journalDate}. Both copies are unchanged; keep the workspaces separate.`)
              }
            }
            if (tableName === 'dailyEntries' && decision !== 'imported-as-copies') {
              const entry = source as DailyEntry
              const dateCollision = await target.dailyEntries.where('[categoryId+date]').equals([entry.categoryId, entry.date]).first()
              if (dateCollision && dateCollision.id !== sourceKey) {
                throw new Error(`Guest import stopped because both workspaces have activity for this category on ${entry.date}. Both copies are unchanged; choose the collision-safe copy option.`)
              }
            }
            if (tableName === 'trackerEntries' && decision !== 'imported-as-copies') {
              const entry = source as StoredTrackerEntry
              const dateCollision = await target.trackerEntries.where('[trackerId+date]').equals([entry.trackerId, entry.date]).first()
              if (dateCollision && dateCollision.id !== sourceKey) {
                throw new Error(`Guest import stopped because both workspaces have a tracker entry for this date. Both copies are unchanged; choose the collision-safe copy option.`)
              }
            }
            if (tableName === 'settings' && existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
              // There is one settings row per workspace. Keep the account's current preferences;
              // the complete guest settings copy remains untouched in the guest workspace.
              idMap.set(sourceKey, sourceKey)
              continue
            }
            if (existing && JSON.stringify(existing) === JSON.stringify(candidate) && !forceFork) {
              idMap.set(sourceKey, sourceKey)
              continue
            }
            let importedKey = sourceKey
            if (existing || forceFork) {
              if (decision !== 'imported-as-copies' || tableName === 'settings') {
                throw new Error(`Guest import stopped because ${tableName} contains a different record with the same ID. Guest data is unchanged.`)
              }
              importedKey = crypto.randomUUID()
              candidate.id = importedKey
            }
            idMap.set(sourceKey, importedKey)
            await targetTable.put(candidate)
            if (tableName === 'trackers') copiedTrackers.push(candidate as unknown as StoredTrackerDefinition)
            if (tableName === 'trackerEntries') copiedEntries.push(candidate as unknown as StoredTrackerEntry)
            if (tableName === 'accountHolidays') copiedHolidays.push(candidate as unknown as AccountHoliday)
          }
        }
        for (const tableName of importOrder) {
          const sourceRows = guestRows.get(tableName) ?? []
          if (tableName === 'settings' && decision === 'imported-as-copies') continue
          for (const source of sourceRows) {
            const sourceKey = (source as { id?: string; key?: string }).id ?? (source as { key: string }).key
            const importedKey = remappedIds.get(tableName)?.get(sourceKey) ?? sourceKey
            const imported = await target.table(tableName).get(importedKey)
            const expected = transform(tableName, source)
            if (importedKey !== sourceKey) expected.id = importedKey
            if (JSON.stringify(imported) !== JSON.stringify(expected)) throw new Error('Guest import verification failed. Guest data is unchanged.')
          }
        }
        for (const payload of copiedTrackers) {
          await target.trackerVerification.put({ trackerId: payload.id, status: 'pending-server-check' })
          await queueSyncMutation(target, userId, 'tracker', payload)
        }
        for (const payload of copiedEntries) {
          await queueSyncMutation(target, userId, 'tracker_entry', payload)
        }
        for (const payload of copiedHolidays) {
          await queueSyncMutation(target, userId, 'account_holiday', payload)
        }
      }
      await target.workspaceMetadata.put({
        key: 'workspace', userId, guestDecision: decision,
        importedAt: decision === 'kept-separate' ? undefined : new Date().toISOString(),
      })
    })
  } finally { guest.close(); target.close() }
}

export async function queueSyncMutation(
  database: ProgressTrackerDatabase,
  ownerUserId: string | null,
  entity: 'tracker' | 'tracker_entry' | 'account_holiday',
  payload: StoredTrackerDefinition | StoredTrackerEntry | AccountHoliday,
): Promise<void> {
  if (entity === 'tracker' && (payload as StoredTrackerDefinition).schemaVersion === 3 && !isSchemaV3WriteEnabled()) {
    throw new Error('Schema v3 local and cloud writes are disabled until the hosted migration is applied and verified.')
  }
  if (entity === 'tracker' && (payload as StoredTrackerDefinition).schemaVersion === 4 && !isSchemaV4WriteEnabled()) {
    throw new Error('Schema v4 precision writes are disabled until the hosted migration is applied and verified.')
  }
  if (!ownerUserId) return
  const entityId = payload.id
  const existing = await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([ownerUserId, entity, entityId]).toArray()
  if (existing.length) await database.syncOperations.bulkDelete(existing.map(({ id }) => id))
  const state = await database.syncRecords.get(`${entity}:${entityId}`)
  await database.syncOperations.add({
    id: crypto.randomUUID(), ownerUserId, entity, entityId, operation: 'upsert',
    expectedRevision: state?.serverRevision ?? null, payload, createdAt: new Date().toISOString(),
    attempts: 0, status: 'pending', lastError: null,
  })
}

export async function openDatabase(): Promise<ProgressTrackerDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('ProgressTracker needs browser IndexedDB to save your local data.')
  }

  try {
    await db.open()
    return db
  } catch (cause) {
    throw new Error('ProgressTracker could not open local storage. Your browser may be blocking site data.', { cause })
  }
}
