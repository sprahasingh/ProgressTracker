import { afterEach, describe, expect, it } from 'vitest'
import { activateWorkspace, db } from './database'
import { localRepository } from './localRepository'
import type { StoredTrackerDefinition } from './models'
import { calculateTrackerAnalytics } from '../domain/trackers/analytics'
import { calculateStreak } from '../domain/trackers/progression'
import { getTrackerActivityStatus } from '../domain/trackers/activityStatus'

const seed = 0x51a7e
const baseTracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'lifecycle-machine', name: 'Lifecycle routine', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: '2026-10-01', deadline: '2026-10-20',
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
  qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true }, customFields: [], milestones: [],
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

afterEach(async () => { db.close(); await db.delete() })

describe('tracker lifecycle state machine', () => {
  it('preserves explicit values across deterministic edits, archive, Bin, and restoration', async () => {
    await activateWorkspace('lifecycle-machine-owner')
    await localRepository.saveTracker(baseTracker)
    const original = [
      await localRepository.saveTrackerEntry({ trackerId: baseTracker.id, date: '2026-10-07', outcome: 'recorded', values: { done: true }, note: 'initial seven' }),
      await localRepository.saveTrackerEntry({ trackerId: baseTracker.id, date: '2026-10-08', outcome: 'recorded', values: { done: false }, note: 'initial eight' }),
    ]

    let state = seed >>> 0
    const history: string[] = []
    let expectedValues = new Map(original.map((entry) => [entry.date, JSON.stringify({ values: entry.values, note: entry.note })]))
    let binned = false
    for (let step = 0; step < 40; step += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      const action = state % 4
      const actionLabel = ['change-period', 'edit-entry', 'toggle-archive', 'toggle-bin'][action]!
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
    expect(await localRepository.listTrackerEntriesForTracker(baseTracker.id)).toHaveLength(2)
  })
})
