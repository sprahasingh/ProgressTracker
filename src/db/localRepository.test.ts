import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateWorkspace, db, queueSyncMutation } from './database'
import { localRepository } from './localRepository'
import { subscribeToWorkspaceMutations } from './workspaceMutationEvents'
import type { StoredTrackerDefinition } from './models'

const tracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'local-event-tracker', name: 'Local event test', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [], customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}
const plannedGoal: StoredTrackerDefinition = {
  ...tracker, id: 'local-planned-goal', kind: 'goal', schemaVersion: 2,
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', minimum: 2, target: 5, stretch: 8, streakQualification: 'minimum' } }],
  goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: { pages: 3 }, cumulativeTargets: { pages: 100 } },
  deadline: '2026-12-31',
}

afterEach(async () => {
  vi.unstubAllEnvs()
  db.close()
  await db.delete()
})

describe('workspace mutation notifications', () => {
  it('keeps archived history readable but prevents check-in edits until unarchived', async () => {
    await activateWorkspace('archive-edit-owner')
    const definition = { ...tracker, metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }] }
    await localRepository.saveTracker(definition)
    const entry = await localRepository.saveTrackerEntry({ trackerId: definition.id, date: '2026-10-10', outcome: 'recorded', values: { done: true }, note: 'preserved' })

    await localRepository.archiveTracker(definition.id)

    await expect(localRepository.listTrackers(true)).resolves.toMatchObject([{ status: 'archived' }])
    await expect(localRepository.getTrackerEntry(definition.id, '2026-10-10')).resolves.toMatchObject({ id: entry.id, values: { done: true }, note: 'preserved' })
    await expect(localRepository.saveTrackerEntry({ trackerId: definition.id, date: entry.date, outcome: 'recorded', values: { done: false }, note: 'should not overwrite' })).rejects.toThrow(/not available for check-ins/)
    await expect(db.trackerEntries.get(entry.id)).resolves.toMatchObject({ values: { done: true }, note: 'preserved' })

    await localRepository.unarchiveTracker(definition.id)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: entry.date, outcome: 'recorded', values: { done: false }, note: 'edited after restore' })
    await expect(db.trackerEntries.get(entry.id)).resolves.toMatchObject({ id: entry.id, values: { done: false }, note: 'edited after restore' })
  })

  it('keeps retired measure definitions and old values while rejecting type changes to saved IDs', async () => {
    await activateWorkspace('retired-measure-owner')
    const original: StoredTrackerDefinition = { ...tracker, metrics: [
      { id: 'focus', name: 'Focus', valueType: 'quantity', unit: 'minutes' },
      { id: 'done', name: 'Done', valueType: 'boolean' },
    ] }
    await localRepository.saveTracker(original)
    const entry = await localRepository.saveTrackerEntry({ trackerId: original.id, date: '2026-10-10', outcome: 'recorded', values: { focus: 30, done: true }, note: '' })
    const retired = { ...original, metrics: [{ ...original.metrics[0]!, retiredAt: '2026-10-11T00:00:00.000Z' }, original.metrics[1]!] }
    await localRepository.saveTracker(retired)
    await expect(localRepository.listTrackerEntriesForTracker(original.id)).resolves.toMatchObject([{ id: entry.id, values: { focus: 30, done: true } }])
    await expect(localRepository.saveTracker({ ...retired, metrics: [{ ...retired.metrics[0]!, valueType: 'duration' }, retired.metrics[1]!] })).rejects.toThrow(/measure type.*can’t be changed/i)
    await expect(localRepository.saveTracker({ ...retired, metrics: [retired.metrics[1]!] })).rejects.toThrow(/original definition/i)
    const extended = { ...retired, metrics: [...retired.metrics, { id: 'new', name: 'New', valueType: 'quantity' as const }] }
    await expect(localRepository.saveTracker(extended)).resolves.toMatchObject({ metrics: [{ retiredAt: expect.any(String) }, {}, { id: 'new' }] })
  })

  it('keeps notification preferences and custom messages isolated per account workspace', async () => {
    await activateWorkspace('notification-prefs-a')
    await localRepository.saveNotificationPreferences({ enabled: true, daily_enabled: true, daily_times: ['09:00'], overdue_enabled: false, overdue_times: ['10:00'], remind_partial: false, motivation_mode: 'off', motivation_times: ['18:00'], motivation_weekdays: [1], timezone: 'Asia/Kolkata', quiet_start: null, quiet_end: null, allow_overdue_during_quiet: false, daily_limit: 4, motivation_daily_limit: 1, tracker_ids: null })
    await localRepository.saveCustomMotivationMessage({ id: 'message-a', message: 'Keep going', enabled: true, deleted: false })
    await activateWorkspace('notification-prefs-b')
    await expect(localRepository.getNotificationPreferences()).resolves.toBeUndefined()
    await expect(localRepository.listCustomMotivationMessages()).resolves.toEqual([])
    await activateWorkspace('notification-prefs-a')
    await expect(localRepository.getNotificationPreferences()).resolves.toMatchObject({ enabled: true, timezone: 'Asia/Kolkata' })
    await expect(localRepository.listCustomMotivationMessages()).resolves.toMatchObject([{ id: 'message-a', message: 'Keep going' }])
  })

  it('upserts notification identities and preserves unread state on replacement', async () => {
    await activateWorkspace('notification-owner')
    const original = await localRepository.putAppNotification({ identity: 'daily-reminder:2026-10-10:16:00', kind: 'pending', title: '2 check-ins waiting', body: 'Review today', href: '/' })
    await localRepository.markAppNotificationRead(original.id)
    const replacement = await localRepository.putAppNotification({ identity: original.identity, kind: 'pending', title: '1 check-in waiting', body: 'Updated after progress', href: '/?focus=t1' })
    expect(replacement.id).toBe(original.id)
    expect(replacement.readAt).toEqual(expect.any(String))
    expect(await localRepository.listAppNotifications()).toHaveLength(1)
    await localRepository.markAllAppNotificationsRead()
    expect(await localRepository.listAppNotifications()).toMatchObject([{ readAt: expect.any(String) }])
    await activateWorkspace('notification-owner-b')
    await expect(localRepository.listAppNotifications()).resolves.toEqual([])
  })

  it('restores an archived tracker and queues the active state for synchronization', async () => {
    await activateWorkspace('archive-owner')
    await localRepository.saveTracker({ ...tracker, status: 'archived', archivedAt: '2026-10-01T12:00:00.000Z' })

    await expect(localRepository.unarchiveTracker(tracker.id)).resolves.toMatchObject({ status: 'active', archivedAt: null })
    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ status: 'active', archivedAt: null })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['archive-owner', 'tracker', tracker.id]).first()).resolves.toMatchObject({ payload: { status: 'active', archivedAt: null } })
  })

  it('keeps account holidays isolated and atomically queues upsert, removal, and restoration', async () => {
    await activateWorkspace('holiday-account-a')
    const [holiday] = await localRepository.saveAccountHolidays(['2026-10-10', '2026-10-11'], 'travel')
    expect(holiday).toMatchObject({ date: '2026-10-10', reason: 'travel', deletedAt: null })
    expect(await db.accountHolidays.count()).toBe(2)
    expect(await db.syncOperations.where('ownerUserId').equals('holiday-account-a').count()).toBe(2)
    await localRepository.removeAccountHoliday('2026-10-10')
    await expect(db.accountHolidays.get(holiday!.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['holiday-account-a', 'account_holiday', holiday!.id]).first()).resolves.toMatchObject({ payload: { deletedAt: expect.any(String) } })
    await localRepository.restoreAccountHoliday('2026-10-10')
    await expect(db.accountHolidays.get(holiday!.id)).resolves.toMatchObject({ deletedAt: null, reason: 'travel' })
    await activateWorkspace('holiday-account-b')
    await expect(localRepository.listAccountHolidays()).resolves.toEqual([])
  })

  it('edits an account holiday date and reason in place and queues one revisioned sync mutation', async () => {
    await activateWorkspace('holiday-edit-owner')
    const [holiday] = await localRepository.saveAccountHolidays(['2026-10-10'], 'travel')
    if (!holiday) throw new Error('Holiday was not saved.')
    await db.syncRecords.put({ key: `account_holiday:${holiday.id}`, ownerUserId: 'holiday-edit-owner', entity: 'account_holiday', entityId: holiday.id, serverRevision: 3 })

    const updated = await localRepository.updateAccountHoliday(holiday.id, '2026-10-12', 'exam')

    expect(updated).toMatchObject({ id: holiday.id, date: '2026-10-12', reason: 'exam', deletedAt: null })
    await expect(db.accountHolidays.count()).resolves.toBe(1)
    await expect(db.accountHolidays.get(holiday.id)).resolves.toMatchObject({ id: holiday.id, date: '2026-10-12', reason: 'exam' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['holiday-edit-owner', 'account_holiday', holiday.id]).first()).resolves.toMatchObject({ expectedRevision: 3, payload: { id: holiday.id, date: '2026-10-12', reason: 'exam' } })
  })

  it('rejects an occupied holiday date without changing the source holiday', async () => {
    await activateWorkspace('holiday-duplicate-owner')
    const [first, second] = await localRepository.saveAccountHolidays(['2026-10-10', '2026-10-11'], 'travel')
    if (!first || !second) throw new Error('Holidays were not saved.')
    await expect(localRepository.updateAccountHoliday(first.id, second.date, 'exam')).rejects.toThrow('A holiday record already exists on that date.')
    await expect(db.accountHolidays.get(first.id)).resolves.toMatchObject({ date: first.date, reason: 'travel' })
  })

  it('queues account holiday permanent deletion idempotently and keeps the tombstone until server confirmation', async () => {
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'true')
    await activateWorkspace('holiday-delete-owner')
    const [holiday] = await localRepository.saveAccountHolidays(['2026-10-14'], 'exam')
    if (!holiday) throw new Error('Holiday was not saved.')
    await localRepository.removeAccountHoliday(holiday.date)

    await expect(localRepository.requestPermanentHolidayDeletion(holiday.date)).resolves.toBe('queued')
    await expect(localRepository.requestPermanentHolidayDeletion(holiday.date)).resolves.toBe('queued')
    await expect(db.accountHolidays.get(holiday.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })
    await expect(db.holidayPermanentDeletionRequests.where('[ownerUserId+holidayId]').equals(['holiday-delete-owner', holiday.id]).count()).resolves.toBe(1)
    await activateWorkspace('holiday-delete-other-owner')
    await expect(localRepository.listPermanentHolidayDeletionRequests('holiday-delete-other-owner')).resolves.toEqual([])
  })

  it('permanently removes a guest holiday only after the local action is explicitly requested', async () => {
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'true')
    await activateWorkspace(null)
    const [holiday] = await localRepository.saveAccountHolidays(['2026-10-15'], null)
    if (!holiday) throw new Error('Holiday was not saved.')
    await localRepository.removeAccountHoliday(holiday.date)
    await expect(db.accountHolidays.get(holiday.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })

    await expect(localRepository.requestPermanentHolidayDeletion(holiday.date)).resolves.toBe('deleted')
    await expect(db.accountHolidays.get(holiday.id)).resolves.toBeUndefined()
  })

  it('persists version 2 planning configuration unchanged in IndexedDB and its account outbox', async () => {
    await activateWorkspace('planning-account')
    await localRepository.saveTracker(plannedGoal)

    await expect(db.trackers.get(plannedGoal.id)).resolves.toMatchObject({
      schemaVersion: 2,
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: { pages: 3 }, cumulativeTargets: { pages: 100 } },
      metrics: [{ thresholds: { minimum: 2, target: 5, stretch: 8 } }],
    })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['planning-account', 'tracker', plannedGoal.id]).first()).resolves.toMatchObject({
      payload: { schemaVersion: 2, goalPlanning: { cumulativeTargets: { pages: 100 } } },
    })
  })

  it('atomically persists v3 allocations, timezone, and the matching sync outbox payload', async () => {
    await activateWorkspace('planning-v3-account')
    const v3: StoredTrackerDefinition = {
      ...plannedGoal, schemaVersion: 3,
      goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'Asia/Kolkata', allocations: { pages: { '2026-10-09': 4 } } },
    }
    await localRepository.saveTracker(v3)
    await expect(db.trackers.get(v3.id)).resolves.toMatchObject({ schemaVersion: 3, goalPlanning: v3.goalPlanning })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['planning-v3-account', 'tracker', v3.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 3, goalPlanning: v3.goalPlanning } })
  })

  it('persists only manual v5 dates alongside a conflict-safe tracker sync payload', async () => {
    await activateWorkspace('planning-v5-account')
    const v5: StoredTrackerDefinition = {
      ...plannedGoal, schemaVersion: 5,
      goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'Asia/Kolkata', allocations: {}, manualAllocations: { pages: { '2026-10-09': 30 } } },
    }
    await localRepository.saveTracker(v5)
    await expect(db.trackers.get(v5.id)).resolves.toMatchObject({ schemaVersion: 5, goalPlanning: { manualAllocations: { pages: { '2026-10-09': 30 } } } })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['planning-v5-account', 'tracker', v5.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 5, goalPlanning: { allocations: {}, manualAllocations: { pages: { '2026-10-09': 30 } } } } })
  })

  it('round-trips v6 scheduling and resolves its deadline again whenever holidays change', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', 'true')
    await activateWorkspace('scheduling-v6-account')
    const effective: StoredTrackerDefinition = {
      ...tracker, id: 'effective-habit', schemaVersion: 6, startDate: '2026-11-01', schedule: { kind: 'weekdays' }, deadline: '2026-11-30',
      scheduling: { mode: 'effective', effectiveDays: 30, planningTimeZone: 'UTC' },
    }
    await localRepository.saveTracker(effective)
    expect(await localRepository.getTracker(effective.id)).toMatchObject({ schemaVersion: 6, scheduling: effective.scheduling, deadline: '2026-11-30' })
    await localRepository.saveAccountHolidays(['2026-11-08', '2026-11-15'], null)
    expect(await localRepository.getTracker(effective.id)).toMatchObject({ deadline: '2026-12-02' })
    await localRepository.removeAccountHoliday('2026-11-08')
    expect(await localRepository.getTracker(effective.id)).toMatchObject({ deadline: '2026-12-01' })
    await localRepository.removeAccountHoliday('2026-11-15')
    expect(await localRepository.listTrackers()).toMatchObject([{ id: effective.id, deadline: '2026-11-30', scheduling: effective.scheduling }])
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['scheduling-v6-account', 'tracker', effective.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 6, scheduling: effective.scheduling } })
  })

  it('does not queue schema v6 trackers in production while the readiness flag is off', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', '')
    await activateWorkspace('scheduling-v6-disabled-account')
    const effective: StoredTrackerDefinition = {
      ...tracker, id: 'disabled-effective-habit', schemaVersion: 6, startDate: '2026-10-12', deadline: '2026-10-14',
      scheduling: { mode: 'effective', effectiveDays: 3, planningTimeZone: 'UTC' },
    }
    await expect(queueSyncMutation(db, 'scheduling-v6-disabled-account', 'tracker', effective)).rejects.toThrow(/Schema v6 scheduling local and cloud writes are disabled/)
    await expect(db.syncOperations.count()).resolves.toBe(0)
  })

  it('blocks local v3 persistence in production when migration readiness is not enabled', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V3', '')
    await activateWorkspace(null)
    const v3: StoredTrackerDefinition = {
      ...plannedGoal, schemaVersion: 3,
      goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'UTC', allocations: { pages: { '2026-10-09': 4 } } },
    }
    await expect(localRepository.saveTracker(v3)).rejects.toThrow(/disabled until the hosted migration/)
    await expect(db.trackers.get(v3.id)).resolves.toBeUndefined()
    await expect(db.syncOperations.count()).resolves.toBe(0)
  })

  it('preserves a tracker conflict instead of silently replacing its pending operation with a plan edit', async () => {
    await activateWorkspace('planning-conflict-account')
    await localRepository.saveTracker(plannedGoal)
    const operation = await db.syncOperations.where('ownerUserId').equals('planning-conflict-account').first()
    await db.syncConflicts.put({ id: operation!.id, ownerUserId: 'planning-conflict-account', entity: 'tracker', entityId: plannedGoal.id, localPayload: plannedGoal, remoteRecord: null, detectedAt: new Date().toISOString() })
    const v3 = { ...plannedGoal, schemaVersion: 3 as const, goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'UTC', allocations: { pages: { '2026-10-09': 2 } } } }
    await expect(localRepository.saveTracker(v3)).rejects.toThrow(/Resolve this tracker’s cloud conflict/)
    await expect(db.trackers.get(plannedGoal.id)).resolves.toMatchObject({ schemaVersion: 2 })
    await expect(db.syncConflicts.get(operation!.id)).resolves.toBeDefined()
  })

  it('publishes an account owner only after its local record and outbox transaction commits', async () => {
    await activateWorkspace('mutation-account')
    const owners: Array<string | null> = []
    const unsubscribe = subscribeToWorkspaceMutations((ownerId) => owners.push(ownerId))
    try {
      await localRepository.saveTracker(tracker)
      expect(owners).toEqual(['mutation-account'])
      await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: tracker.name })
      await expect(db.syncOperations.where('ownerUserId').equals('mutation-account').count()).resolves.toBe(1)
    } finally {
      unsubscribe()
    }
  })

  it('publishes guest workspace edits for local views without treating them as account sync', async () => {
    await activateWorkspace(null)
    const owners: Array<string | null> = []
    const unsubscribe = subscribeToWorkspaceMutations((ownerId) => owners.push(ownerId))
    try {
      await localRepository.saveTracker(tracker)
      expect(owners).toEqual([null])
      await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: tracker.name })
    } finally {
      unsubscribe()
    }
  })

  it('publishes check-in and tombstone edits for the account that owns the workspace', async () => {
    await activateWorkspace('entry-owner')
    await localRepository.saveTracker(tracker)
    const owners: Array<string | null> = []
    const unsubscribe = subscribeToWorkspaceMutations((ownerId) => owners.push(ownerId))
    try {
      await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-09', outcome: 'skipped', values: {}, note: 'rest day' })
      await localRepository.deleteTrackerEntry(tracker.id, '2026-10-09')
      expect(owners).toEqual(['entry-owner', 'entry-owner'])
      await expect(db.trackerEntries.where('[trackerId+date]').equals([tracker.id, '2026-10-09']).first()).resolves.toMatchObject({ deletedAt: expect.any(String) })
      await expect(db.syncOperations.where('ownerUserId').equals('entry-owner').count()).resolves.toBe(2)
    } finally {
      unsubscribe()
    }
  })

  it('revives a cleared date when the user records it again without creating a duplicate row', async () => {
    await localRepository.saveTracker(tracker)
    const first = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-09', outcome: 'recorded', values: {}, note: 'first' })
    await localRepository.deleteTrackerEntry(tracker.id, '2026-10-09')
    await expect(localRepository.getTrackerEntry(tracker.id, '2026-10-09')).resolves.toBeUndefined()
    const second = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-09', outcome: 'recorded', values: {}, note: 'corrected' })
    expect(second).toMatchObject({ id: first.id, deletedAt: null, note: 'corrected' })
    await expect(db.trackerEntries.where('[trackerId+date]').equals([tracker.id, '2026-10-09']).count()).resolves.toBe(1)
  })
})
