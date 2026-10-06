import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { ProgressTrackerDatabase } from './database'

const openedDatabases: Dexie[] = []

afterEach(async () => {
  await Promise.all(openedDatabases.splice(0).map(async (database) => {
    database.close()
    await database.delete()
  }))
})

describe('ProgressTracker database migrations', () => {
  it('preserves existing records and adds sync metadata when upgrading schema v1 to v2', async () => {
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

    expect(upgraded.verno).toBe(2)
    await expect(upgraded.categories.get('cat-1')).resolves.toMatchObject({
      id: 'cat-1', name: 'DSA', createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z', deletedAt: null,
    })
    await expect(upgraded.dailyEntries.get('entry-1')).resolves.toMatchObject({
      id: 'entry-1', date: '2026-01-02', note: 'Two problems', updatedAt: '2026-01-02T18:00:00.000Z', deletedAt: null,
    })
  })

  it('enforces one daily entry per category and calendar date', async () => {
    const database = new ProgressTrackerDatabase(`unique-${crypto.randomUUID()}`)
    openedDatabases.push(database)
    await database.open()
    const first = {
      id: 'entry-a', categoryId: 'cat-1', date: '2026-02-03', status: 'completed' as const,
      note: '', createdAt: '2026-02-03T10:00:00.000Z', updatedAt: '2026-02-03T10:00:00.000Z', deletedAt: null,
    }
    await database.dailyEntries.add(first)
    await expect(database.dailyEntries.add({ ...first, id: 'entry-b' })).rejects.toThrow()
  })
})
