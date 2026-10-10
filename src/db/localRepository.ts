import { openDatabase, queueSyncMutation } from './database'
import { assertCalendarDate, assertDateRange } from './calendarDate'
import type { AccountHoliday, AppNotification, AppSettings, CalendarDate, Category, DailyEntry, DailyEntryDraft, DailyJournal, DailyJournalDraft, Goal, HolidayReason, PermanentDeletionLedgerEntry, PermanentDeletionRequest, StoredTrackerDefinition, StoredTrackerEntry } from './models'
import { trackerDefinitionSchema, trackerEntrySchema, validateTrackerEntryValues } from '../domain/trackers/schema'
import { publishWorkspaceDataChange, publishWorkspaceMutation } from './workspaceMutationEvents'
import { isPermanentDeletionEnabled, isSchemaV3WriteEnabled, isSchemaV4WriteEnabled } from '../domain/trackers/schemaVersionGate'
import { assertHolidayDate, isHolidayReason } from '../domain/holidays'

function newId(): string {
  return crypto.randomUUID()
}

function publishNotificationChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('app-notifications-changed'))
}

function normalizeSettings(saved?: Partial<AppSettings>): AppSettings {
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  let timezone = saved?.timezone || deviceZone
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { timezone = deviceZone }
  const appearance = saved?.appearance === 'light' || saved?.appearance === 'dark' ? saved.appearance : 'system'
  return {
    id: 'general',
    timezone,
    appearance,
    backupReminderDays: Number.isInteger(saved?.backupReminderDays) && (saved?.backupReminderDays ?? 0) > 0 ? saved!.backupReminderDays! : null,
    updatedAt: typeof saved?.updatedAt === 'string' ? saved.updatedAt : new Date(0).toISOString(),
  }
}

export const localRepository = {
  async listAppNotifications(): Promise<AppNotification[]> {
    const database = await openDatabase()
    return (await database.appNotifications.orderBy('createdAt').reverse().limit(100).toArray())
  },

  async putAppNotification(notification: Omit<AppNotification, 'id' | 'createdAt' | 'readAt'> & { createdAt?: string }): Promise<AppNotification> {
    const database = await openDatabase()
    const existing = await database.appNotifications.where('identity').equals(notification.identity).first()
    const saved: AppNotification = { ...notification, id: existing?.id ?? newId(), createdAt: notification.createdAt ?? new Date().toISOString(), readAt: existing?.readAt ?? null }
    await database.appNotifications.put(saved)
    publishNotificationChange()
    return saved
  },

  async markAppNotificationRead(id: string): Promise<void> {
    const database = await openDatabase()
    const row = await database.appNotifications.get(id)
    if (row && !row.readAt) { await database.appNotifications.update(id, { readAt: new Date().toISOString() }); publishNotificationChange() }
  },

  async removeUnreadReminderNotifications(dates: readonly string[], keepIdentities: ReadonlySet<string>): Promise<string[]> {
    const database = await openDatabase()
    const rows = await database.appNotifications.filter((row) => (row.kind === 'pending' || row.kind === 'overdue') && dates.some((date) => row.identity.includes(`:${date}:`))).toArray()
    const stale = rows.filter((row) => !keepIdentities.has(row.identity))
    await database.appNotifications.bulkDelete(stale.filter((row) => !row.readAt).map((row) => row.id))
    if (stale.some((row) => !row.readAt)) publishNotificationChange()
    return stale.map((row) => row.identity)
  },

  async markAllAppNotificationsRead(): Promise<void> {
    const database = await openDatabase()
    const rows = await database.appNotifications.filter((row) => !row.readAt).toArray()
    const readAt = new Date().toISOString()
    await database.appNotifications.bulkPut(rows.map((row) => ({ ...row, readAt })))
    if (rows.length) publishNotificationChange()
  },

  async listAccountHolidays(startDate?: CalendarDate, endDate?: CalendarDate, includeDeleted = false): Promise<AccountHoliday[]> {
    const database = await openDatabase()
    let rows = startDate && endDate
      ? await database.accountHolidays.where('date').between(startDate, endDate, true, true).toArray()
      : await database.accountHolidays.toArray()
    if (!includeDeleted) rows = rows.filter((row) => row.deletedAt === null)
    return rows.sort((a, b) => a.date.localeCompare(b.date))
  },

  async saveAccountHolidays(dates: readonly CalendarDate[], reason: HolidayReason | null): Promise<AccountHoliday[]> {
    const uniqueDates = [...new Set(dates)].sort()
    for (const date of uniqueDates) assertHolidayDate(date)
    if (reason !== null && !isHolidayReason(reason)) throw new Error('Choose a supported holiday reason.')
    if (uniqueDates.length === 0) return []
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const saved = await database.transaction('rw', [database.accountHolidays, database.syncOperations, database.syncRecords, database.syncConflicts, database.workspaceMetadata], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      const output: AccountHoliday[] = []
      for (const date of uniqueDates) {
        const existing = await database.accountHolidays.where('date').equals(date).first()
        if (ownerUserId) {
          const conflict = await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'account_holiday', existing?.id ?? date]).first()
          if (conflict) throw new Error('Resolve this holiday’s cloud conflict before editing it. Both versions are preserved.')
        }
        const now = new Date().toISOString()
        const row: AccountHoliday = { id: existing?.id ?? newId(), date, reason, createdAt: existing?.createdAt ?? now, updatedAt: now, deletedAt: null }
        await database.accountHolidays.put(row)
        await queueSyncMutation(database, ownerUserId, 'account_holiday', row)
        output.push(row)
      }
      return output
    })
    publishWorkspaceMutation(ownerUserId)
    return saved
  },

  async removeAccountHoliday(date: CalendarDate): Promise<void> {
    const database = await openDatabase()
    let ownerUserId: string | null = null
    await database.transaction('rw', [database.accountHolidays, database.syncOperations, database.syncRecords, database.syncConflicts, database.workspaceMetadata], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      const existing = await database.accountHolidays.where('date').equals(date).first()
      if (!existing || existing.deletedAt !== null) return
      if (ownerUserId && await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'account_holiday', existing.id]).first()) throw new Error('Resolve this holiday’s cloud conflict before removing it. Both versions are preserved.')
      const row = { ...existing, updatedAt: new Date().toISOString(), deletedAt: new Date().toISOString() }
      await database.accountHolidays.put(row)
      await queueSyncMutation(database, ownerUserId, 'account_holiday', row)
    })
    publishWorkspaceMutation(ownerUserId)
  },

  async restoreAccountHoliday(date: CalendarDate): Promise<void> {
    const database = await openDatabase()
    let ownerUserId: string | null = null
    await database.transaction('rw', [database.accountHolidays, database.syncOperations, database.syncRecords, database.syncConflicts, database.workspaceMetadata], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      const existing = await database.accountHolidays.where('date').equals(date).first()
      if (!existing || existing.deletedAt === null) return
      if (ownerUserId && await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'account_holiday', existing.id]).first()) throw new Error('Resolve this holiday’s cloud conflict before restoring it. Both versions are preserved.')
      const row = { ...existing, updatedAt: new Date().toISOString(), deletedAt: null }
      await database.accountHolidays.put(row)
      await queueSyncMutation(database, ownerUserId, 'account_holiday', row)
    })
    publishWorkspaceMutation(ownerUserId)
  },

  async getAppSettings(expectedOwnerUserId?: string | null): Promise<AppSettings> {
    const database = await openDatabase()
    if (expectedOwnerUserId !== undefined) {
      const workspace = await database.workspaceMetadata.get('workspace')
      if (workspace?.userId !== expectedOwnerUserId) throw new Error('The active workspace changed while loading settings.')
    }
    // Normalize old/partial rows in memory so opening settings never rewrites legacy data.
    return normalizeSettings(await database.settings.get('general'))
  },

  async setTimeZone(timezone: string, expectedOwnerUserId: string | null = null): Promise<AppSettings> {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone })
    } catch {
      throw new Error('Choose a valid IANA time zone.')
    }
    const database = await openDatabase()
    return database.transaction('rw', [database.settings, database.workspaceMetadata], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      if (workspace?.userId !== expectedOwnerUserId) throw new Error('The active workspace changed. Reopen Settings and try again.')
      const current = normalizeSettings(await database.settings.get('general'))
      const next: AppSettings = { ...current, timezone, updatedAt: new Date().toISOString() }
      await database.settings.put(next)
      return next
    })
  },

  async setAppearance(appearance: AppSettings['appearance'], expectedOwnerUserId: string | null = null): Promise<AppSettings> {
    const database = await openDatabase()
    return database.transaction('rw', [database.settings, database.workspaceMetadata], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      if (workspace?.userId !== expectedOwnerUserId) throw new Error('The active workspace changed. Reopen Settings and try again.')
      const current = normalizeSettings(await database.settings.get('general'))
      const next: AppSettings = { ...current, appearance, updatedAt: new Date().toISOString() }
      await database.settings.put(next)
      return next
    })
  },

  async listTrackers(includeArchived = false): Promise<StoredTrackerDefinition[]> {
    const database = await openDatabase()
    const [allTrackers, verification, ledger] = await Promise.all([
      database.trackers.toArray(), database.trackerVerification.toArray(), database.permanentDeletionLedger.toArray(),
    ])
    const blockedIds = new Set([...ledger.map((row) => row.trackerId), ...(isPermanentDeletionEnabled() ? verification.map((row) => row.trackerId) : [])])
    const trackers = allTrackers.filter((tracker) => tracker.deletedAt === null && !blockedIds.has(tracker.id))
    return trackers
      .filter((tracker) => includeArchived || tracker.status !== 'archived')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
  },

  async getTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    const tracker = await database.trackers.get(id)
    const [verified, deleted] = await Promise.all([database.trackerVerification.get(id), database.permanentDeletionLedger.get(id)])
    return tracker?.deletedAt === null && !(isPermanentDeletionEnabled() && verified) && !deleted ? tracker : undefined
  },

  async listDeletedTrackers(): Promise<StoredTrackerDefinition[]> {
    const database = await openDatabase()
    return (await database.trackers.filter((tracker) => tracker.deletedAt !== null).toArray())
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
  },

  async saveTracker(draft: StoredTrackerDefinition): Promise<StoredTrackerDefinition> {
    if (draft.schemaVersion === 3 && !isSchemaV3WriteEnabled()) throw new Error('Schema v3 plan writes are disabled until the hosted migration is applied and verified.')
    if (draft.schemaVersion === 4 && !isSchemaV4WriteEnabled()) throw new Error('Precision settings need schema v4. Apply and verify migration 20261012000100_tracker_numeric_precision_v4.sql in Supabase, then enable VITE_ENABLE_TRACKER_SCHEMA_V4 for the production build. No tracker changes were saved.')
    const checked = trackerDefinitionSchema.safeParse(draft)
    if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'Tracker details are invalid.')
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const saved = await database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.syncConflicts, database.workspaceMetadata], async () => {
      const existing = await database.trackers.get(draft.id)
      if (existing?.deletedAt) throw new Error('Restore this tracker from the Bin before editing it.')
      const workspace = await database.workspaceMetadata.get('workspace')
      const activeOwner = workspace?.userId ?? null
      if (activeOwner) {
        const conflict = await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([activeOwner, 'tracker', draft.id]).first()
        if (conflict) throw new Error('Resolve this tracker’s cloud conflict before saving a plan. Both versions are preserved.')
      }
      const record: StoredTrackerDefinition = {
        ...draft,
        createdAt: existing?.createdAt ?? draft.createdAt,
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      }
      await database.trackers.put(record)
      ownerUserId = activeOwner
      await queueSyncMutation(database, ownerUserId, 'tracker', record)
      return record
    })
    publishWorkspaceMutation(ownerUserId)
    return saved
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
    let ownerUserId: string | null = null
    const saved = await database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.workspaceMetadata], async () => {
      const tracker = await database.trackers.get(draft.trackerId)
      if (!tracker || tracker.deletedAt !== null || tracker.status === 'archived') throw new Error('This tracker is not available for check-ins.')
      const existing = await database.trackerEntries.where('[trackerId+date]').equals([draft.trackerId, draft.date]).first()
      const valueIssue = validateTrackerEntryValues(tracker, draft.values, { existingValues: existing?.values })
      if (draft.outcome === 'recorded' && valueIssue) throw new Error(valueIssue)
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
      ownerUserId = workspace?.userId ?? null
      await queueSyncMutation(database, ownerUserId, 'tracker_entry', entry)
      return entry
    })
    publishWorkspaceMutation(ownerUserId)
    return saved
  },

  async deleteTrackerEntry(trackerId: string, date: CalendarDate): Promise<void> {
    assertCalendarDate(date)
    const database = await openDatabase()
    let ownerUserId: string | null = null
    await database.transaction('rw', [database.trackerEntries, database.syncOperations, database.syncRecords, database.workspaceMetadata], async () => {
      const entry = await database.trackerEntries.where('[trackerId+date]').equals([trackerId, date]).first()
      if (!entry || entry.deletedAt !== null) return
      const now = new Date().toISOString()
      const tombstone = { ...entry, updatedAt: now, deletedAt: now }
      await database.trackerEntries.put(tombstone)
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      await queueSyncMutation(database, ownerUserId, 'tracker_entry', tombstone)
    })
    publishWorkspaceMutation(ownerUserId)
  },

  async archiveTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const archived = await database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.workspaceMetadata], async () => {
      const existing = await database.trackers.get(id)
      if (!existing || existing.deletedAt !== null) return undefined
      const now = new Date().toISOString()
      const archived: StoredTrackerDefinition = { ...existing, status: 'archived', archivedAt: now, updatedAt: now }
      await database.trackers.put(archived)
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      await queueSyncMutation(database, ownerUserId, 'tracker', archived)
      return archived
    })
    publishWorkspaceMutation(ownerUserId)
    return archived
  },

  async unarchiveTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const restored = await database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.workspaceMetadata], async () => {
      const existing = await database.trackers.get(id)
      if (!existing || existing.deletedAt !== null || existing.status !== 'archived') return undefined
      const next: StoredTrackerDefinition = { ...existing, status: 'active', archivedAt: null, updatedAt: new Date().toISOString() }
      await database.trackers.put(next)
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      await queueSyncMutation(database, ownerUserId, 'tracker', next)
      return next
    })
    publishWorkspaceMutation(ownerUserId)
    return restored
  },

  async deleteTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const deleted = await database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.syncConflicts, database.workspaceMetadata], async () => {
      const existing = await database.trackers.get(id)
      if (!existing || existing.deletedAt !== null) return undefined
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      if (ownerUserId && await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'tracker', id]).first()) {
        throw new Error('Resolve this tracker’s cloud conflict before deleting it. Both versions are preserved.')
      }
      const now = new Date().toISOString()
      const tombstone = { ...existing, deletedAt: now, updatedAt: now }
      await database.trackers.put(tombstone)
      await queueSyncMutation(database, ownerUserId, 'tracker', tombstone)
      return tombstone
    })
    publishWorkspaceMutation(ownerUserId)
    return deleted
  },

  async restoreTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const restored = await database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.syncConflicts, database.workspaceMetadata, database.permanentDeletionLedger, database.trackerVerification], async () => {
      const existing = await database.trackers.get(id)
      if (!existing || existing.deletedAt === null) return undefined
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      if (await database.permanentDeletionLedger.get(id)) throw new Error('This tracker was permanently deleted from the account and cannot be restored.')
      if (!ownerUserId && Date.now() >= Date.parse(existing.deletedAt) + 30 * 24 * 60 * 60 * 1000) throw new Error('The recovery period has ended. This guest copy is eligible for local cleanup.')
      if (ownerUserId && await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'tracker', id]).first()) {
        throw new Error('Resolve this tracker’s cloud conflict before restoring it. Both versions are preserved.')
      }
      const next = { ...existing, deletedAt: null, updatedAt: new Date().toISOString() }
      await database.trackers.put(next)
      if (ownerUserId && isPermanentDeletionEnabled()) await database.trackerVerification.put({ trackerId: id, status: 'pending-server-check' })
      await queueSyncMutation(database, ownerUserId, 'tracker', next)
      return next
    })
    publishWorkspaceMutation(ownerUserId)
    return restored
  },

  async requestPermanentDeletion(id: string): Promise<'queued' | 'deleted'> {
    const database = await openDatabase()
    const workspace = await database.workspaceMetadata.get('workspace')
    const ownerUserId = workspace?.userId ?? null
    if (!ownerUserId) {
      await database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncConflicts], async () => {
        const tracker = await database.trackers.get(id)
        if (!tracker?.deletedAt) throw new Error('Move this tracker to the Bin before permanently deleting it.')
        await database.trackerEntries.where('trackerId').equals(id).delete()
        await database.trackers.delete(id)
        await database.syncOperations.where('entityId').equals(id).delete()
        await database.syncConflicts.where('entityId').equals(id).delete()
      })
      publishWorkspaceDataChange(null)
      return 'deleted'
    }
    await database.transaction('rw', [database.trackers, database.permanentDeletionRequests, database.workspaceMetadata], async () => {
      const currentWorkspace = await database.workspaceMetadata.get('workspace')
      if (currentWorkspace?.userId !== ownerUserId) throw new Error('The active account changed. Reopen the Bin and try again.')
      const tracker = await database.trackers.get(id)
      if (!tracker?.deletedAt) throw new Error('Move this tracker to the Bin before permanently deleting it.')
      const existing = await database.permanentDeletionRequests.where('[ownerUserId+trackerId]').equals([ownerUserId, id]).first()
      if (!existing) await database.permanentDeletionRequests.add({ id: newId(), ownerUserId, trackerId: id, requestedAt: new Date().toISOString(), status: 'pending', lastError: null })
      else if (existing.status !== 'pending') await database.permanentDeletionRequests.put({ ...existing, requestedAt: new Date().toISOString(), status: 'pending', lastError: null })
    })
    publishWorkspaceMutation(ownerUserId)
    return 'queued'
  },

  async listPermanentDeletionRequests(ownerUserId: string): Promise<PermanentDeletionRequest[]> {
    const database = await openDatabase()
    return database.permanentDeletionRequests.where('ownerUserId').equals(ownerUserId).toArray()
  },

  async reconcilePermanentDeletionLedger(ownerUserId: string, rows: Array<{ tracker_id: string; permanently_deleted_at: string }>): Promise<void> {
    const database = await openDatabase()
    let workspaceChanged = false
    await database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts, database.permanentDeletionRequests, database.permanentDeletionLedger, database.trackerVerification, database.workspaceMetadata], async () => {
      const metadata = await database.workspaceMetadata.get('workspace')
      if (metadata?.userId !== ownerUserId) throw new Error('The active workspace changed during deletion reconciliation.')
      const authoritativeIds = new Set(rows.map((row) => row.tracker_id))
      const existingLedger = await database.permanentDeletionLedger.where('ownerUserId').equals(ownerUserId).toArray()
      workspaceChanged = existingLedger.length !== rows.length || rows.some((row) => {
        const existing = existingLedger.find((item) => item.trackerId === row.tracker_id)
        return !existing || existing.permanentlyDeletedAt !== row.permanently_deleted_at
      })
      await database.permanentDeletionLedger.clear()
      for (const verification of await database.trackerVerification.toArray()) {
        if (authoritativeIds.has(verification.trackerId)) continue
        const pendingRestoreOrImport = await database.syncOperations.where('[ownerUserId+entity+entityId]')
          .equals([ownerUserId, 'tracker', verification.trackerId]).first()
        if (!pendingRestoreOrImport) await database.trackerVerification.delete(verification.trackerId)
      }
      for (const row of rows) {
        const trackerId = row.tracker_id
        const key = `${ownerUserId}:${trackerId}`
        const children = await database.trackerEntries.where('trackerId').equals(trackerId).toArray()
        if (children.length > 0 || await database.trackers.get(trackerId)) workspaceChanged = true
        const childIds = new Set(children.map((entry) => entry.id))
        const ledger: PermanentDeletionLedgerEntry = { key, ownerUserId, trackerId, permanentlyDeletedAt: row.permanently_deleted_at }
        await database.permanentDeletionLedger.put(ledger)
        await database.trackers.delete(trackerId)
        await database.trackerEntries.where('trackerId').equals(trackerId).delete()
        await database.syncOperations.where('ownerUserId').equals(ownerUserId).filter((item) =>
          (item.entity === 'tracker' && item.entityId === trackerId)
          || (item.entity === 'tracker_entry' && (item.payload as StoredTrackerEntry | undefined)?.trackerId === trackerId),
        ).delete()
        await database.syncRecords.where('ownerUserId').equals(ownerUserId).filter((item) =>
          (item.entity === 'tracker' && item.entityId === trackerId)
          || (item.entity === 'tracker_entry' && childIds.has(item.entityId)),
        ).delete()
        await database.syncConflicts.where('ownerUserId').equals(ownerUserId).filter((item) =>
          (item.entity === 'tracker' && item.entityId === trackerId)
          || (item.entity === 'tracker_entry' && (item.localPayload as StoredTrackerEntry).trackerId === trackerId),
        ).delete()
        await database.permanentDeletionRequests.where('[ownerUserId+trackerId]').equals([ownerUserId, trackerId]).delete()
        await database.trackerVerification.delete(trackerId)
      }
    })
    if (workspaceChanged) publishWorkspaceDataChange(ownerUserId)
  },

  /** Apply one deletion confirmed by the server without treating it as a full ledger scan. */
  async recordPermanentDeletionConfirmation(ownerUserId: string, row: { tracker_id: string; permanently_deleted_at: string }): Promise<void> {
    const database = await openDatabase()
    const trackerId = row.tracker_id
    await database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts, database.permanentDeletionRequests, database.permanentDeletionLedger, database.trackerVerification, database.workspaceMetadata], async () => {
      const metadata = await database.workspaceMetadata.get('workspace')
      if (metadata?.userId !== ownerUserId) throw new Error('The active workspace changed during deletion confirmation.')
      const children = await database.trackerEntries.where('trackerId').equals(trackerId).toArray()
      const childIds = new Set(children.map((entry) => entry.id))
      await database.permanentDeletionLedger.put({ key: `${ownerUserId}:${trackerId}`, ownerUserId, trackerId, permanentlyDeletedAt: row.permanently_deleted_at })
      await database.trackers.delete(trackerId)
      await database.trackerEntries.where('trackerId').equals(trackerId).delete()
      await database.syncOperations.where('ownerUserId').equals(ownerUserId).filter((item) =>
        (item.entity === 'tracker' && item.entityId === trackerId)
        || (item.entity === 'tracker_entry' && (item.payload as StoredTrackerEntry | undefined)?.trackerId === trackerId),
      ).delete()
      await database.syncRecords.where('ownerUserId').equals(ownerUserId).filter((item) =>
        (item.entity === 'tracker' && item.entityId === trackerId)
        || (item.entity === 'tracker_entry' && childIds.has(item.entityId)),
      ).delete()
      await database.syncConflicts.where('ownerUserId').equals(ownerUserId).filter((item) =>
        (item.entity === 'tracker' && item.entityId === trackerId)
        || (item.entity === 'tracker_entry' && (item.localPayload as StoredTrackerEntry).trackerId === trackerId),
      ).delete()
      await database.permanentDeletionRequests.where('[ownerUserId+trackerId]').equals([ownerUserId, trackerId]).delete()
      await database.trackerVerification.delete(trackerId)
    })
    publishWorkspaceDataChange(ownerUserId)
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
