import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateWorkspace, db } from './database'
import { localRepository } from './localRepository'
import type { StoredTrackerDefinition } from './models'
import { calculateTrackerAnalytics } from '../domain/trackers/analytics'
import { calculateStreak } from '../domain/trackers/progression'
import { getTrackerActivityStatus } from '../domain/trackers/activityStatus'

const baseTracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'lifecycle-machine', name: 'Lifecycle routine', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: '2026-10-01', deadline: '2026-10-20',
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
  qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true }, customFields: [], milestones: [],
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}
const operationCount = import.meta.env.VITE_TRACKER_LIFECYCLE_STRESS === 'true' ? 2_500 : 150

beforeEach(() => { vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true') })
afterEach(async () => { vi.unstubAllEnvs(); db.close(); await db.delete() })

describe('tracker lifecycle state machine', () => {
  it.each([0x51a7e, 0x20a610, 0xdeadbeef, 0x20261012])('preserves lifecycle invariants for deterministic seed %i', async (seed) => {
    // This state machine exercises local/guest lifecycle transitions. With the
    // feature enabled, guest restores do not need account-server verification.
    await activateWorkspace(null)
    await localRepository.saveTracker(baseTracker)
    const original = [
      await localRepository.saveTrackerEntry({ trackerId: baseTracker.id, date: '2026-10-07', outcome: 'recorded', values: { done: true }, note: 'initial seven' }),
      await localRepository.saveTrackerEntry({ trackerId: baseTracker.id, date: '2026-10-08', outcome: 'recorded', values: { done: false }, note: 'initial eight' }),
    ]

    let state = seed >>> 0
    const history: string[] = []
    let expectedValues = new Map(original.map((entry) => [entry.date, JSON.stringify({ values: entry.values, note: entry.note })]))
    let binned = false
    for (let step = 0; step < operationCount; step += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      const action = state % 9
      const actionLabel = ['change-period', 'edit-entry', 'toggle-archive', 'toggle-bin', 'change-deadline', 'change-recurrence', 'rename', 'invalid-deadline', 'repeat-check-in'][action]!
      history.push(actionLabel)
      try {
        if (action === 0 && !binned) {
          const tracker = await localRepository.getTracker(baseTracker.id)
          if (tracker) await localRepository.saveTracker({ ...tracker, startDate: tracker.startDate === '2026-10-01' ? '2026-10-09' : '2026-10-01' })
        } else if (action === 1 && !binned) {
          const [entry, currentTracker] = await Promise.all([localRepository.getTrackerEntry(baseTracker.id, '2026-10-07'), localRepository.getTracker(baseTracker.id)])
          if (entry && currentTracker?.status === 'active') {
            const changed = { ...entry, values: { done: entry.values.done !== true }, note: `explicit edit ${step}` }
            const saved = await localRepository.saveTrackerEntry({ trackerId: baseTracker.id, date: changed.date, outcome: changed.outcome, values: changed.values, note: changed.note })
            expectedValues.set(saved.date, JSON.stringify({ values: saved.values, note: saved.note }))
          }
        } else if (action === 2 && !binned) {
          const tracker = await localRepository.getTracker(baseTracker.id)
          if (tracker) tracker.status === 'active' ? await localRepository.archiveTracker(baseTracker.id) : await localRepository.unarchiveTracker(baseTracker.id)
        } else if (action === 3) {
          if (binned) { await localRepository.restoreTracker(baseTracker.id); binned = false }
          else { await localRepository.deleteTracker(baseTracker.id); binned = true }
        } else if (!binned && action >= 4) {
          const tracker = await localRepository.getTracker(baseTracker.id)
          if (tracker && action === 4) {
            await localRepository.saveTracker({ ...tracker, deadline: tracker.deadline === '2026-10-20' ? '2026-10-10' : '2026-10-20' })
          } else if (tracker && action === 5) {
            await localRepository.saveTracker({ ...tracker, schedule: tracker.schedule.kind === 'every-day' ? { kind: 'weekdays' } : { kind: 'every-day' } })
          } else if (tracker && action === 6) {
            await localRepository.saveTracker({ ...tracker, name: `Routine ${step}`, description: `Updated in seeded run ${seed}` })
          } else if (tracker && action === 7) {
            const before = await db.trackers.get(baseTracker.id)
            await expect(localRepository.saveTracker({ ...tracker, deadline: '2026-09-30' })).rejects.toThrow()
            expect(await db.trackers.get(baseTracker.id)).toEqual(before)
          } else if (tracker && action === 8 && tracker.status === 'active') {
            const entry = await localRepository.getTrackerEntry(baseTracker.id, '2026-10-07')
            if (entry) {
              const firstWrite = await localRepository.saveTrackerEntry({ trackerId: baseTracker.id, date: entry.date, outcome: entry.outcome, values: entry.values, note: entry.note })
              const repeatedWrite = await localRepository.saveTrackerEntry({ trackerId: baseTracker.id, date: entry.date, outcome: entry.outcome, values: entry.values, note: entry.note })
              expect(repeatedWrite.id).toBe(firstWrite.id)
              expectedValues.set(entry.date, JSON.stringify({ values: repeatedWrite.values, note: repeatedWrite.note }))
            }
          }
        }
      } catch (error) {
        throw new Error(`seed=${seed}; step=${step}; sequence=${history.join(',')}; cause=${String(error)}`)
      }

      const stored = await db.trackerEntries.where('trackerId').equals(baseTracker.id).toArray()
      expect(stored.map((entry) => [entry.date, JSON.stringify({ values: entry.values, note: entry.note })]).sort(([a], [b]) => a!.localeCompare(b!)), `seed=${seed}; step=${step}; sequence=${history.join(',')}`)
        .toEqual([...expectedValues].map(([date, value]) => [date, value]))
      const tracker = await db.trackers.get(baseTracker.id)
      expect(tracker).toBeDefined()
      expect(tracker?.deletedAt !== null).toBe(binned)
      await expect(db.trackerVerification.get(baseTracker.id)).resolves.toBeUndefined()
      expect(await localRepository.listTrackers()).toHaveLength(binned || tracker?.status === 'archived' ? 0 : 1)
      expect(await localRepository.listDeletedTrackers()).toHaveLength(binned ? 1 : 0)
      if (!binned && tracker) {
        const liveEntries = await localRepository.listTrackerEntriesForTracker(baseTracker.id)
        const analytics = calculateTrackerAnalytics(tracker, liveEntries, '2026-10-01', '2026-10-12')
        const expectedHistorical = tracker.startDate === '2026-10-09' ? 2 : 0
        expect(analytics.historicalCount).toBe(expectedHistorical)
        expect(calculateStreak(tracker, liveEntries, '2026-10-12').qualifyingCount).toBeGreaterThanOrEqual(0)
        for (const entry of liveEntries) {
          const status = getTrackerActivityStatus({ tracker, entry, date: entry.date, today: '2026-10-12' })
          expect(status).toBe(tracker.startDate === '2026-10-09' && entry.date < tracker.startDate ? 'historical' : entry.values.done ? 'completed' : 'no-progress')
        }
      }
    }

    await localRepository.restoreTracker(baseTracker.id)
    const restored = await localRepository.getTracker(baseTracker.id)
    expect(restored).toMatchObject({ deletedAt: null, metrics: baseTracker.metrics })
    await expect(db.trackerVerification.get(baseTracker.id)).resolves.toBeUndefined()
    await expect(localRepository.listTrackers()).resolves.toHaveLength(restored?.status === 'archived' ? 0 : 1)
    await expect(localRepository.listTrackers(true)).resolves.toHaveLength(1)
    await expect(localRepository.listDeletedTrackers()).resolves.toEqual([])
    expect(await localRepository.listTrackerEntriesForTracker(baseTracker.id)).toHaveLength(2)
  }, operationCount > 150 ? 90_000 : 5_000)
})
