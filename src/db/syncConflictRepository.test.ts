import { afterEach, describe, expect, it } from 'vitest'
import { activateWorkspace, db } from './database'
import { localRepository } from './localRepository'
import { listSyncConflicts, resolveSyncConflict } from './syncConflictRepository'
import type { StoredTrackerDefinition } from './models'

const tracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'conflicted-tracker', name: 'Local name', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [{ id: 'focus', name: 'Focus', valueType: 'quantity' }], customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', archivedAt: null, deletedAt: null,
}
const remote = { id: tracker.id, user_id: 'conflict-user', schema_version: 1, kind: 'habit', status: 'active', name: 'Cloud name', definition: { ...tracker, name: 'Cloud name' }, created_at: tracker.createdAt, updated_at: '2026-01-03T00:00:00.000Z', deleted_at: null, server_revision: 4 }
const remoteEntry = (id: string, trackerId: string, revision: number) => ({ id, user_id: 'conflict-user', tracker_id: trackerId, entry_date: '2026-01-04', outcome: 'recorded', entry_values: { focus: 3 }, note: 'cloud note', created_at: '2026-01-04T00:00:00.000Z', updated_at: '2026-01-04T01:00:00.000Z', deleted_at: null, server_revision: revision })

afterEach(async () => {
  db.close()
  await db.delete()
})

describe('sync conflict recovery', () => {
  it('preserves version 2 planning fields when choosing the cloud conflict copy', async () => {
    await activateWorkspace('conflict-user')
    const planned: StoredTrackerDefinition = {
      ...tracker, id: 'planned-conflict', kind: 'goal', schemaVersion: 2, deadline: '2026-12-31',
      goalPlanning: { mode: 'daily-recurring', progressSemantics: { focus: 'incremental' }, dailyTargets: { focus: 4 }, cumulativeTargets: { focus: 30 } },
    }
    await localRepository.saveTracker(planned)
    const operation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', planned.id]).first()
    if (!operation) throw new Error('Expected a queued operation')
    const cloud = { ...remote, id: planned.id, schema_version: 2, kind: 'goal', definition: { ...planned, name: 'Cloud planned' }, name: 'Cloud planned' }
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: planned.id, localPayload: planned, remoteRecord: cloud, detectedAt: '2026-01-03T00:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'use-cloud')

    await expect(db.trackers.get(planned.id)).resolves.toMatchObject({ schemaVersion: 2, goalPlanning: planned.goalPlanning })
  })

  it('retains v3 allocations when explicitly keeping the local side of a revision conflict', async () => {
    await activateWorkspace('conflict-user')
    const planned: StoredTrackerDefinition = {
      ...tracker, id: 'planned-v3-conflict', kind: 'goal', schemaVersion: 3, deadline: '2026-12-31', startDate: '2026-01-01',
      schedule: { kind: 'every-day' },
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { focus: 'incremental' }, dailyTargets: {}, cumulativeTargets: { focus: 30 }, planningTimeZone: 'Asia/Kolkata', allocations: { focus: { '2026-10-09': 4 } } },
    }
    await localRepository.saveTracker(planned)
    const operation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', planned.id]).first()
    if (!operation) throw new Error('Expected a queued v3 tracker operation')
    const cloud = { ...remote, id: planned.id, schema_version: 3, kind: 'goal', definition: { ...planned, goalPlanning: { ...planned.goalPlanning!, allocations: { focus: { '2026-10-09': 8 } } } }, server_revision: 5 }
    await db.syncOperations.put({ ...operation, status: 'conflict' })
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: planned.id, localPayload: planned, remoteRecord: cloud, detectedAt: '2026-10-09T00:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'keep-local')

    await expect(db.trackers.get(planned.id)).resolves.toMatchObject({ schemaVersion: 3, goalPlanning: { planningTimeZone: 'Asia/Kolkata', allocations: { focus: { '2026-10-09': 4 } } } })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', planned.id]).first()).resolves.toMatchObject({ status: 'pending', expectedRevision: 5, payload: { schemaVersion: 3, goalPlanning: { allocations: { focus: { '2026-10-09': 4 } } } } })
  })

  it('rejects conflict definitions whose row schema version does not match', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const operation = await db.syncOperations.toCollection().first()
    if (!operation) throw new Error('Expected a queued operation')
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: { ...remote, schema_version: 2 }, detectedAt: '2026-01-03T00:00:00.000Z' })

    await expect(resolveSyncConflict('conflict-user', operation.id, 'use-cloud')).rejects.toThrow('does not match its stored definition')
    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: 'Local name' })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeDefined()
  })

  it('keeps the local version and queues it against the cloud revision the user reviewed', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const operation = await db.syncOperations.toCollection().first()
    if (!operation) throw new Error('Expected a queued operation')
    await db.syncOperations.put({ ...operation, status: 'conflict' })
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: remote, detectedAt: '2026-01-03T00:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'keep-local')

    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: 'Local name' })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeUndefined()
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', tracker.id]).first()).resolves.toMatchObject({ status: 'pending', expectedRevision: 4, payload: { name: 'Local name' } })
    await expect(listSyncConflicts('conflict-user')).resolves.toEqual([])
  })

  it('uses the cloud version, updates revision metadata, and removes its stale local operation', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const operation = await db.syncOperations.toCollection().first()
    if (!operation) throw new Error('Expected a queued operation')
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: remote, detectedAt: '2026-01-03T00:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'use-cloud')

    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: 'Cloud name' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', tracker.id]).count()).resolves.toBe(0)
    await expect(db.syncRecords.get(`tracker:${tracker.id}`)).resolves.toMatchObject({ serverRevision: 4, ownerUserId: 'conflict-user' })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeUndefined()
  })

  it('normalizes PostgreSQL timestamp strings before applying a cloud conflict choice', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const operation = await db.syncOperations.toCollection().first()
    if (!operation) throw new Error('Expected a queued operation')
    const postgresRemote = {
      ...remote,
      definition: {
        ...remote.definition,
        createdAt: '2026-01-01 00:00:00.123456+00',
        updatedAt: '2026-01-03T04:30:00.123456+04:30',
      },
    }
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: postgresRemote, detectedAt: '2026-01-03T00:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'use-cloud')

    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({
      name: 'Cloud name', createdAt: '2026-01-01T00:00:00.123456Z', updatedAt: '2026-01-03T00:00:00.123456Z',
    })
  })

  it('does not expose or resolve another account’s local conflicts', async () => {
    await activateWorkspace('conflict-user')
    await db.syncConflicts.put({ id: 'private-conflict', ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: remote, detectedAt: '2026-01-03T00:00:00.000Z' })
    await activateWorkspace('different-user')

    await expect(listSyncConflicts('conflict-user')).rejects.toThrow('does not belong to this account')
    await expect(resolveSyncConflict('conflict-user', 'private-conflict', 'use-cloud')).rejects.toThrow('does not belong to this account')
    await expect(db.syncConflicts.count()).resolves.toBe(0)
  })

  it('retains both copies when the server cannot provide an account-readable cloud record', async () => {
    await activateWorkspace('conflict-user')
    await db.syncConflicts.clear()
    await localRepository.saveTracker(tracker)
    const operation = await db.syncOperations.toCollection().first()
    if (!operation) throw new Error('Expected a queued operation')
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: null, detectedAt: '2026-01-03T00:00:00.000Z' })

    await expect(resolveSyncConflict('conflict-user', operation.id, 'keep-local')).rejects.toThrow('Both copies remain preserved')
    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: 'Local name' })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeDefined()
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', tracker.id]).count()).resolves.toBe(1)
  })

  it('forks an unreadable tracker ID and relinks its local entry history transactionally', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const entry = { id: 'local-history', trackerId: tracker.id, date: '2026-01-04', outcome: 'recorded' as const, values: { focus: 3 }, note: 'kept', createdAt: tracker.createdAt, updatedAt: tracker.updatedAt, deletedAt: null }
    await db.trackerEntries.put(entry)
    const operation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', tracker.id]).first()
    if (!operation) throw new Error('Expected a queued tracker operation')
    await db.syncOperations.put({ ...operation, status: 'conflict' })
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker', entityId: tracker.id, localPayload: tracker, remoteRecord: null, detectedAt: '2026-01-03T00:00:00.000Z' })
    await db.syncConflicts.put({ id: 'stale-entry-conflict', ownerUserId: 'conflict-user', entity: 'tracker_entry', entityId: entry.id, localPayload: entry, remoteRecord: remoteEntry(entry.id, tracker.id, 2), detectedAt: '2026-01-03T00:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'fork-local')

    const fork = await db.trackers.toCollection().first()
    expect(fork).toBeDefined()
    expect(fork?.id).not.toBe(tracker.id)
    await expect(db.trackers.get(tracker.id)).resolves.toBeUndefined()
    await expect(db.trackerEntries.get(entry.id)).resolves.toMatchObject({ trackerId: fork?.id, note: 'kept' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker', fork!.id]).first()).resolves.toMatchObject({ status: 'pending', expectedRevision: null })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker_entry', entry.id]).first()).resolves.toMatchObject({ payload: { trackerId: fork?.id } })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeUndefined()
    await expect(db.syncConflicts.get('stale-entry-conflict')).resolves.toBeUndefined()
  })

  it('adopts the cloud entry ID when keeping local values over a same-day cloud duplicate', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const local = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-01-04', outcome: 'recorded', values: { focus: 1 }, note: 'local note' })
    const operation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker_entry', local.id]).first()
    if (!operation) throw new Error('Expected a queued entry operation')
    await db.syncOperations.put({ ...operation, status: 'conflict' })
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker_entry', entityId: local.id, localPayload: local, remoteRecord: remoteEntry('cloud-entry-id', tracker.id, 7), detectedAt: '2026-01-04T02:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'keep-local')

    await expect(db.trackerEntries.get(local.id)).resolves.toBeUndefined()
    await expect(db.trackerEntries.get('cloud-entry-id')).resolves.toMatchObject({ trackerId: tracker.id, note: 'local note', values: { focus: 1 } })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker_entry', 'cloud-entry-id']).first()).resolves.toMatchObject({ status: 'pending', expectedRevision: 7, payload: { id: 'cloud-entry-id', note: 'local note' } })
    await expect(db.syncRecords.get('tracker_entry:cloud-entry-id')).resolves.toMatchObject({ serverRevision: 7 })
  })

  it('replaces a same-day local entry with the cloud row and its identity when choosing cloud', async () => {
    await activateWorkspace('conflict-user')
    await localRepository.saveTracker(tracker)
    const local = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-01-04', outcome: 'recorded', values: { focus: 1 }, note: 'local note' })
    const operation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker_entry', local.id]).first()
    if (!operation) throw new Error('Expected a queued entry operation')
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'tracker_entry', entityId: local.id, localPayload: local, remoteRecord: remoteEntry('cloud-entry-id', tracker.id, 7), detectedAt: '2026-01-04T02:00:00.000Z' })

    await resolveSyncConflict('conflict-user', operation.id, 'use-cloud')

    await expect(db.trackerEntries.get(local.id)).resolves.toBeUndefined()
    await expect(db.trackerEntries.get('cloud-entry-id')).resolves.toMatchObject({ note: 'cloud note', values: { focus: 3 } })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'tracker_entry', local.id]).count()).resolves.toBe(0)
    await expect(db.syncRecords.get('tracker_entry:cloud-entry-id')).resolves.toMatchObject({ serverRevision: 7 })
  })

  it('rebases same-date holidays onto the cloud identity when explicitly keeping local', async () => {
    await activateWorkspace('conflict-user')
    const [local] = await localRepository.saveAccountHolidays(['2026-10-10'], 'travel')
    if (!local) throw new Error('Expected a local holiday')
    const operation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'account_holiday', local.id]).first()
    if (!operation) throw new Error('Expected a queued holiday operation')
    await db.syncOperations.put({ ...operation, status: 'conflict' })
    const cloud = { id: 'cloud-holiday-id', user_id: 'conflict-user', holiday_date: local.date, reason: 'exam', created_at: local.createdAt, updated_at: local.updatedAt, deleted_at: null, server_revision: 4 }
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'account_holiday', entityId: local.id, localPayload: local, remoteRecord: cloud, detectedAt: local.updatedAt })

    await resolveSyncConflict('conflict-user', operation.id, 'keep-local')

    await expect(db.accountHolidays.get(local.id)).resolves.toBeUndefined()
    await expect(db.accountHolidays.get('cloud-holiday-id')).resolves.toMatchObject({ date: local.date, reason: 'travel' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'account_holiday', 'cloud-holiday-id']).first()).resolves.toMatchObject({ status: 'pending', expectedRevision: 4, payload: { reason: 'travel' } })
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeUndefined()
  })

  it('replaces a same-date local holiday with the cloud holiday when explicitly choosing cloud', async () => {
    await activateWorkspace('conflict-user')
    const [local] = await localRepository.saveAccountHolidays(['2026-10-11'], 'travel')
    if (!local) throw new Error('Expected a local holiday')
    const operation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'account_holiday', local.id]).first()
    if (!operation) throw new Error('Expected a queued holiday operation')
    await db.syncOperations.put({ ...operation, status: 'conflict' })
    const cloud = { id: 'cloud-holiday-id', user_id: 'conflict-user', holiday_date: local.date, reason: 'exam', created_at: local.createdAt, updated_at: local.updatedAt, deleted_at: null, server_revision: 4 }
    await db.syncConflicts.put({ id: operation.id, ownerUserId: 'conflict-user', entity: 'account_holiday', entityId: local.id, localPayload: local, remoteRecord: cloud, detectedAt: local.updatedAt })

    await resolveSyncConflict('conflict-user', operation.id, 'use-cloud')

    await expect(db.accountHolidays.get(local.id)).resolves.toBeUndefined()
    await expect(db.accountHolidays.get('cloud-holiday-id')).resolves.toMatchObject({ date: local.date, reason: 'exam' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['conflict-user', 'account_holiday', local.id]).count()).resolves.toBe(0)
    await expect(db.syncConflicts.get(operation.id)).resolves.toBeUndefined()
  })
})
