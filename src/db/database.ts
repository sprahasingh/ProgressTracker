import Dexie, { type Table } from 'dexie'
import type {
  AppSettings,
  Category,
  DailyEntry,
  DailyJournal,
  Goal,
  GoalMetric,
  GoalProgressLog,
  StoredTrackerDefinition,
  StoredTrackerEntry,
  SyncOperation,
} from './models'
import { categoryToTracker, dailyEntryToTrackerEntry } from '../domain/trackers/legacyAdapters'

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
  syncOperations!: Table<SyncOperation, string>
  trackers!: Table<StoredTrackerDefinition, string>
  trackerEntries!: Table<StoredTrackerEntry, string>
  workspaceMetadata!: Table<{ key: string; userId: string | null; guestDecision?: 'imported' | 'kept-separate'; importedAt?: string }, string>

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
  }
}

const guestDatabaseName = 'ProgressTracker'
export let db = new ProgressTrackerDatabase(guestDatabaseName)
let activeWorkspaceKey: string | null = null
let workspaceEpoch = 0
export const DATABASE_SCHEMA_VERSION = 4

export type GuestWorkspaceSummary = { hasData: boolean; counts: Record<string, number> }

const workspaceTables = ['categories', 'dailyEntries', 'dailyJournals', 'goals', 'goalMetrics', 'goalProgressLogs', 'settings', 'trackers', 'trackerEntries'] as const

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
  const metadata = await db.workspaceMetadata.get('workspace')
  if (metadata?.userId !== userId) {
    await db.workspaceMetadata.put({ key: 'workspace', userId, guestDecision: metadata?.guestDecision })
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

export async function getGuestDecision(userId: string): Promise<'imported' | 'kept-separate' | undefined> {
  const target = new ProgressTrackerDatabase(databaseNameFor(userId))
  await target.open()
  try { return (await target.workspaceMetadata.get('workspace'))?.guestDecision }
  finally { target.close() }
}

/** Imports guest rows once, transactionally; source rows are retained as a recovery copy. */
export async function decideGuestData(userId: string, decision: 'imported' | 'kept-separate'): Promise<void> {
  const guest = new ProgressTrackerDatabase(guestDatabaseName)
  const target = new ProgressTrackerDatabase(databaseNameFor(userId))
  await Promise.all([guest.open(), target.open()])
  try {
    const guestRows = new Map<string, unknown[]>(await Promise.all(workspaceTables.map(async (tableName) => [tableName, await guest.table(tableName).toArray()] as [string, unknown[]])))
    await target.transaction('rw', [target.workspaceMetadata, ...workspaceTables.map((table) => target.table(table))], async () => {
      const metadata = await target.workspaceMetadata.get('workspace')
      if (metadata?.guestDecision) return
      if (decision === 'imported') {
        for (const tableName of workspaceTables) {
          const sourceRows = guestRows.get(tableName) ?? []
          const targetTable = target.table(tableName)
          for (const source of sourceRows) {
            const key = (source as { id?: string; key?: string }).id ?? (source as { key: string }).key
            const existing = await targetTable.get(key)
            if (existing && JSON.stringify(existing) !== JSON.stringify(source)) {
              throw new Error(`Guest import stopped because ${tableName} contains a different record with the same ID. Guest data is unchanged.`)
            }
            if (!existing) await targetTable.put(source)
          }
        }
        for (const tableName of workspaceTables) {
          const sourceRows = guestRows.get(tableName) ?? []
          for (const source of sourceRows) {
            const key = (source as { id?: string; key?: string }).id ?? (source as { key: string }).key
            const imported = await target.table(tableName).get(key)
            if (JSON.stringify(imported) !== JSON.stringify(source)) throw new Error('Guest import verification failed. Guest data is unchanged.')
          }
        }
      }
      await target.workspaceMetadata.put({ key: 'workspace', userId, guestDecision: decision, importedAt: decision === 'imported' ? new Date().toISOString() : undefined })
    })
  } finally { guest.close(); target.close() }
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
