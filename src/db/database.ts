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
  }
}

export const db = new ProgressTrackerDatabase()
export const DATABASE_SCHEMA_VERSION = 3

export async function openDatabase(): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('ProgressTracker needs browser IndexedDB to save your local data.')
  }

  try {
    await db.open()
  } catch (cause) {
    throw new Error('ProgressTracker could not open local storage. Your browser may be blocking site data.', { cause })
  }
}
