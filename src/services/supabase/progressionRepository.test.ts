import { describe, expect, it } from 'vitest'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { activeAchievementOccurrences, calculateConsistencySummary, makeAchievementStates, type AchievementHistoryEvent } from './progressionRepository'

const tracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'consistency-tracker', name: 'Daily reading', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: '2026-09-01',
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }], qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
  customFields: [], milestones: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

function entry(id: string, date: string, outcome: StoredTrackerEntry['outcome'] = 'recorded', done = outcome === 'recorded'): StoredTrackerEntry {
  return { id, trackerId: tracker.id, date, outcome, values: { done }, note: '', createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, deletedAt: null }
}

describe('progression data contract calculations', () => {
  it('uses occurrence identities and exact reversals to derive the same live state for every badge surface', () => {
    const unlock = (id: string, date: string, tier: number): AchievementHistoryEvent => ({
      id, achievementId: 'perfect-week', tier, generation: 1, eventType: 'unlocked', recordedAt: `${date}T12:00:00.000Z`,
      sourceEventId: null, sourceDate: date, reversesEventId: null, retainedAfterTrackerDeletion: false,
      trackerDisplayName: null, rewardReasonCode: null, rewardXpDelta: null,
    })
    const first = unlock('week-1', '2026-09-07', 1)
    const second = unlock('week-2', '2026-09-14', 2)
    const third = unlock('week-3', '2026-09-21', 3)
    const reversedThird = { ...third, id: 'reverse-week-3', eventType: 'revoked' as const, reversesEventId: third.id }
    const history = [first, second, third, reversedThird, reversedThird]
    expect(activeAchievementOccurrences(history).map(({ id }) => id)).toEqual(['week-1', 'week-2'])
    const [badge] = makeAchievementStates(
      [{ achievement_id: 'perfect-week', progress: 0, target: 1, current_tier: 3, repeatable: true }],
      history.map((event) => ({
        id: event.id, achievement_id: event.achievementId, tier: event.tier, generation: event.generation,
        event_type: event.eventType, recorded_at: event.recordedAt, source_event_id: event.sourceEventId,
        source_date: event.sourceDate, reverses_event_id: event.reversesEventId,
      })),
    )
    expect(badge).toMatchObject({ earned: true, repeatable: true, validAwardCount: 2, currentTier: 2, firstEarnedAt: '2026-09-07', lastEarnedAt: '2026-09-14' })
  })

  it('keeps one-time awards at one valid occurrence and does not infer an award from progress alone', () => {
    const raw = (id: string, eventType: 'unlocked' | 'revoked', reversesEventId: string | null = null) => ({
      id, achievement_id: 'first-step', tier: 1, generation: 1, event_type: eventType,
      recorded_at: `2026-09-01T12:00:00.000Z`, source_event_id: null, source_date: '2026-09-01', reverses_event_id: reversesEventId,
    })
    const [earned] = makeAchievementStates(
      [{ achievement_id: 'first-step', progress: 1, target: 1, current_tier: 1, repeatable: false }],
      [raw('dedicated-1', 'unlocked'), raw('dedicated-2', 'unlocked')],
    )
    expect(earned).toMatchObject({ earned: true, repeatable: false, validAwardCount: 1, currentTier: 1 })
    const [locked] = makeAchievementStates(
      [{ achievement_id: 'first-step', progress: 1, target: 1, current_tier: 0, repeatable: false }], [],
    )
    expect(locked).toMatchObject({ earned: false, validAwardCount: 0, progress: 1, target: 1 })
  })

  it('averages recorded eligible activity across the latest 30 closed days and excludes skips, today, and future dates', () => {
    const entries = Array.from({ length: 30 }, (_, index) => {
      const time = Date.parse('2026-09-13T00:00:00.000Z') + index * 86_400_000
      const date = new Date(time).toISOString().slice(0, 10)
      return entry(`saved-${index}`, date, index === 29 ? 'skipped' : 'recorded')
    })
    entries.push(entry('today', '2026-10-13'), entry('future', '2026-10-14'))
    const result = calculateConsistencySummary({ trackers: [tracker], entries, today: '2026-10-13', timeZone: 'UTC' })
    expect(result.eligibleDays).toBe(30)
    expect(result.score).toBe(97)
    expect(result.dailyAdherence[0]?.date).toBe('2026-10-12')
    expect(result.dailyAdherence.at(-1)?.date).toBe('2026-09-13')
  })

  it('returns an empty score when history is before the latest tracker definition change', () => {
    const recentlyEdited = { ...tracker, updatedAt: '2026-10-13T08:00:00.000Z' }
    const result = calculateConsistencySummary({ trackers: [recentlyEdited], entries: [entry('yesterday', '2026-10-12')], today: '2026-10-13', timeZone: 'UTC' })
    expect(result).toEqual({ score: null, eligibleDays: 0, dailyAdherence: [] })
  })

  it('returns an empty score when no active tracker is eligible', () => {
    const result = calculateConsistencySummary({ trackers: [{ ...tracker, status: 'archived' }], entries: [], today: '2026-10-13' })
    expect(result.score).toBeNull()
    expect(result.eligibleDays).toBe(0)
  })

  it('does not count a recorded entry that fails the tracker qualification rule', () => {
    const oneDayTracker = { ...tracker, startDate: '2026-10-12', createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' }
    const result = calculateConsistencySummary({ trackers: [oneDayTracker], entries: [entry('failed-rule', '2026-10-12', 'recorded', false)], today: '2026-10-13', timeZone: 'UTC' })
    expect(result).toMatchObject({ score: 0, eligibleDays: 1, dailyAdherence: [{ date: '2026-10-12', completed: 0, eligible: 1 }] })
  })
})
