import { openDatabase, queueSyncMutation } from './database'
import { assertCalendarDate, assertDateRange } from './calendarDate'
import type { CalendarDate, Category, DailyEntry, DailyEntryDraft, DailyJournal, DailyJournalDraft, Goal, StoredTrackerDefinition, StoredTrackerEntry } from './models'
import { trackerDefinitionSchema, trackerEntrySchema, validateTrackerEntryValues } from '../domain/trackers/schema'

function newId(): string {
  return crypto.randomUUID()
}

export const localRepository = {
  async listTrackers(includeArchived = false): Promise<StoredTrackerDefinition[]> {
    const database = await openDatabase()
    const trackers = await database.trackers.filter((tracker) => tracker.deletedAt === null).toArray()
    return trackers
      .filter((tracker) => includeArchived || tracker.status !== 'archived')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
  },

  async getTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    const tracker = await database.trackers.get(id)
    return tracker?.deletedAt === null ? tracker : undefined
  },

  async saveTracker(draft: StoredTrackerDefinition): Promise<StoredTrackerDefinition> {
    const checked = trackerDefinitionSchema.safeParse(draft)
    if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'Tracker details are invalid.')
    const database = await openDatabase()
    return database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.workspaceMetadata], async () => {
      const existing = await database.trackers.get(draft.id)
      const record: StoredTrackerDefinition = {
        ...draft,
        createdAt: existing?.createdAt ?? draft.createdAt,
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      }
      await database.trackers.put(record)
      const workspace = await database.workspaceMetadata.get('workspace')
      await queueSyncMutation(database, workspace?.userId ?? null, 'tracker', record)
      return record
    })
  },

  async listTrackerEntriesForDate(date: CalendarDate): Promise<StoredTrackerEntry[]> {
    assertCalendarDate(date)
    const database = await openDatabase()
    const entries = await database.trackerEntries.where('date').equals(date).toArray()
    return entries.filter((entry) => entry.deletedAt === null)
  },

  async listTrackerEntriesBetween(startDate: CalendarDate, endDate: CalendarDate): Promise<StoredTrackerEntry[]> {
    assertDateRange(startDate, endDate)
    const database = await openDatabase()
    const entries = await database.trackerEntries.where('date').between(startDate, endDate, true, true).toArray()
    return entries.filter((entry) => entry.deletedAt === null).sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt))
  },

  async getTrackerEntry(trackerId: string, date: CalendarDate): Promise<StoredTrackerEntry | undefined> {
    assertCalendarDate(date)
    const database = await openDatabase()
    const entry = await database.trackerEntries.where('[trackerId+date]').equals([trackerId, date]).first()
    return entry?.deletedAt === null ? entry : undefined
  },

  async saveTrackerEntry(draft: Omit<StoredTrackerEntry, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>): Promise<StoredTrackerEntry> {
    assertCalendarDate(draft.date)
    const checked = trackerEntrySchema.safeParse({ ...draft, id: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null })
    if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'Check-in details are invalid.')
    const database = await openDatabase()
    return database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.workspaceMetadata], async () => {
      const tracker = await database.trackers.get(draft.trackerId)
      if (!tracker || tracker.deletedAt !== null || tracker.status === 'archived') throw new Error('This tracker is not available for check-ins.')
      const valueIssue = validateTrackerEntryValues(tracker, draft.values)
      if (draft.outcome === 'recorded' && valueIssue) throw new Error(valueIssue)
      const existing = await database.trackerEntries.where('[trackerId+date]').equals([draft.trackerId, draft.date]).first()
      const now = new Date().toISOString()
      const entry = trackerEntrySchema.parse({
        ...draft,
        id: existing?.id ?? newId(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
      }) as StoredTrackerEntry
      await database.trackerEntries.put(entry)
      const workspace = await database.workspaceMetadata.get('workspace')
      await queueSyncMutation(database, workspace?.userId ?? null, 'tracker_entry', entry)
      return entry
    })
  },

  async deleteTrackerEntry(trackerId: string, date: CalendarDate): Promise<void> {
    assertCalendarDate(date)
    const database = await openDatabase()
    await database.transaction('rw', [database.trackerEntries, database.syncOperations, database.syncRecords, database.workspaceMetadata], async () => {
      const entry = await database.trackerEntries.where('[trackerId+date]').equals([trackerId, date]).first()
      if (!entry || entry.deletedAt !== null) return
      const now = new Date().toISOString()
      const tombstone = { ...entry, updatedAt: now, deletedAt: now }
      await database.trackerEntries.put(tombstone)
      const workspace = await database.workspaceMetadata.get('workspace')
      await queueSyncMutation(database, workspace?.userId ?? null, 'tracker_entry', tombstone)
    })
  },

  async archiveTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    return database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.workspaceMetadata], async () => {
      const existing = await database.trackers.get(id)
      if (!existing || existing.deletedAt !== null) return undefined
      const now = new Date().toISOString()
      const archived: StoredTrackerDefinition = { ...existing, status: 'archived', archivedAt: now, updatedAt: now }
      await database.trackers.put(archived)
      const workspace = await database.workspaceMetadata.get('workspace')
      await queueSyncMutation(database, workspace?.userId ?? null, 'tracker', archived)
      return archived
    })
  },

  async listCategories(includeArchived = false): Promise<Category[]> {
    const database = await openDatabase()
    const categories = await database.categories.filter((category) => category.deletedAt === null).toArray()
    return categories
      .filter((category) => includeArchived || category.archivedAt === null)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  },

  async getDailyEntry(categoryId: string, date: CalendarDate): Promise<DailyEntry | undefined> {
    assertCalendarDate(date)
    const database = await openDatabase()
    const record = await database.dailyEntries.where('[categoryId+date]').equals([categoryId, date]).first()
    return record?.deletedAt === null ? record : undefined
  },

  async listEntriesBetween(startDate: CalendarDate, endDate: CalendarDate): Promise<DailyEntry[]> {
    assertDateRange(startDate, endDate)
    const database = await openDatabase()
    const records = await database.dailyEntries.where('date').between(startDate, endDate, true, true).toArray()
    return records.filter((record) => record.deletedAt === null)
  },

  async saveDailyEntry(draft: DailyEntryDraft): Promise<DailyEntry> {
    assertCalendarDate(draft.date)
    const database = await openDatabase()
    const now = new Date().toISOString()

    return database.transaction('rw', database.dailyEntries, async () => {
      const existing = await database.dailyEntries.where('[categoryId+date]').equals([draft.categoryId, draft.date]).first()
      const record: DailyEntry = {
        ...draft,
        id: existing?.id ?? newId(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
      }
      await database.dailyEntries.put(record)
      return record
    })
  },

  async listJournalsBetween(startDate: CalendarDate, endDate: CalendarDate): Promise<DailyJournal[]> {
    assertDateRange(startDate, endDate)
    const database = await openDatabase()
    const records = await database.dailyJournals.where('date').between(startDate, endDate, true, true).toArray()
    return records.filter((record) => record.deletedAt === null)
  },

  async saveDailyJournal(draft: DailyJournalDraft): Promise<DailyJournal> {
    assertCalendarDate(draft.date)
    const database = await openDatabase()
    const now = new Date().toISOString()
    return database.transaction('rw', database.dailyJournals, async () => {
      const existing = await database.dailyJournals.where('date').equals(draft.date).first()
      const record: DailyJournal = {
        ...draft,
        id: existing?.id ?? newId(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
      }
      await database.dailyJournals.put(record)
      return record
    })
  },

  async listGoals(includeArchived = false): Promise<Goal[]> {
    const database = await openDatabase()
    const goals = await database.goals.filter((goal) => goal.deletedAt === null).toArray()
    return goals.filter((goal) => includeArchived || goal.status !== 'archived')
  },
}
