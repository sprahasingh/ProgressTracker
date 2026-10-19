import { openDatabase, queueSyncMutation } from './database'
import { assertCalendarDate, assertDateRange, calendarDateInTimeZone } from './calendarDate'
import type { AccountHoliday, AppNotification, AppSettings, CalendarDate, Category, DailyEntry, DailyEntryDraft, DailyJournal, DailyJournalDraft, Goal, HolidayReason, HolidayPermanentDeletionLedgerEntry, HolidayPermanentDeletionRequest, LocalMotivationMessage, LocalNotificationPreferences, PendingTrackerRestore, PermanentDeletionLedgerEntry, PermanentDeletionRequest, StoredTrackerDefinition, StoredTrackerEntry, TrackerWinsRetention } from './models'
import { trackerDefinitionSchema, trackerEntrySchema, validateTrackerEntryValues } from '../domain/trackers/schema'
import { trackerDefinitionForDate } from '../domain/trackers/ruleVersions'
import { publishWorkspaceDataChange, publishWorkspaceMutation } from './workspaceMutationEvents'
import { migrateLegacyRejectedConflicts } from './legacySyncRejections'
import { measureDevPerformance } from '../utils/devPerformance'
import { isHolidayPermanentDeletionEnabled, isPermanentDeletionEnabled, isSchemaV3WriteEnabled, isSchemaV4WriteEnabled, isSchemaV5WriteEnabled, isSchemaV6WriteEnabled, isSchemaV7WriteEnabled, isSchemaV8WriteEnabled, isSchemaV9WriteEnabled, isSchemaV10WriteEnabled, isTrackerEditHistorySyncGuardEnabled } from '../domain/trackers/schemaVersionGate'
import { assertHolidayDate, isHolidayReason } from '../domain/holidays'
import { historicalCustomFieldMeaningChange, historicalMetricMeaningChange, retiredCustomFieldMeaningChange, retiredMetricMeaningChange, trackerMetricTypeChange } from '../domain/trackers/invariants'
import { activeTrackerMetrics } from '../domain/trackers/types'
import { currentRuleDependencyIssue, historicalRuleDependencyIssue } from '../domain/trackers/historicalDependencies'
import { deriveSchedulingDeadline, schedulingMode } from '../domain/trackers/scheduling'
import { publishPermanentDeletionNotification } from '../services/permanentDeletionNotifications'
import { publishHolidayDeletionNotification } from '../services/holidayDeletionNotifications'

function newId(): string {
  return crypto.randomUUID()
}

function permanentDeletionKey(ownerUserId: string, trackerId: string): string {
  return `${ownerUserId}:${trackerId}`
}

async function retainDeletedTrackerOperationDiagnostics(
  database: Awaited<ReturnType<typeof openDatabase>>,
  ownerUserId: string,
  trackerId: string,
  entryIds: ReadonlySet<string>,
  deletionRequestId: string,
): Promise<void> {
  const operations = await database.syncOperations.where('ownerUserId').equals(ownerUserId).filter((operation) =>
    (operation.entity === 'tracker' && operation.entityId === trackerId)
    || (operation.entity === 'tracker_entry' && entryIds.has(operation.entityId)),
  ).toArray()
  const supersededAt = new Date().toISOString()
  for (const operation of operations) {
    await database.syncOperations.put({
      ...operation,
      payload: undefined,
      status: 'superseded',
      supersededAt: operation.supersededAt ?? supersededAt,
      supersededByDeletionRequestId: operation.supersededByDeletionRequestId ?? deletionRequestId,
      lastError: operation.lastError ?? 'Superseded by permanent tracker deletion; saved payload was removed after server confirmation.',
    })
  }
}

async function assertTrackerVerificationComplete(database: Awaited<ReturnType<typeof openDatabase>>, ownerUserId: string | null, trackerId: string): Promise<void> {
  if (ownerUserId && isPermanentDeletionEnabled() && await database.trackerVerification.get(trackerId)) {
    throw new Error('This tracker is waiting for server confirmation and cannot be changed yet.')
  }
}

async function resolveTrackersScheduling(database: Awaited<ReturnType<typeof openDatabase>>, trackers: StoredTrackerDefinition[]): Promise<StoredTrackerDefinition[]> {
  if (!trackers.some((tracker) => schedulingMode(tracker) === 'effective')) return trackers
  const [holidays, settings] = await Promise.all([database.accountHolidays.toArray(), database.settings.get('general')])
  const activeHolidays = new Set(holidays.filter((holiday) => holiday.deletedAt === null).map((holiday) => holiday.date))
  const defaultTimeZone = normalizeSettings(settings).timezone
  return trackers.map((tracker) => {
    if (schedulingMode(tracker) !== 'effective') return tracker
    const timeZone = tracker.scheduling?.planningTimeZone ?? defaultTimeZone
    const deadline = deriveSchedulingDeadline({ tracker, holidays: activeHolidays, timeZone })
    return { ...tracker, deadline }
  })
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
  async getNotificationPreferences(): Promise<LocalNotificationPreferences | undefined> {
    const database = await openDatabase()
    return database.notificationPreferences.get('account')
  },

  async saveNotificationPreferences(preferences: Omit<LocalNotificationPreferences, 'id' | 'updatedAt' | 'syncPending'>, syncPending = true): Promise<LocalNotificationPreferences> {
    const database = await openDatabase()
    const row: LocalNotificationPreferences = { ...preferences, id: 'account', updatedAt: new Date().toISOString(), syncPending }
    await database.notificationPreferences.put(row)
    return row
  },

  async markNotificationPreferencesSynced(): Promise<void> {
    const database = await openDatabase()
    await database.notificationPreferences.update('account', { syncPending: false })
  },

  async listCustomMotivationMessages(): Promise<LocalMotivationMessage[]> {
    const database = await openDatabase()
    return database.customMotivationMessages.orderBy('updatedAt').toArray()
  },

  async saveCustomMotivationMessage(message: Omit<LocalMotivationMessage, 'updatedAt' | 'syncPending'>, syncPending = true): Promise<LocalMotivationMessage> {
    const database = await openDatabase()
    const row = { ...message, updatedAt: new Date().toISOString(), syncPending }
    await database.customMotivationMessages.put(row)
    return row
  },

  async markCustomMotivationMessageSynced(id: string): Promise<void> {
    const database = await openDatabase()
    await database.customMotivationMessages.update(id, { syncPending: false })
  },

  async deleteCustomMotivationMessage(id: string): Promise<void> {
    const database = await openDatabase()
    const existing = await database.customMotivationMessages.get(id)
    if (existing) await database.customMotivationMessages.put({ ...existing, deleted: true, syncPending: true, updatedAt: new Date().toISOString() })
  },

  async deleteSyncedCustomMotivationMessage(id: string): Promise<void> {
    const database = await openDatabase()
    const existing = await database.customMotivationMessages.get(id)
    if (existing?.deleted) await database.customMotivationMessages.delete(id)
  },

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

  async updateAccountHoliday(id: string, date: CalendarDate, reason: HolidayReason | null): Promise<AccountHoliday> {
    assertHolidayDate(date)
    if (reason !== null && !isHolidayReason(reason)) throw new Error('Choose a supported holiday reason.')
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const saved = await database.transaction('rw', [database.accountHolidays, database.syncOperations, database.syncRecords, database.syncConflicts, database.workspaceMetadata], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      const existing = await database.accountHolidays.get(id)
      if (!existing || existing.deletedAt !== null) throw new Error('This holiday is no longer available to edit.')
      const duplicate = await database.accountHolidays.where('date').equals(date).first()
      if (duplicate && duplicate.id !== id) throw new Error('A holiday record already exists on that date.')
      if (ownerUserId && await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'account_holiday', id]).first()) throw new Error('Resolve this holiday’s cloud conflict before editing it. Both versions are preserved.')
      const row: AccountHoliday = { ...existing, date, reason, updatedAt: new Date().toISOString() }
      await database.accountHolidays.put(row)
      await queueSyncMutation(database, ownerUserId, 'account_holiday', row)
      return row
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
    await database.transaction('rw', [database.accountHolidays, database.syncOperations, database.syncRecords, database.syncConflicts, database.holidayPermanentDeletionRequests, database.holidayPermanentDeletionLedger, database.workspaceMetadata], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      const existing = await database.accountHolidays.where('date').equals(date).first()
      if (!existing || existing.deletedAt === null) return
      if (!ownerUserId && Date.parse(existing.deletedAt) <= Date.now() - 30 * 24 * 60 * 60 * 1000) throw new Error('The holiday recovery period has ended.')
      if (ownerUserId && await database.holidayPermanentDeletionLedger.get(`${ownerUserId}:${existing.id}`)) throw new Error('This holiday was permanently deleted from the account and cannot be restored.')
      if (ownerUserId && await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'account_holiday', existing.id]).first()) throw new Error('Resolve this holiday’s cloud conflict before restoring it. Both versions are preserved.')
      const row = { ...existing, updatedAt: new Date().toISOString(), deletedAt: null }
      await database.accountHolidays.put(row)
      if (ownerUserId) await database.holidayPermanentDeletionRequests.where('[ownerUserId+holidayId]').equals([ownerUserId, existing.id]).delete()
      await queueSyncMutation(database, ownerUserId, 'account_holiday', row)
    })
    publishWorkspaceMutation(ownerUserId)
  },

  async requestPermanentHolidayDeletion(date: CalendarDate): Promise<'queued' | 'deleted'> {
    if (!isHolidayPermanentDeletionEnabled()) throw new Error('Permanent holiday deletion is unavailable until the server safeguards are enabled.')
    const database = await openDatabase()
    let ownerUserId: string | null = null
    let result: 'queued' | 'deleted' = 'deleted'
    await database.transaction('rw', [database.accountHolidays, database.syncOperations, database.syncConflicts, database.holidayPermanentDeletionRequests, database.workspaceMetadata], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      const existing = await database.accountHolidays.where('date').equals(date).first()
      if (!existing || existing.deletedAt === null) throw new Error('Move this holiday to Recently removed before deleting it permanently.')
      if (!ownerUserId) {
        await database.accountHolidays.delete(existing.id)
        return
      }
      if (await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'account_holiday', existing.id]).first()) {
        throw new Error('Resolve this holiday’s cloud conflict before deleting it permanently. Both versions are preserved.')
      }
      const prior = await database.holidayPermanentDeletionRequests.where('[ownerUserId+holidayId]').equals([ownerUserId, existing.id]).first()
      if (!prior) await database.holidayPermanentDeletionRequests.add({ id: newId(), ownerUserId, holidayId: existing.id, holidayDate: date, requestedAt: new Date().toISOString(), status: 'pending', lastError: null })
      else if (prior.status !== 'pending') await database.holidayPermanentDeletionRequests.put({ ...prior, requestedAt: new Date().toISOString(), status: 'pending', lastError: null })
      result = 'queued'
    })
    publishWorkspaceMutation(ownerUserId)
    return result
  },

  async listPermanentHolidayDeletionRequests(ownerUserId: string): Promise<HolidayPermanentDeletionRequest[]> {
    const database = await openDatabase()
    return database.holidayPermanentDeletionRequests.where('ownerUserId').equals(ownerUserId).toArray()
  },

  async recordPermanentHolidayDeletionConfirmation(ownerUserId: string, row: { holiday_id: string; permanently_deleted_at: string }): Promise<void> {
    await this.reconcilePermanentHolidayDeletionLedger(ownerUserId, [row])
  },

  async reconcilePermanentHolidayDeletionLedger(ownerUserId: string, rows: Array<{ holiday_id: string; permanently_deleted_at: string }>): Promise<void> {
    const database = await openDatabase()
    let changed = false
    const confirmed: Array<{ holidayId: string; holidayDate: string }> = []
    await database.transaction('rw', [database.accountHolidays, database.syncOperations, database.syncRecords, database.syncConflicts, database.holidayPermanentDeletionRequests, database.holidayPermanentDeletionLedger, database.workspaceMetadata], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      if (workspace?.userId !== ownerUserId) throw new Error('The active workspace changed during holiday deletion reconciliation.')
      for (const row of rows) {
        const key = `${ownerUserId}:${row.holiday_id}`
        const ledger: HolidayPermanentDeletionLedgerEntry = { key, ownerUserId, holidayId: row.holiday_id, permanentlyDeletedAt: row.permanently_deleted_at }
        await database.holidayPermanentDeletionLedger.put(ledger)
        const holiday = await database.accountHolidays.get(row.holiday_id)
        const request = await database.holidayPermanentDeletionRequests.where('[ownerUserId+holidayId]').equals([ownerUserId, row.holiday_id]).first()
        if (request) confirmed.push({ holidayId: row.holiday_id, holidayDate: holiday?.date ?? request.holidayDate })
        changed ||= Boolean(holiday)
        await database.accountHolidays.delete(row.holiday_id)
        await database.syncOperations.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'account_holiday', row.holiday_id]).delete()
        await database.syncRecords.delete(`account_holiday:${row.holiday_id}`)
        await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'account_holiday', row.holiday_id]).delete()
        await database.holidayPermanentDeletionRequests.where('[ownerUserId+holidayId]').equals([ownerUserId, row.holiday_id]).delete()
      }
    })
    if (changed) publishWorkspaceDataChange(ownerUserId)
    for (const item of confirmed) {
      publishHolidayDeletionNotification({ status: 'queued', ownerUserId, ...item })
      publishHolidayDeletionNotification({ status: 'confirmed', ownerUserId, ...item })
    }
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
    const trackers = await resolveTrackersScheduling(database, allTrackers.filter((tracker) => tracker.deletedAt === null && !blockedIds.has(tracker.id)))
    return trackers
      .filter((tracker) => includeArchived || tracker.status !== 'archived')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
  },

  async getTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    const tracker = await database.trackers.get(id)
    const workspace = await database.workspaceMetadata.get('workspace')
    const [verified, deleted] = await Promise.all([
      database.trackerVerification.get(id),
      workspace?.userId ? database.permanentDeletionLedger.get(permanentDeletionKey(workspace.userId, id)) : Promise.resolve(undefined),
    ])
    if (tracker?.deletedAt !== null || !tracker || isPermanentDeletionEnabled() && verified || deleted) return undefined
    return (await resolveTrackersScheduling(database, [tracker]))[0]
  },

  async listDeletedTrackers(): Promise<StoredTrackerDefinition[]> {
    const database = await openDatabase()
    const [trackers, ledger, verification] = await Promise.all([
      database.trackers.filter((tracker) => tracker.deletedAt !== null).toArray(),
      database.permanentDeletionLedger.toArray(),
      isPermanentDeletionEnabled() ? database.trackerVerification.toArray() : Promise.resolve([]),
    ])
    const blockedIds = new Set([...ledger.map((row) => row.trackerId), ...verification.map((row) => row.trackerId)])
    return trackers.filter((tracker) => !blockedIds.has(tracker.id))
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
  },

  async listPendingTrackerRestores(ownerUserId: string): Promise<PendingTrackerRestore[]> {
    if (!isPermanentDeletionEnabled()) return []
    const database = await openDatabase()
    const workspace = await database.workspaceMetadata.get('workspace')
    if (workspace?.userId !== ownerUserId) return []
    const [markers, trackers, operations, conflicts, ledger, syncRecords] = await Promise.all([
      database.trackerVerification.toArray(), database.trackers.toArray(),
      database.syncOperations.where('ownerUserId').equals(ownerUserId).toArray(),
      database.syncConflicts.where('ownerUserId').equals(ownerUserId).toArray(),
      database.permanentDeletionLedger.where('ownerUserId').equals(ownerUserId).toArray(),
      database.syncRecords.where('ownerUserId').equals(ownerUserId).toArray(),
    ])
    const trackerById = new Map(trackers.map((tracker) => [tracker.id, tracker]))
    const operationById = new Map(operations.filter((operation) => operation.entity === 'tracker').map((operation) => [operation.entityId, operation]))
    const conflictById = new Map(conflicts.filter((conflict) => conflict.entity === 'tracker').map((conflict) => [conflict.entityId, conflict]))
    const permanentlyDeleted = new Set(ledger.map((entry) => entry.trackerId))
    const serverKnownTrackers = new Set(syncRecords.filter((record) => record.entity === 'tracker').map((record) => record.entityId))
    const pending: PendingTrackerRestore[] = []
    for (const marker of markers) {
      // Pre-purpose restore markers can be recognized when the account already
      // had a server revision. Imported copies use new IDs and have no revision.
      const isRestore = marker.purpose === 'restore' || (!marker.purpose && serverKnownTrackers.has(marker.trackerId))
      if (!isRestore || permanentlyDeleted.has(marker.trackerId)) continue
      const tracker = trackerById.get(marker.trackerId)
      if (!tracker || tracker.deletedAt !== null) continue
      const operation = operationById.get(marker.trackerId)
      const conflict = conflictById.get(marker.trackerId)
      if (conflict || operation?.status === 'conflict') {
        pending.push({ tracker, status: 'attention', message: conflict?.reason ?? operation?.lastError ?? 'The server could not confirm this restoration. Review the sync conflict in Account.' })
      } else if (operation?.status === 'blocked') {
        pending.push({ tracker, status: 'attention', message: operation.lastError ?? 'The server rejected this restoration. Review the blocked sync operation in Account.' })
      } else if (operation?.lastError) {
        pending.push({ tracker, status: 'pending', message: `Restoration is saved on this device and will retry when sync is available. ${operation.lastError}` })
      } else {
        pending.push({ tracker, status: 'pending', message: 'Restoration is waiting for server confirmation. This tracker stays unavailable until the server confirms it.' })
      }
    }
    return pending.sort((a, b) => b.tracker.updatedAt.localeCompare(a.tracker.updatedAt) || a.tracker.name.localeCompare(b.tracker.name))
  },

  async saveTracker(draft: StoredTrackerDefinition): Promise<StoredTrackerDefinition> {
    if (draft.schemaVersion === 10 && !isSchemaV10WriteEnabled()) throw new Error('Versioned tracker rules need schema v10. Apply and verify the tracker rule history migration, then enable VITE_ENABLE_TRACKER_SCHEMA_V10 for the production build. No tracker changes were saved.')
    if (draft.schemaVersion === 8 && !isSchemaV8WriteEnabled()) throw new Error('Custom streak rules need schema v8. Apply and verify migration 20261111000100_tracker_streak_rules_v8.sql, then enable VITE_ENABLE_TRACKER_SCHEMA_V8 for the production build. No tracker changes were saved.')
    if (draft.schemaVersion === 9 && !isSchemaV9WriteEnabled()) throw new Error('Typed milestones need schema v9. Apply and verify the tracker milestone migration, then enable VITE_ENABLE_TRACKER_SCHEMA_V9 for the production build. No tracker changes were saved.')
    if (draft.schemaVersion === 7 && !isSchemaV7WriteEnabled()) throw new Error('Effective Days counting needs schema v7. Apply and verify migration 20261109000100_tracker_effective_day_counting_v7.sql, then enable VITE_ENABLE_TRACKER_SCHEMA_V7 for the production build. No tracker changes were saved.')
    if (draft.schemaVersion === 6 && !isSchemaV6WriteEnabled()) throw new Error('Unified scheduling needs schema v6. Apply and verify migration 20261108000100_tracker_scheduling_v6.sql in Supabase, then enable VITE_ENABLE_TRACKER_SCHEMA_V6 for the production build. No tracker changes were saved.')
    if (draft.schemaVersion === 3 && !isSchemaV3WriteEnabled()) throw new Error('Schema v3 plan writes are disabled until the hosted migration is applied and verified.')
    if (draft.schemaVersion === 4 && !isSchemaV4WriteEnabled()) throw new Error('Precision settings need schema v4. Apply and verify migration 20261012000100_tracker_numeric_precision_v4.sql in Supabase, then enable VITE_ENABLE_TRACKER_SCHEMA_V4 for the production build. No tracker changes were saved.')
    if (draft.schemaVersion === 5 && !isSchemaV5WriteEnabled()) throw new Error('Separate manual goal allocations need schema v5. Apply and verify migration 20261107000100_tracker_manual_goal_allocations_v5.sql in Supabase, then enable VITE_ENABLE_TRACKER_SCHEMA_V5 for the production build. No tracker changes were saved.')
    const checked = trackerDefinitionSchema.safeParse(draft)
    if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'Tracker details are invalid.')
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const saved = await database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts, database.workspaceMetadata, database.settings, database.permanentDeletionLedger, database.trackerVerification], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      const activeOwner = workspace?.userId ?? null
      await assertTrackerVerificationComplete(database, activeOwner, draft.id)
      if (activeOwner && await database.permanentDeletionLedger.get(permanentDeletionKey(activeOwner, draft.id))) {
        throw new Error('This tracker was permanently deleted from the account and cannot be changed or restored.')
      }
      const existing = await database.trackers.get(draft.id)
      if (existing?.deletedAt) throw new Error('Restore this tracker from the Bin before editing it.')
      if (existing) {
        if (stableCustomFieldConfiguration(existing.customFields) !== stableCustomFieldConfiguration(draft.customFields)) {
          throw new Error('Custom-field definitions cannot be edited because their historical availability is not saved.')
        }
        if (draft.schemaVersion === 10 && draft.ruleVersions?.at(-1)?.historyPolicy && !isTrackerEditHistorySyncGuardEnabled()) {
          throw new Error('Safe tracker history edits need migration 20261119000100_tracker_edit_sync_guards.sql and VITE_ENABLE_TRACKER_EDIT_SYNC_GUARDS=true in this production build. No tracker changes were saved.')
        }
        const savedEntries = await database.trackerEntries.where('[trackerId+date]').between([draft.id, '0000-01-01'], [draft.id, '9999-12-31']).toArray()
        if (existing.schemaVersion === 10 && stableTrackerJson(existing.metrics) !== stableTrackerJson(draft.metrics)
          && existing.ruleVersions?.at(-1)?.id === draft.ruleVersions?.at(-1)?.id) {
          throw new Error('Measure configuration changes need a confirmed effective date. Existing measure snapshots cannot be changed in place.')
        }
        const historyTimeZone = normalizeSettings(await database.settings.get('general')).timezone
        assertRuleHistoryTransition(existing, draft, savedEntries, historyTimeZone)
        if (stableTrackerJson(existing.milestones) !== stableTrackerJson(draft.milestones)) {
          throw new Error('Milestone requirements cannot be edited because historical milestone results are not versioned.')
        }
        const latestSavedDate = savedEntries.filter((entry) => entry.deletedAt === null)
          .reduce<string | null>((latest, entry) => latest === null || entry.date > latest ? entry.date : latest, null)
        const proposedHead = draft.ruleVersions?.at(-1)?.effectiveFrom
        const nextRuleHead = draft.ruleVersions?.at(-1)
        const sameDayCompatibleRuleEdit = nextRuleHead?.historyPolicy === 'apply-from-today'
          && proposedHead !== undefined
          && proposedHead === calendarDateInTimeZone(new Date(), normalizeSettings(await database.settings.get('general')).timezone)
          && latestSavedDate === proposedHead
          && stableTrackerJson(existing.metrics) === stableTrackerJson(draft.metrics)
          && stableTrackerJson(existing.customFields) === stableTrackerJson(draft.customFields)
        if (proposedHead && existing.ruleVersions?.at(-1)?.id !== nextRuleHead?.id && latestSavedDate && proposedHead <= latestSavedDate
          && nextRuleHead?.application !== 'recalculate-all-history' && !sameDayCompatibleRuleEdit) {
          throw new Error('A check-in was saved on or after the confirmed effective date. Review the latest check-in and confirm a new date before saving these changes.')
        }
        if (activeTrackerMetrics(existing.metrics).length > 0 && activeTrackerMetrics(draft.metrics).length === 0) throw new Error('Keep at least one active measure so this tracker can record future check-ins.')
        const metricsChanged = JSON.stringify(existing.metrics) !== JSON.stringify(draft.metrics)
        const customFieldsChanged = JSON.stringify(existing.customFields) !== JSON.stringify(draft.customFields)
        if (metricsChanged || customFieldsChanged) {
          const history = await database.trackerEntries.where('[trackerId+date]').between([draft.id, '0000-01-01'], [draft.id, '9999-12-31']).toArray()
          const historicalKeys = new Set(history.flatMap((entry) => Object.keys(entry.values)))
          if (metricsChanged) {
            const changedType = trackerMetricTypeChange(existing, draft)
            if (changedType) throw new Error(`The measure type for “${changedType}” can’t be changed for an existing measure. Retire it and add a new measure to record a different value type.`)
            const historicalMetricIds = new Set(existing.metrics.filter((metric) => historicalKeys.has(metric.id)).map((metric) => metric.id))
            const changedRetiredMeaning = retiredMetricMeaningChange(existing, draft)
            if (changedRetiredMeaning) throw new Error(`The retired measure “${changedRetiredMeaning}” must stay in the tracker with its original definition so its history keeps its meaning.`)
            const changedHistoricalMeaning = historicalMetricMeaningChange(existing, draft, historicalMetricIds)
            if (changedHistoricalMeaning) throw new Error(`“${changedHistoricalMeaning}” has saved check-ins. Its name, type, unit, and interpretation must stay the same; retire it and add a new measure to change how you track it.`)
          }
          if (customFieldsChanged) {
            const historicalFieldIds = new Set(existing.customFields.filter((field) => historicalKeys.has(`field:${field.id}`)).map((field) => field.id))
            const changedRetiredMeaning = retiredCustomFieldMeaningChange(existing, draft)
            if (changedRetiredMeaning) throw new Error(`The retired custom field “${changedRetiredMeaning}” must stay in the tracker with its original definition so its history keeps its meaning.`)
            const changedHistoricalMeaning = historicalCustomFieldMeaningChange(existing, draft, historicalFieldIds)
            if (changedHistoricalMeaning) throw new Error(`“${changedHistoricalMeaning}” has saved check-in values. Keep its name, type, unit, options, and required setting; retire it and add a new field to change how you capture this detail.`)
          }
        }
      }
      if (activeOwner) {
        await migrateLegacyRejectedConflicts(database, activeOwner)
        const conflict = await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([activeOwner, 'tracker', draft.id]).first()
        if (conflict) throw new Error('Resolve this tracker’s cloud conflict before saving a plan. Both versions are preserved.')
      }
      if (existing?.kind === 'goal' && (existing.schemaVersion === 10 || draft.schemaVersion === 10)
        && stableTrackerJson(existing.goalPlanning ?? null) !== stableTrackerJson(draft.goalPlanning ?? null)) {
        throw new Error('Goal plans cannot be edited because historical goal progress is not versioned.')
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

  async listAllTrackerEntries(): Promise<StoredTrackerEntry[]> {
    const database = await openDatabase()
    return (await database.trackerEntries.toArray()).filter((entry) => entry.deletedAt === null)
  },

  async listTrackerEntriesForTracker(trackerId: string): Promise<StoredTrackerEntry[]> {
    const database = await openDatabase()
    return (await database.trackerEntries.where('[trackerId+date]').between([trackerId, '0000-01-01'], [trackerId, '9999-12-31']).toArray()).filter((entry) => entry.deletedAt === null)
  },

  async listTrackerHistoricalValueKeys(trackerId: string): Promise<string[]> {
    const database = await openDatabase()
    const entries = await database.trackerEntries.where('[trackerId+date]').between([trackerId, '0000-01-01'], [trackerId, '9999-12-31']).toArray()
    return [...new Set(entries.flatMap((entry) => Object.keys(entry.values)))]
  },

  async getTrackerEntry(trackerId: string, date: CalendarDate): Promise<StoredTrackerEntry | undefined> {
    assertCalendarDate(date)
    const database = await openDatabase()
    const entry = await database.trackerEntries.where('[trackerId+date]').equals([trackerId, date]).first()
    return entry?.deletedAt === null ? entry : undefined
  },

  async saveTrackerEntry(draft: Omit<StoredTrackerEntry, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>): Promise<StoredTrackerEntry> {
    const measure = measureDevPerformance('check-in.local-persist-and-notify')
    assertCalendarDate(draft.date)
    const checked = trackerEntrySchema.safeParse({ ...draft, id: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null })
    if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'Check-in details are invalid.')
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const saved = await database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.workspaceMetadata, database.permanentDeletionLedger, database.trackerVerification, database.settings], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      const activeOwner = workspace?.userId ?? null
      // Keep the offline write boundary aligned with the selected workspace
      // timezone. Supabase independently enforces this against its clock when
      // the operation syncs; this check gives offline users immediate feedback.
      const timeZone = normalizeSettings(await database.settings.get('general')).timezone
      if (draft.date > calendarDateInTimeZone(new Date(), timeZone)) {
        throw new Error('You can only record check-ins for today or earlier.')
      }
      await assertTrackerVerificationComplete(database, activeOwner, draft.trackerId)
      const tracker = await database.trackers.get(draft.trackerId)
      if (!tracker || tracker.deletedAt !== null || tracker.status === 'archived') throw new Error('This tracker is not available for check-ins.')
      if (activeOwner && await database.permanentDeletionLedger.get(permanentDeletionKey(activeOwner, draft.trackerId))) {
        throw new Error('This tracker was permanently deleted from the account and cannot receive check-ins.')
      }
      const existing = await database.trackerEntries.where('[trackerId+date]').equals([draft.trackerId, draft.date]).first()
      const valueIssue = validateTrackerEntryValues(trackerDefinitionForDate(tracker, draft.date), draft.values, { existingValues: existing?.values })
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
      ownerUserId = activeOwner
      await queueSyncMutation(database, ownerUserId, 'tracker_entry', entry)
      return entry
    })
    publishWorkspaceMutation(ownerUserId)
    measure()
    return saved
  },

  async deleteTrackerEntry(trackerId: string, date: CalendarDate): Promise<void> {
    assertCalendarDate(date)
    const database = await openDatabase()
    let ownerUserId: string | null = null
    await database.transaction('rw', [database.trackerEntries, database.syncOperations, database.syncRecords, database.workspaceMetadata, database.trackerVerification], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      await assertTrackerVerificationComplete(database, ownerUserId, trackerId)
      const entry = await database.trackerEntries.where('[trackerId+date]').equals([trackerId, date]).first()
      if (!entry || entry.deletedAt !== null) return
      const now = new Date().toISOString()
      const tombstone = { ...entry, updatedAt: now, deletedAt: now }
      await database.trackerEntries.put(tombstone)
      await queueSyncMutation(database, ownerUserId, 'tracker_entry', tombstone)
    })
    publishWorkspaceMutation(ownerUserId)
  },

  async archiveTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const archived = await database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.workspaceMetadata, database.trackerVerification], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      await assertTrackerVerificationComplete(database, ownerUserId, id)
      const existing = await database.trackers.get(id)
      if (!existing || existing.deletedAt !== null) return undefined
      const now = new Date().toISOString()
      const archived: StoredTrackerDefinition = { ...existing, status: 'archived', archivedAt: now, updatedAt: now }
      await database.trackers.put(archived)
      await queueSyncMutation(database, ownerUserId, 'tracker', archived)
      return archived
    })
    publishWorkspaceMutation(ownerUserId)
    return archived
  },

  async unarchiveTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const restored = await database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.workspaceMetadata, database.trackerVerification], async () => {
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      await assertTrackerVerificationComplete(database, ownerUserId, id)
      const existing = await database.trackers.get(id)
      if (!existing || existing.deletedAt !== null || existing.status !== 'archived') return undefined
      const next: StoredTrackerDefinition = { ...existing, status: 'active', archivedAt: null, updatedAt: new Date().toISOString() }
      await database.trackers.put(next)
      await queueSyncMutation(database, ownerUserId, 'tracker', next)
      return next
    })
    publishWorkspaceMutation(ownerUserId)
    return restored
  },

  async deleteTracker(id: string): Promise<StoredTrackerDefinition | undefined> {
    const database = await openDatabase()
    let ownerUserId: string | null = null
    const deleted = await database.transaction('rw', [database.trackers, database.syncOperations, database.syncRecords, database.syncConflicts, database.workspaceMetadata, database.trackerVerification], async () => {
      const existing = await database.trackers.get(id)
      if (!existing || existing.deletedAt !== null) return undefined
      const workspace = await database.workspaceMetadata.get('workspace')
      ownerUserId = workspace?.userId ?? null
      await assertTrackerVerificationComplete(database, ownerUserId, id)
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
      if (ownerUserId && await database.permanentDeletionLedger.get(permanentDeletionKey(ownerUserId, id))) throw new Error('This tracker was permanently deleted from the account and cannot be restored.')
      await assertTrackerVerificationComplete(database, ownerUserId, id)
      if (!ownerUserId && Date.now() >= Date.parse(existing.deletedAt) + 30 * 24 * 60 * 60 * 1000) throw new Error('The recovery period has ended. This guest copy is eligible for local cleanup.')
      if (ownerUserId && await database.syncConflicts.where('[ownerUserId+entity+entityId]').equals([ownerUserId, 'tracker', id]).first()) {
        throw new Error('Resolve this tracker’s cloud conflict before restoring it. Both versions are preserved.')
      }
      const next = { ...existing, deletedAt: null, updatedAt: new Date().toISOString() }
      await database.trackers.put(next)
      if (ownerUserId && isPermanentDeletionEnabled()) await database.trackerVerification.put({ trackerId: id, status: 'pending-server-check', purpose: 'restore' })
      await queueSyncMutation(database, ownerUserId, 'tracker', next)
      return next
    })
    publishWorkspaceMutation(ownerUserId)
    return restored
  },

  async requestPermanentDeletion(id: string, winsRetention: TrackerWinsRetention): Promise<'queued' | 'deleted'> {
    const database = await openDatabase()
    const workspace = await database.workspaceMetadata.get('workspace')
    const ownerUserId = workspace?.userId ?? null
    if (!ownerUserId) {
      await database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts], async () => {
        const tracker = await database.trackers.get(id)
        if (!tracker?.deletedAt) throw new Error('Move this tracker to the Bin before permanently deleting it.')
        const entries = await database.trackerEntries.where('trackerId').equals(id).toArray()
        const entryIds = new Set(entries.map((entry) => entry.id))
        await database.trackerEntries.where('trackerId').equals(id).delete()
        await database.trackers.delete(id)
        await database.syncOperations.filter((operation) =>
          (operation.entity === 'tracker' && operation.entityId === id)
          || (operation.entity === 'tracker_entry' && (operation.payload as StoredTrackerEntry | undefined)?.trackerId === id),
        ).delete()
        await database.syncRecords.filter((record) =>
          (record.entity === 'tracker' && record.entityId === id)
          || (record.entity === 'tracker_entry' && entryIds.has(record.entityId)),
        ).delete()
        await database.syncConflicts.filter((conflict) =>
          (conflict.entity === 'tracker' && conflict.entityId === id)
          || (conflict.entity === 'tracker_entry' && (conflict.localPayload as StoredTrackerEntry).trackerId === id),
        ).delete()
      })
      publishWorkspaceDataChange(null)
      return 'deleted'
    }
    let trackerName = id
    await database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.permanentDeletionRequests, database.workspaceMetadata], async () => {
      const currentWorkspace = await database.workspaceMetadata.get('workspace')
      if (currentWorkspace?.userId !== ownerUserId) throw new Error('The active account changed. Reopen the Bin and try again.')
      const tracker = await database.trackers.get(id)
      if (!tracker?.deletedAt) throw new Error('Move this tracker to the Bin before permanently deleting it.')
      trackerName = tracker.name
      const existing = await database.permanentDeletionRequests.where('[ownerUserId+trackerId]').equals([ownerUserId, id]).first()
      if (existing?.winsRetention && existing.winsRetention !== winsRetention) throw new Error('This tracker already has a confirmed deletion request with a different Wins choice. Its original choice is preserved.')
      const deletionRequest = existing ?? { id: newId(), ownerUserId, trackerId: id, requestedAt: new Date().toISOString(), status: 'pending' as const, lastError: null, winsRetention }
      await database.permanentDeletionRequests.put({ ...deletionRequest, status: 'pending', lastError: null, winsRetention: deletionRequest.winsRetention ?? winsRetention })
      const entries = await database.trackerEntries.where('trackerId').equals(id).toArray()
      const entryIds = new Set(entries.map((entry) => entry.id))
      const related = await database.syncOperations.where('ownerUserId').equals(ownerUserId).filter((operation) =>
        (operation.entity === 'tracker' && operation.entityId === id)
        || (operation.entity === 'tracker_entry' && (entryIds.has(operation.entityId) || (operation.payload as StoredTrackerEntry | undefined)?.trackerId === id)),
      ).toArray()
      const supersededAt = new Date().toISOString()
      for (const operation of related) {
        if (operation.status === 'superseded' || operation.status === 'discarded') continue
        await database.syncOperations.put({ ...operation, status: 'superseded', supersededAt, supersededByDeletionRequestId: deletionRequest.id, lastError: 'Superseded by the confirmed permanent deletion request; this operation cannot be replayed.' })
      }
    })
    publishPermanentDeletionNotification({ status: 'queued', ownerUserId, trackerId: id, trackerName })
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
    const confirmedRequests: Array<{ trackerId: string; trackerName: string }> = []
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
        const request = await database.permanentDeletionRequests.where('[ownerUserId+trackerId]').equals([ownerUserId, trackerId]).first()
        if (request) confirmedRequests.push({ trackerId, trackerName: (await database.trackers.get(trackerId))?.name ?? trackerId })
        const key = `${ownerUserId}:${trackerId}`
        const children = await database.trackerEntries.where('trackerId').equals(trackerId).toArray()
        if (children.length > 0 || await database.trackers.get(trackerId)) workspaceChanged = true
        const childIds = new Set(children.map((entry) => entry.id))
        await retainDeletedTrackerOperationDiagnostics(database, ownerUserId, trackerId, childIds, request?.id ?? `server-deletion:${trackerId}`)
        const ledger: PermanentDeletionLedgerEntry = { key, ownerUserId, trackerId, permanentlyDeletedAt: row.permanently_deleted_at }
        await database.permanentDeletionLedger.put(ledger)
        await database.trackers.delete(trackerId)
        await database.trackerEntries.where('trackerId').equals(trackerId).delete()
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
    for (const request of confirmedRequests) publishPermanentDeletionNotification({ status: 'confirmed', ownerUserId, ...request })
  },

  /** Apply one deletion confirmed by the server without treating it as a full ledger scan. */
  async recordPermanentDeletionConfirmation(ownerUserId: string, row: { tracker_id: string; permanently_deleted_at: string }): Promise<void> {
    const database = await openDatabase()
    const trackerId = row.tracker_id
    let confirmedRequestName: string | null = null
    await database.transaction('rw', [database.trackers, database.trackerEntries, database.syncOperations, database.syncRecords, database.syncConflicts, database.permanentDeletionRequests, database.permanentDeletionLedger, database.trackerVerification, database.workspaceMetadata], async () => {
      const metadata = await database.workspaceMetadata.get('workspace')
      if (metadata?.userId !== ownerUserId) throw new Error('The active workspace changed during deletion confirmation.')
      const request = await database.permanentDeletionRequests.where('[ownerUserId+trackerId]').equals([ownerUserId, trackerId]).first()
      if (request) confirmedRequestName = (await database.trackers.get(trackerId))?.name ?? trackerId
      const children = await database.trackerEntries.where('trackerId').equals(trackerId).toArray()
      const childIds = new Set(children.map((entry) => entry.id))
      await retainDeletedTrackerOperationDiagnostics(database, ownerUserId, trackerId, childIds, request?.id ?? `server-deletion:${trackerId}`)
      await database.permanentDeletionLedger.put({ key: `${ownerUserId}:${trackerId}`, ownerUserId, trackerId, permanentlyDeletedAt: row.permanently_deleted_at })
      await database.trackers.delete(trackerId)
      await database.trackerEntries.where('trackerId').equals(trackerId).delete()
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
    if (confirmedRequestName) publishPermanentDeletionNotification({ status: 'confirmed', ownerUserId, trackerId, trackerName: confirmedRequestName })
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

function stableTrackerJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : item
  return JSON.stringify(sort(value))
}

function stableCustomFieldConfiguration(fields: StoredTrackerDefinition['customFields']): string {
  return stableTrackerJson([...fields]
    .sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')))
    .map((field) => Object.fromEntries(Object.entries(field).filter(([key]) => key !== 'position'))))
}

function assertRuleHistoryTransition(
  before: StoredTrackerDefinition,
  after: StoredTrackerDefinition,
  entries: StoredTrackerEntry[],
  timeZone: string,
): void {
  if (after.schemaVersion !== 10 || !after.ruleVersions?.length) return
  if (before.schemaVersion !== 10 || !before.ruleVersions?.length) {
    if (after.ruleVersions.at(-1)?.historyPolicy === 'recalculate-all-history') {
      throw new Error('Historical measure settings can’t be verified. Choose a forward effective date instead.')
    }
    return
  }
  const previousHead = before.ruleVersions.at(-1)!
  const nextHead = after.ruleVersions.at(-1)!
  if (previousHead.id === nextHead.id) {
    if (stableTrackerJson(before.ruleVersions) !== stableTrackerJson(after.ruleVersions)) {
      throw new Error('Saved tracker history snapshots cannot be edited in place. Add a newly confirmed effective date instead.')
    }
    return
  }
  const policy = nextHead.historyPolicy
  if (!policy) throw new Error('Confirm a tracker history policy before saving a new rule version.')
  const currentDependencyIssue = currentRuleDependencyIssue(nextHead.evaluation)
  if (currentDependencyIssue) throw new Error(`${currentDependencyIssue} Choose a measure available on the effective date.`)
  if (policy === 'recalculate-all-history') {
    const affectedStartDate = before.startDate ?? calendarDateInTimeZone(new Date(before.createdAt), timeZone)
    const dependencyIssue = historicalRuleDependencyIssue(before, after, affectedStartDate)
    if (dependencyIssue) throw new Error(`${dependencyIssue} Choose a forward effective date instead.`)
    const structuralSettingsChanged = stableTrackerJson([
      before.schedule, before.startDate, before.deadline, before.scheduling, before.metrics, before.customFields, before.milestones,
    ]) !== stableTrackerJson([
      after.schedule, after.startDate, after.deadline, after.scheduling, after.metrics, after.customFields, after.milestones,
    ])
    const missingHistoryInput = entries.some((entry) => entry.outcome === 'recorded'
      && trackerMetricIdsForDate(after, entry.date).some((metricId) => !Object.hasOwn(entry.values, metricId)))
    if (structuralSettingsChanged || missingHistoryInput) {
      throw new Error('All-history recalculation is unsafe for this saved configuration or history. Choose a forward effective date instead.')
    }
    return
  }
  const expectedPrior = before.ruleVersions.filter((version) => version.effectiveFrom < nextHead.effectiveFrom)
  const proposedPrior = after.ruleVersions.filter((version) => version.effectiveFrom < nextHead.effectiveFrom)
  if (stableTrackerJson(expectedPrior) !== stableTrackerJson(proposedPrior)) {
    throw new Error('Existing historical rule snapshots must remain unchanged. Choose a later effective date or resolve the saved history first.')
  }
}

function trackerMetricIdsForDate(tracker: StoredTrackerDefinition, date: string): string[] {
  const evaluation = tracker.ruleVersions?.filter((version) => version.effectiveFrom <= date).at(-1)?.evaluation
  return (evaluation?.metrics ?? tracker.metrics).filter((metric) => metric.retiredAt === undefined).map((metric) => metric.id)
}
