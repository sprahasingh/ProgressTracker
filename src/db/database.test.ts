import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { ProgressTrackerDatabase, activateWorkspace, decideGuestData, getGuestWorkspaceSummary } from './database'
import { db } from './database'
import type { DailyEntry } from './models'

const openedDatabases: Dexie[] = []

afterEach(async () => {
  const databases = openedDatabases.splice(0)
  databases.forEach((database) => database.close())
  const uniqueByName = new Map(databases.map((database) => [database.name, database]))
  await Promise.all([...uniqueByName.values()].map((database) => database.delete()))
})

describe('ProgressTracker database migrations', () => {
  it('preserves existing records and projects them when upgrading schema v1 through v5', async () => {
    const name = `migration-${crypto.randomUUID()}`
    const legacy = new Dexie(name)
    legacy.version(1).stores({
      categories: 'id, name, position, archivedAt',
      dailyEntries: 'id, categoryId, date, status, &[categoryId+date]',
      goals: 'id, categoryId, status, targetDate',
      goalMetrics: 'id, goalId, name, position',
      goalProgressLogs: 'id, metricId, date, recordedAt',
      settings: 'id',
    })
    openedDatabases.push(legacy)
    await legacy.open()
    await legacy.table('categories').put({ id: 'cat-1', name: 'DSA', createdAt: '2026-01-01T12:00:00.000Z', archivedAt: null })
    await legacy.table('dailyEntries').put({
      id: 'entry-1', categoryId: 'cat-1', date: '2026-01-02', status: 'completed', note: 'Two problems', createdAt: '2026-01-02T18:00:00.000Z',
    })
    legacy.close()
    openedDatabases.splice(openedDatabases.indexOf(legacy), 1)

    const upgraded = new ProgressTrackerDatabase(name)
    openedDatabases.push(upgraded)
    await upgraded.open()

    expect(upgraded.verno).toBe(5)
    await expect(upgraded.categories.get('cat-1')).resolves.toMatchObject({
      id: 'cat-1', name: 'DSA', createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z', deletedAt: null,
    })
    await expect(upgraded.dailyEntries.get('entry-1')).resolves.toMatchObject({
      id: 'entry-1', date: '2026-01-02', note: 'Two problems', updatedAt: '2026-01-02T18:00:00.000Z', deletedAt: null,
    })
    await expect(upgraded.trackers.get('cat-1')).resolves.toMatchObject({ id: 'cat-1', name: 'DSA', kind: 'habit', metrics: [{ id: 'cat-1', valueType: 'boolean' }] })
    await expect(upgraded.trackerEntries.get('entry-1')).resolves.toMatchObject({ id: 'entry-1', trackerId: 'cat-1', date: '2026-01-02', outcome: 'recorded', values: { 'cat-1': true } })
  })

  it('upgrades a v2 database additively, preserving tombstones and allowing close/reopen', async () => {
    const name = `migration-v2-${crypto.randomUUID()}`
    const legacy = new Dexie(name)
    legacy.version(2).stores({
      categories: 'id, name, position, archivedAt, updatedAt, deletedAt',
      dailyEntries: 'id, categoryId, date, status, updatedAt, deletedAt, &[categoryId+date]',
      goals: 'id, categoryId, status, targetDate, updatedAt, deletedAt',
      goalMetrics: 'id, goalId, name, position, updatedAt, deletedAt',
      goalProgressLogs: 'id, metricId, date, recordedAt, updatedAt, deletedAt',
      settings: 'id, updatedAt',
      dailyJournals: 'id, &date, updatedAt, deletedAt',
      syncOperations: 'id, entity, entityId, operation, updatedAt, [entity+entityId]',
    })
    openedDatabases.push(legacy)
    await legacy.open()
    await legacy.table('categories').put({ id: 'cat-tombstone', name: 'Archived', icon: 'x', accent: '', schedule: { kind: 'every-day' }, position: 0, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z', archivedAt: null, deletedAt: '2026-02-03T00:00:00.000Z' })
    await legacy.table('dailyEntries').put({ id: 'entry-tombstone', categoryId: 'cat-tombstone', date: '2026-02-02', status: 'skipped', note: 'rest', createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-03T00:00:00.000Z', deletedAt: '2026-02-04T00:00:00.000Z' })
    await legacy.table('syncOperations').put({ id: 'pending-v2', entity: 'category', entityId: 'cat-tombstone', operation: 'upsert', updatedAt: '2026-02-04T00:00:00.000Z', attempts: 2, lastError: 'offline' })
    legacy.close()
    openedDatabases.splice(openedDatabases.indexOf(legacy), 1)

    const upgraded = new ProgressTrackerDatabase(name)
    openedDatabases.push(upgraded)
    await upgraded.open()
    expect(upgraded.verno).toBe(5)
    await expect(upgraded.categories.get('cat-tombstone')).resolves.toMatchObject({ id: 'cat-tombstone', deletedAt: '2026-02-03T00:00:00.000Z' })
    await expect(upgraded.dailyEntries.get('entry-tombstone')).resolves.toMatchObject({ id: 'entry-tombstone', deletedAt: '2026-02-04T00:00:00.000Z' })
    await expect(upgraded.trackers.get('cat-tombstone')).resolves.toMatchObject({ id: 'cat-tombstone', deletedAt: '2026-02-03T00:00:00.000Z', status: 'archived' })
    await expect(upgraded.trackerEntries.get('entry-tombstone')).resolves.toMatchObject({ id: 'entry-tombstone', deletedAt: '2026-02-04T00:00:00.000Z', outcome: 'skipped' })

    upgraded.close()
    await upgraded.open()
    await expect(upgraded.trackers.get('cat-tombstone')).resolves.toMatchObject({ id: 'cat-tombstone', deletedAt: '2026-02-03T00:00:00.000Z' })
    await expect(upgraded.trackerEntries.get('entry-tombstone')).resolves.toMatchObject({ id: 'entry-tombstone', deletedAt: '2026-02-04T00:00:00.000Z' })
    await expect(upgraded.syncOperations.get('pending-v2')).resolves.toMatchObject({ attempts: 2, lastError: 'offline' })
    await expect(upgraded.workspaceMetadata.get('workspace')).resolves.toBeUndefined()
  })

  it('enforces one daily entry per category and calendar date', async () => {
    const database = new ProgressTrackerDatabase(`unique-${crypto.randomUUID()}`)
    openedDatabases.push(database)
    await database.open()
    const first: DailyEntry = {
      id: 'entry-a', categoryId: 'cat-1', date: '2026-02-03', status: 'completed' as const,
      note: '', createdAt: '2026-02-03T10:00:00.000Z', updatedAt: '2026-02-03T10:00:00.000Z', deletedAt: null,
    }
    await database.dailyEntries.add(first)
    await expect(database.dailyEntries.add({ ...first, id: 'entry-b' })).rejects.toThrow()
  })

  it('backfills account-owned sync jobs when a v4 workspace upgrades to v5', async () => {
    const name = `account-v4-${crypto.randomUUID()}`
    const previous = new Dexie(name)
    previous.version(4).stores({
      categories: 'id, name, position, archivedAt, updatedAt, deletedAt',
      dailyEntries: 'id, categoryId, date, status, updatedAt, deletedAt, &[categoryId+date]',
      goals: 'id, categoryId, status, targetDate, updatedAt, deletedAt',
      goalMetrics: 'id, goalId, name, position, updatedAt, deletedAt',
      goalProgressLogs: 'id, metricId, date, recordedAt, updatedAt, deletedAt',
      settings: 'id, updatedAt', dailyJournals: 'id, &date, updatedAt, deletedAt',
      syncOperations: 'id, entity, entityId, operation, updatedAt, [entity+entityId]',
      trackers: 'id, kind, status, categoryId, updatedAt, deletedAt',
      trackerEntries: 'id, trackerId, date, outcome, updatedAt, deletedAt, &[trackerId+date]',
      workspaceMetadata: 'key',
    })
    openedDatabases.push(previous)
    await previous.open()
    await previous.table('workspaceMetadata').put({ key: 'workspace', userId: 'backfill-user', guestDecision: 'kept-separate' })
    await previous.table('trackers').put({ id: 'existing-account-tracker', name: 'Existing account data', deletedAt: null })
    await previous.table('trackerEntries').put({ id: 'existing-account-entry', trackerId: 'existing-account-tracker', date: '2026-10-09', deletedAt: null })
    previous.close()
    openedDatabases.splice(openedDatabases.indexOf(previous), 1)

    const upgraded = new ProgressTrackerDatabase(name)
    openedDatabases.push(upgraded)
    await upgraded.open()
    await expect(upgraded.syncOperations.where('ownerUserId').equals('backfill-user').count()).resolves.toBe(2)
    await expect(upgraded.syncOperations.where('ownerUserId').equals('backfill-user').toArray()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'tracker', entityId: 'existing-account-tracker', expectedRevision: null, status: 'pending' }),
      expect.objectContaining({ entity: 'tracker_entry', entityId: 'existing-account-entry', expectedRevision: null, status: 'pending' }),
    ]))
  })

  it('keeps guest and authenticated account workspaces isolated, including operation queues', async () => {
    await activateWorkspace(null)
    openedDatabases.push(db)
    await db.trackers.put({ id: 'guest-tracker', name: 'Guest record' } as never)
    await db.syncOperations.put({ id: 'guest-operation', ownerUserId: null, entity: 'category', entityId: 'legacy-1', operation: 'upsert', expectedRevision: null, createdAt: '2026-01-01T00:00:00.000Z', attempts: 0, status: 'pending', lastError: null })

    await activateWorkspace('account-a')
    openedDatabases.push(db)
    await db.trackers.put({ id: 'account-a-tracker', name: 'A record' } as never)
    await db.syncOperations.put({ id: 'account-a-operation', ownerUserId: 'account-a', entity: 'category', entityId: 'account-a-tracker', operation: 'upsert', expectedRevision: null, createdAt: '2026-01-02T00:00:00.000Z', attempts: 1, status: 'pending', lastError: null })
    await expect(db.trackers.get('guest-tracker')).resolves.toBeUndefined()

    await activateWorkspace('account-b')
    openedDatabases.push(db)
    await expect(db.trackers.count()).resolves.toBe(0)
    await expect(db.syncOperations.count()).resolves.toBe(0)

    await activateWorkspace('account-a')
    openedDatabases.push(db)
    await expect(db.trackers.get('account-a-tracker')).resolves.toMatchObject({ name: 'A record' })
    await expect(db.syncOperations.get('account-a-operation')).resolves.toMatchObject({ entityId: 'account-a-tracker' })
    await activateWorkspace(null)
    openedDatabases.push(db)
    await expect(db.trackers.get('guest-tracker')).resolves.toMatchObject({ name: 'Guest record' })
    await expect(db.syncOperations.get('guest-operation')).resolves.toMatchObject({ entityId: 'legacy-1' })
  })

  it('offers guest records for import and makes a repeated completed import idempotent', async () => {
    await activateWorkspace(null)
    openedDatabases.push(db)
    await db.trackers.put({ id: 'guest-copy', name: 'Preserved guest record' } as never)
    await expect(getGuestWorkspaceSummary()).resolves.toMatchObject({ hasData: true })

    await decideGuestData('import-account', 'imported')
    await decideGuestData('import-account', 'imported')
    await activateWorkspace('import-account')
    openedDatabases.push(db)
    await expect(db.trackers.get('guest-copy')).resolves.toMatchObject({ name: 'Preserved guest record' })
    await expect(db.syncOperations.where('ownerUserId').equals('import-account').count()).resolves.toBe(1)
    await activateWorkspace(null)
    openedDatabases.push(db)
    await expect(db.trackers.get('guest-copy')).resolves.toMatchObject({ name: 'Preserved guest record' })
  })

  it('rolls back an interrupted guest import on conflicting IDs and can safely retry', async () => {
    await activateWorkspace(null)
    openedDatabases.push(db)
    await db.categories.put({ id: 'category-before-conflict', name: 'Guest category' } as never)
    await db.trackers.put({ id: 'collision', name: 'Guest value' } as never)
    const guest = db
    openedDatabases.push(guest)
    await activateWorkspace('collision-account')
    openedDatabases.push(db)
    await db.trackers.put({ id: 'collision', name: 'Account value' } as never)

    await expect(decideGuestData('collision-account', 'imported')).rejects.toThrow('Guest import stopped')
    await expect(db.workspaceMetadata.get('workspace')).resolves.toMatchObject({ userId: 'collision-account', guestDecision: undefined })
    await expect(db.trackers.get('collision')).resolves.toMatchObject({ name: 'Account value' })
    await expect(db.categories.get('category-before-conflict')).resolves.toBeUndefined()
    await guest.open()
    await expect(guest.trackers.get('collision')).resolves.toMatchObject({ name: 'Guest value' })

    await db.trackers.delete('collision')
    await decideGuestData('collision-account', 'imported')
    await expect(db.trackers.get('collision')).resolves.toMatchObject({ name: 'Guest value' })
    await expect(db.categories.get('category-before-conflict')).resolves.toMatchObject({ name: 'Guest category' })
    await guest.close()
  })
})
