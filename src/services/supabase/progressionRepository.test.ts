import { describe, expect, it } from 'vitest'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { activeAchievementOccurrences, calculateConsistencySummary, fullyReversedProgressionEventIds, localProvisional, makeAchievementStates, mapEvent, type AchievementHistoryEvent, type ProgressionEvent } from './progressionRepository'

const tracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'consistency-tracker', name: 'Daily reading', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: '2026-09-01',
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }], qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
  customFields: [], milestones: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

function entry(id: string, date: string, outcome: StoredTrackerEntry['outcome'] = 'recorded', done = outcome === 'recorded'): StoredTrackerEntry {
  return { id, trackerId: tracker.id, date, outcome, values: { done }, note: '', createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, deletedAt: null }
}

function xpEvent(id: string, xpDelta: number, overrides: Partial<ProgressionEvent> = {}): ProgressionEvent {
  return {
    id, userId: 'account-1', effectiveDate: '2026-10-13', recordedAt: `2026-10-13T12:00:00.000Z`, xpDelta,
    eventCategory: 'check_in', reasonCode: 'DAILY_CHECK_IN_COMPLETED', reversesEventId: null,
    sourceId: null, trackerId: null, goalId: null, displayName: 'Progression reward', deletedTracker: false,
    ...overrides,
  }
}

describe('progression data contract calculations', () => {
  it('maps tracker sources from PostgREST object and array relationship shapes', () => {
    const source = { source_id: 'entry-1', tracker_id: 'tracker-1', goal_id: null, display_name: 'Daily reading' }
    const row = {
      id: 'event-1', user_id: 'account-1', effective_date: '2026-10-13', recorded_at: '2026-10-13T12:00:00.000Z', xp_delta: 10,
      event_category: 'score', reason_code: 'DAILY_CHECK_IN_COMPLETED', reverses_event_id: null,
    }
    expect(mapEvent({ ...row, progression_event_sources: source })).toMatchObject({ sourceId: 'entry-1', trackerId: 'tracker-1', displayName: 'Daily reading' })
    expect(mapEvent({ ...row, progression_event_sources: [source] })).toMatchObject({ sourceId: 'entry-1', trackerId: 'tracker-1', displayName: 'Daily reading' })
  })

  it('hides only complete reversal groups linked to their original award', () => {
    const award = xpEvent('award', 10)
    const reversal = xpEvent('reversal', -10, { eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: award.id })
    expect(fullyReversedProgressionEventIds([award, reversal])).toEqual(new Set(['award', 'reversal']))
  })

  it('keeps unreversed, orphaned, partial, and malformed transactions visible', () => {
    const award = xpEvent('award', 10)
    const orphan = xpEvent('orphan-reversal', -10, { eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: 'missing-award' })
    const partial = xpEvent('partial-reversal', -5, { eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: award.id })
    const malformed = xpEvent('malformed-reversal', -10, { eventCategory: 'check_in', reasonCode: 'AWARD_REVERSAL', reversesEventId: award.id })
    expect(fullyReversedProgressionEventIds([award])).toEqual(new Set())
    expect(fullyReversedProgressionEventIds([orphan])).toEqual(new Set())
    expect(fullyReversedProgressionEventIds([award, partial])).toEqual(new Set())
    expect(fullyReversedProgressionEventIds([award, malformed])).toEqual(new Set())
  })

  it('sums multiple direct reversals and keeps every member visible until their net reaches zero', () => {
    const award = xpEvent('award', 10)
    const first = xpEvent('first-reversal', -4, { eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: award.id })
    const second = xpEvent('second-reversal', -6, { eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: award.id })
    expect(fullyReversedProgressionEventIds([award, first])).toEqual(new Set())
    expect(fullyReversedProgressionEventIds([award, first, second])).toEqual(new Set(['award', 'first-reversal', 'second-reversal']))
  })

  it('matches each re-award independently and ignores unrelated awards with the same XP value', () => {
    const original = xpEvent('original', 10)
    const originalReversal = xpEvent('original-reversal', -10, { eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: original.id })
    const reAward = xpEvent('re-award', 10, { recordedAt: '2026-10-13T13:00:00.000Z' })
    const unrelatedAward = xpEvent('unrelated-award', 10, { recordedAt: '2026-10-13T14:00:00.000Z' })
    const reAwardReversal = xpEvent('re-award-reversal', -10, { eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: reAward.id })
    expect(fullyReversedProgressionEventIds([original, originalReversal, reAward, unrelatedAward])).toEqual(new Set(['original', 'original-reversal']))
    expect(fullyReversedProgressionEventIds([original, originalReversal, reAward, reAwardReversal, unrelatedAward])).toEqual(new Set(['original', 'original-reversal', 're-award', 're-award-reversal']))
  })

  it('does not match transactions across user ownership boundaries', () => {
    const award = xpEvent('award', 10)
    const otherUsersReversal = xpEvent('reversal', -10, { userId: 'different-account', eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: award.id })
    expect(fullyReversedProgressionEventIds([award, otherUsersReversal])).toEqual(new Set())
  })

  it('restores provisional check-in and perfect-day rewards after their prior awards are fully reversed', () => {
    const savedEntry = entry('source-entry', '2026-10-13')
    const snapshot = {
      trackers: [tracker], entries: [savedEntry], pendingEntryIds: new Set([savedEntry.id]),
      holidays: new Set<string>(), timeZone: 'UTC',
    }
    const checkIn = xpEvent('check-in-award', 10, { sourceId: savedEntry.id })
    const checkInReversal = xpEvent('check-in-reversal', -10, {
      eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: checkIn.id, sourceId: savedEntry.id,
    })
    const perfectDay = xpEvent('perfect-day-award', 20, { reasonCode: 'PERFECT_DAY_BONUS', sourceId: savedEntry.id })
    const perfectDayReversal = xpEvent('perfect-day-reversal', -20, {
      eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: perfectDay.id, sourceId: savedEntry.id,
    })

    expect(localProvisional(snapshot, savedEntry.date, [checkIn, checkInReversal, perfectDay, perfectDayReversal])
      .map(({ xpDelta }) => xpDelta).sort((left, right) => left - right)).toEqual([10, 20])
  })

  it('does not offer provisional rewards when a current award generation is still active', () => {
    const savedEntry = entry('source-entry', '2026-10-13')
    const snapshot = {
      trackers: [tracker], entries: [savedEntry], pendingEntryIds: new Set([savedEntry.id]),
      holidays: new Set<string>(), timeZone: 'UTC',
    }
    const original = xpEvent('original-award', 10, { sourceId: savedEntry.id })
    const reversal = xpEvent('original-reversal', -10, {
      eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: original.id, sourceId: savedEntry.id,
    })
    const currentGeneration = xpEvent('current-award', 10, { sourceId: savedEntry.id, recordedAt: '2026-10-14T12:00:00.000Z' })

    expect(localProvisional(snapshot, savedEntry.date, [original, reversal, currentGeneration])).toEqual([])
  })

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

  it('uses historical reward source snapshots and XP when building badge unlock history', () => {
    const [badge] = makeAchievementStates(
      [{ achievement_id: 'first-step', progress: 1, target: 1, current_tier: 1, repeatable: false }],
      [{ id: 'unlock', achievement_id: 'first-step', tier: 1, generation: 1, event_type: 'unlocked',
        recorded_at: '2026-09-01T12:00:00.000Z', source_event_id: 'xp-source', source_date: '2026-09-01', reverses_event_id: null }],
      new Set(), new Map(), new Map([['unlock', 'tracker-id']]),
      new Map([['unlock', { displayName: 'Original tracker name', reasonCode: 'DAILY_CHECK_IN_COMPLETED', xpDelta: 10, goalId: null, reversed: true }]]),
    )
    expect(badge?.history[0]).toMatchObject({
      trackerId: 'tracker-id', trackerDisplayName: 'Original tracker name',
      rewardReasonCode: 'DAILY_CHECK_IN_COMPLETED', rewardXpDelta: 10, rewardReversed: true,
    })
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

  it('keeps success-based consistency separate from custom streak-only activity', () => {
    const independentRules = {
      ...tracker,
      schemaVersion: 8 as const,
      startDate: '2026-10-12',
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'pages', operator: 'at-least' as const, value: 5 },
      streakRuleMode: 'custom' as const,
      streakRule: { kind: 'comparison' as const, metricId: 'pages', operator: 'at-least' as const, value: 1 },
    }
    const result = calculateConsistencySummary({
      trackers: [independentRules],
      entries: [{ ...entry('streak-only', '2026-10-12'), values: { pages: 1 } }],
      today: '2026-10-13', timeZone: 'UTC',
    })
    expect(result).toMatchObject({ score: 0, eligibleDays: 1, dailyAdherence: [{ date: '2026-10-12', completed: 0, eligible: 1 }] })
  })
})
