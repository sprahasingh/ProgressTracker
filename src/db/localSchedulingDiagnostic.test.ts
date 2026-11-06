import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateWorkspace, db } from './database'
import type { StoredTrackerDefinition } from './models'
import { inspectLocalScheduling } from './localSchedulingDiagnostic'

const baseTracker: StoredTrackerDefinition = {
  schemaVersion: 6,
  id: 'valid-scheduling-tracker',
  name: '92 Day DSA',
  description: '',
  kind: 'challenge',
  status: 'active',
  categoryId: null,
  tags: [],
  icon: '',
  accent: '',
  schedule: { kind: 'every-day' },
  startDate: '2026-10-29',
  deadline: '2027-01-28',
  scheduling: { mode: 'effective', effectiveDays: 92, effectiveDayCounting: 'planned-activity-days', planningTimeZone: 'Asia/Calcutta' },
  metrics: [],
  customFields: [],
  milestones: [],
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
  archivedAt: null,
  deletedAt: null,
}

afterEach(async () => {
  vi.unstubAllEnvs()
  db.close()
  await db.delete()
})

describe('read-only local scheduling diagnostic', () => {
  it('reports malformed records independently while preserving raw tracker and holiday records', async () => {
    const userId = `scheduling-diagnostic-${crypto.randomUUID()}`
    await activateWorkspace(userId)
    await db.trackers.put(baseTracker)
    const malformed = {
      ...baseTracker,
      id: 'invalid-scheduling-tracker',
      name: 'Malformed schedule',
      startDate: '2026-99-99',
      deadline: '2027-01-28',
    } as StoredTrackerDefinition
    await db.trackers.put(malformed)
    await db.accountHolidays.put({ id: 'active-holiday', date: '2026-11-05', reason: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deletedAt: null })
    await db.accountHolidays.put({ id: 'deleted-holiday', date: '2026-10-10', reason: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z', deletedAt: '2026-10-12T00:00:00.000Z' })
    await db.trackerHolidays.put({ id: 'tracker-holiday', trackerId: baseTracker.id, date: '2026-11-06', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deletedAt: null })
    const trackersBefore = await db.trackers.toArray()
    const accountHolidaysBefore = await db.accountHolidays.toArray()
    const trackerHolidaysBefore = await db.trackerHolidays.toArray()
    const syncOperationsBefore = await db.syncOperations.toArray()
    const versionBefore = db.backendDB().version

    const report = await inspectLocalScheduling(userId)

    expect(report.readOnly).toBe(true)
    expect(report.database).toMatchObject({ accountScopeVerified: true, version: versionBefore })
    expect(report.stores).toMatchObject({ trackers: 'read', accountHolidays: 'read', trackerHolidays: 'read' })
    expect(report.accountHolidays).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: '2026-11-05', deletedAt: null }),
      expect.objectContaining({ date: '2026-10-10', deletedAt: '2026-10-12T00:00:00.000Z' }),
    ]))
    expect(report.trackerHolidays).toEqual([expect.objectContaining({ trackerId: baseTracker.id, date: '2026-11-06', deletedAt: null })])
    expect(report.trackers.find(({ trackerId }) => trackerId === baseTracker.id)).toMatchObject({
      rawStored: { startDate: '2026-10-29', savedDeadline: '2027-01-28', scheduling: { effectiveDays: 92 } },
      calculated: { mode: 'effective', deadline: '2027-01-29' },
      cloudComparison: { status: 'matches', differences: [] },
    })
    expect(report.trackers.find(({ trackerId }) => trackerId === malformed.id)).toMatchObject({
      rawStored: { startDate: '2026-99-99', savedDeadline: '2027-01-28' },
      validation: expect.arrayContaining(['startDate is not a valid YYYY-MM-DD calendar date']),
      failure: {
        operation: 'localRepository.listTrackers.deriveSchedulingDeadline',
        errorName: 'RangeError',
        errorMessage: expect.stringContaining('2026-99-99'),
        stackLocation: expect.stringMatching(/scheduling\.ts:\d+:\d+/),
      },
    })
    expect(await db.trackers.toArray()).toEqual(trackersBefore)
    expect(await db.accountHolidays.toArray()).toEqual(accountHolidaysBefore)
    expect(await db.trackerHolidays.toArray()).toEqual(trackerHolidaysBefore)
    expect(await db.syncOperations.toArray()).toEqual(syncOperationsBefore)
    expect(db.backendDB().version).toBe(versionBefore)
  })

  it('refuses to inspect a different account database without opening it', async () => {
    const userId = `scheduling-diagnostic-owner-${crypto.randomUUID()}`
    await activateWorkspace(userId)
    await expect(inspectLocalScheduling('another-account')).rejects.toThrow(/matching account database is not already open/)
  })
})
