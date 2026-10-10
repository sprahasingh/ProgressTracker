import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateWorkspace, db } from './database'
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
})
