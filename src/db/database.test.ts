import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { ProgressTrackerDatabase } from './database'
import type { DailyEntry } from './models'

const openedDatabases: Dexie[] = []

afterEach(async () => {
  await Promise.all(openedDatabases.splice(0).map(async (database) => {
    database.close()
    await database.delete()
  }))
})

describe('ProgressTracker database migrations', () => {
  it('preserves existing records and projects them when upgrading schema v1 through v3', async () => {
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

    expect(upgraded.verno).toBe(3)
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
    legacy.close()
    openedDatabases.splice(openedDatabases.indexOf(legacy), 1)

    const upgraded = new ProgressTrackerDatabase(name)
    openedDatabases.push(upgraded)
    await upgraded.open()
    expect(upgraded.verno).toBe(3)
    await expect(upgraded.categories.get('cat-tombstone')).resolves.toMatchObject({ id: 'cat-tombstone', deletedAt: '2026-02-03T00:00:00.000Z' })
    await expect(upgraded.dailyEntries.get('entry-tombstone')).resolves.toMatchObject({ id: 'entry-tombstone', deletedAt: '2026-02-04T00:00:00.000Z' })
    await expect(upgraded.trackers.get('cat-tombstone')).resolves.toMatchObject({ id: 'cat-tombstone', deletedAt: '2026-02-03T00:00:00.000Z', status: 'archived' })
    await expect(upgraded.trackerEntries.get('entry-tombstone')).resolves.toMatchObject({ id: 'entry-tombstone', deletedAt: '2026-02-04T00:00:00.000Z', outcome: 'skipped' })

    upgraded.close()
    await upgraded.open()
    await expect(upgraded.trackers.get('cat-tombstone')).resolves.toMatchObject({ id: 'cat-tombstone', deletedAt: '2026-02-03T00:00:00.000Z' })
    await expect(upgraded.trackerEntries.get('entry-tombstone')).resolves.toMatchObject({ id: 'entry-tombstone', deletedAt: '2026-02-04T00:00:00.000Z' })
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
})
