import { afterEach, describe, expect, it } from 'vitest'
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
  db.close()
  await db.delete()
})

describe('workspace mutation notifications', () => {
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

  it('publishes an account owner only after its local record and outbox transaction commits', async () => {
    await activateWorkspace('mutation-account')
    const owners: string[] = []
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

  it('does not publish guest-only tracker edits', async () => {
    await activateWorkspace(null)
    const owners: string[] = []
    const unsubscribe = subscribeToWorkspaceMutations((ownerId) => owners.push(ownerId))
    try {
      await localRepository.saveTracker(tracker)
      expect(owners).toEqual([])
      await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: tracker.name })
    } finally {
      unsubscribe()
    }
  })

  it('publishes check-in and tombstone edits for the account that owns the workspace', async () => {
    await activateWorkspace('entry-owner')
    await localRepository.saveTracker(tracker)
    const owners: string[] = []
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
