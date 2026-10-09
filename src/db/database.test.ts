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

    expect(upgraded.verno).toBe(6)
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
    expect(upgraded.verno).toBe(6)
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

    await Promise.all([
      decideGuestData('import-account', 'imported'),
      decideGuestData('import-account', 'imported'),
    ])
    await activateWorkspace('import-account')
    openedDatabases.push(db)
    await expect(db.trackers.get('guest-copy')).resolves.toMatchObject({ name: 'Preserved guest record' })
    await expect(db.syncOperations.where('ownerUserId').equals('import-account').count()).resolves.toBe(1)
    await expect(db.workspaceMetadata.get('workspace')).resolves.toMatchObject({ guestDecision: 'imported', importedAt: expect.any(String) })
    await activateWorkspace(null)
    openedDatabases.push(db)
    await expect(db.trackers.get('guest-copy')).resolves.toMatchObject({ name: 'Preserved guest record' })
  })

  it('imports v2 planning configuration and queues the same versioned definition for sync', async () => {
    const plannedGuest = {
      schemaVersion: 2, id: 'guest-planned-goal', name: 'Planned guest goal', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' }, startDate: '2026-10-01', deadline: '2026-12-31',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', minimum: 2, target: 5, stretch: 8, streakQualification: 'minimum' } }],
      customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: { pages: 3 }, cumulativeTargets: { pages: 100 } },
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await activateWorkspace(null)
    openedDatabases.push(db)
    await db.trackers.put(plannedGuest as never)
    await activateWorkspace('planning-import-account')
    openedDatabases.push(db)
    await decideGuestData('planning-import-account', 'imported')

    await expect(db.trackers.get(plannedGuest.id)).resolves.toMatchObject({ schemaVersion: 2, goalPlanning: plannedGuest.goalPlanning })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['planning-import-account', 'tracker', plannedGuest.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 2, goalPlanning: plannedGuest.goalPlanning } })
  })

  it('imports guest records as copies with new IDs and remapped parent links on collisions', async () => {
    await activateWorkspace(null)
    openedDatabases.push(db)
    await db.categories.put({ id: 'shared-category', name: 'Guest category' } as never)
    await db.trackers.put({ id: 'shared-tracker', name: 'Guest tracker', categoryId: 'shared-category', deletedAt: null } as never)
    await db.trackerEntries.put({ id: 'shared-entry', trackerId: 'shared-tracker', date: '2026-10-09', note: 'Guest history', deletedAt: null } as never)
    await db.settings.put({ id: 'general', appearance: 'dark' } as never)
    const guest = db
    openedDatabases.push(guest)

    await activateWorkspace('copy-account')
    openedDatabases.push(db)
    await db.categories.put({ id: 'shared-category', name: 'Account category' } as never)
    await db.trackers.put({ id: 'shared-tracker', name: 'Account tracker', categoryId: 'shared-category', deletedAt: null } as never)
    await db.trackerEntries.put({ id: 'shared-entry', trackerId: 'shared-tracker', date: '2026-10-09', note: 'Account history', deletedAt: null } as never)
    await db.settings.put({ id: 'general', appearance: 'light' } as never)

    await decideGuestData('copy-account', 'imported-as-copies')

    const guestCategory = await db.categories.filter((row) => row.name === 'Guest category').first()
    const guestTracker = await db.trackers.filter((row) => row.name === 'Guest tracker').first()
    const guestEntry = await db.trackerEntries.filter((row) => row.note === 'Guest history').first()
    expect(guestCategory?.id).not.toBe('shared-category')
    expect(guestTracker?.id).not.toBe('shared-tracker')
    expect(guestTracker?.categoryId).toBe(guestCategory?.id)
    expect(guestEntry?.id).not.toBe('shared-entry')
    expect(guestEntry?.trackerId).toBe(guestTracker?.id)
    await expect(db.categories.get('shared-category')).resolves.toMatchObject({ name: 'Account category' })
    await expect(db.trackers.get('shared-tracker')).resolves.toMatchObject({ name: 'Account tracker' })
    await expect(db.trackerEntries.get('shared-entry')).resolves.toMatchObject({ note: 'Account history' })
    await expect(db.settings.get('general')).resolves.toMatchObject({ appearance: 'light' })
    await expect(db.syncOperations.where('ownerUserId').equals('copy-account').count()).resolves.toBe(2)
    await expect(db.workspaceMetadata.get('workspace')).resolves.toMatchObject({ guestDecision: 'imported-as-copies' })

    await guest.open()
    await expect(guest.categories.get('shared-category')).resolves.toMatchObject({ name: 'Guest category' })
    await expect(guest.trackers.get('shared-tracker')).resolves.toMatchObject({ name: 'Guest tracker' })
    await expect(guest.trackerEntries.get('shared-entry')).resolves.toMatchObject({ note: 'Guest history' })
    await guest.close()
  })

  it('forks identical parents when different daily rows would collide on unique date indexes', async () => {
    await activateWorkspace(null)
    openedDatabases.push(db)
    const category = { id: 'same-category', name: 'Shared category', icon: '', accent: '', schedule: { kind: 'every-day' }, position: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null }
    const definition = { id: 'same-tracker', name: 'Shared tracker', categoryId: null, deletedAt: null }
    await db.categories.put(category as never)
    await db.dailyEntries.put({ id: 'guest-daily', categoryId: category.id, date: '2026-10-09', status: 'completed', note: 'Guest', createdAt: category.createdAt, updatedAt: category.updatedAt, deletedAt: null })
    await db.trackers.put(definition as never)
    await db.trackerEntries.put({ id: 'guest-generic', trackerId: definition.id, date: '2026-10-09', note: 'Guest generic', deletedAt: null } as never)

    await activateWorkspace('date-collision-account')
    openedDatabases.push(db)
    await db.categories.put(category as never)
    await db.dailyEntries.put({ id: 'account-daily', categoryId: category.id, date: '2026-10-09', status: 'skipped', note: 'Account', createdAt: category.createdAt, updatedAt: category.updatedAt, deletedAt: null })
    await db.trackers.put(definition as never)
    await db.trackerEntries.put({ id: 'account-generic', trackerId: definition.id, date: '2026-10-09', note: 'Account generic', deletedAt: null } as never)

    await decideGuestData('date-collision-account', 'imported-as-copies')

    const copiedCategory = await db.categories.filter((row) => row.name === category.name).toArray()
    const copiedLegacyEntry = await db.dailyEntries.get('guest-daily')
    const copiedTracker = await db.trackers.filter((row) => row.name === definition.name).first()
    const copiedGenericEntry = await db.trackerEntries.get('guest-generic')
    expect(copiedCategory).toHaveLength(2)
    expect(copiedLegacyEntry?.categoryId).not.toBe(category.id)
    expect(copiedTracker?.id).not.toBe(definition.id)
    expect(copiedGenericEntry?.trackerId).toBe(copiedTracker?.id)
    await expect(db.dailyEntries.get('account-daily')).resolves.toMatchObject({ note: 'Account' })
    await expect(db.trackerEntries.get('account-generic')).resolves.toMatchObject({ note: 'Account generic' })
  })

  it('rolls back collision-safe import when two different journals use the same date', async () => {
    await activateWorkspace(null)
    openedDatabases.push(db)
    await db.categories.put({ id: 'guest-category', name: 'Guest category' } as never)
    await db.dailyJournals.put({ id: 'guest-journal', date: '2026-10-09', body: 'Guest notes' } as never)
    const guest = db
    openedDatabases.push(guest)
    await activateWorkspace('journal-collision-account')
    openedDatabases.push(db)
    await db.dailyJournals.put({ id: 'account-journal', date: '2026-10-09', body: 'Account notes' } as never)

    await expect(decideGuestData('journal-collision-account', 'imported-as-copies')).rejects.toThrow('Both copies are unchanged; keep the workspaces separate.')
    await expect(db.categories.get('guest-category')).resolves.toBeUndefined()
    await expect(db.dailyJournals.get('account-journal')).resolves.toMatchObject({ body: 'Account notes' })
    await expect(db.workspaceMetadata.get('workspace')).resolves.toMatchObject({ guestDecision: undefined })
    await guest.open()
    await expect(guest.categories.get('guest-category')).resolves.toMatchObject({ name: 'Guest category' })
    await expect(guest.dailyJournals.get('guest-journal')).resolves.toMatchObject({ body: 'Guest notes' })
    await guest.close()
  })

  it('imports guest records as copies with new IDs and remapped parent links on collisions', async () => {
    await activateWorkspace(null)
    openedDatabases.push(db)
    await db.categories.put({ id: 'shared-category', name: 'Guest category' } as never)
    await db.trackers.put({ id: 'shared-tracker', name: 'Guest tracker', categoryId: 'shared-category', deletedAt: null } as never)
    await db.trackerEntries.put({ id: 'shared-entry', trackerId: 'shared-tracker', date: '2026-10-09', note: 'Guest history', deletedAt: null } as never)
    await db.settings.put({ id: 'general', appearance: 'dark' } as never)
    const guest = db
    openedDatabases.push(guest)

    await activateWorkspace('copy-account')
    openedDatabases.push(db)
    await db.categories.put({ id: 'shared-category', name: 'Account category' } as never)
    await db.trackers.put({ id: 'shared-tracker', name: 'Account tracker', categoryId: 'shared-category', deletedAt: null } as never)
    await db.trackerEntries.put({ id: 'shared-entry', trackerId: 'shared-tracker', date: '2026-10-09', note: 'Account history', deletedAt: null } as never)
    await db.settings.put({ id: 'general', appearance: 'light' } as never)

    await decideGuestData('copy-account', 'imported-as-copies')

    const guestCategory = await db.categories.filter((row) => row.name === 'Guest category').first()
    const guestTracker = await db.trackers.filter((row) => row.name === 'Guest tracker').first()
    const guestEntry = await db.trackerEntries.filter((row) => row.note === 'Guest history').first()
    expect(guestCategory?.id).not.toBe('shared-category')
    expect(guestTracker?.id).not.toBe('shared-tracker')
    expect(guestTracker?.categoryId).toBe(guestCategory?.id)
    expect(guestEntry?.id).not.toBe('shared-entry')
    expect(guestEntry?.trackerId).toBe(guestTracker?.id)
    await expect(db.categories.get('shared-category')).resolves.toMatchObject({ name: 'Account category' })
    await expect(db.trackers.get('shared-tracker')).resolves.toMatchObject({ name: 'Account tracker' })
    await expect(db.trackerEntries.get('shared-entry')).resolves.toMatchObject({ note: 'Account history' })
    await expect(db.settings.get('general')).resolves.toMatchObject({ appearance: 'light' })
    await expect(db.syncOperations.where('ownerUserId').equals('copy-account').count()).resolves.toBe(2)
    await expect(db.workspaceMetadata.get('workspace')).resolves.toMatchObject({ guestDecision: 'imported-as-copies' })

    await guest.open()
    await expect(guest.categories.get('shared-category')).resolves.toMatchObject({ name: 'Guest category' })
    await expect(guest.trackers.get('shared-tracker')).resolves.toMatchObject({ name: 'Guest tracker' })
    await expect(guest.trackerEntries.get('shared-entry')).resolves.toMatchObject({ note: 'Guest history' })
    await guest.close()
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
