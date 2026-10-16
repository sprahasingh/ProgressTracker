import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry } from './types'
import { calculateStreak, qualifiesForStreak } from './progression'
import { evaluateTrackerEntry, isTrackerInActivePeriod, isTrackerScheduledOccurrence } from './planning'
import { isEffectiveDateEligible } from './scheduling'
import { trackerDefinitionForDate, trackerEvaluationChanged, trackerEvaluationSnapshot, trackerRuleVersionForDate, versionTrackerRuleChange } from './ruleVersions'

const oldTracker: TrackerDefinition = {
  schemaVersion: 9, id: 'versioned', name: 'Practice', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: '2026-10-01',
  scheduling: { mode: 'ongoing' },
  metrics: [{ id: 'amount', name: 'Amount', valueType: 'quantity', thresholds: { direction: 'increase', minimum: 5, streakQualification: 'minimum' } }],
  qualificationRule: { kind: 'comparison', metricId: 'amount', operator: 'at-least', value: 5 },
  streakRuleMode: 'same-as-success', customFields: [], milestones: [],
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

const legacyV6Tracker: TrackerDefinition = {
  schemaVersion: 6, id: 'legacy-v6-rule-edit', name: '100 Days Of MERN', description: '',
  kind: 'challenge', status: 'active', categoryId: null, tags: [], icon: '', accent: '#315e46',
  schedule: { kind: 'every-day' }, startDate: '2026-10-16', deadline: '2027-01-23',
  scheduling: { mode: 'effective', effectiveDays: 100, planningTimeZone: 'Asia/Calcutta' },
  metrics: [{
    id: 'progress', name: 'Progress', valueType: 'quantity', unit: 'Hours',
    precision: { decimalPlaces: 1, increment: 0.5 },
    thresholds: { direction: 'increase', minimum: 1, target: 1.5, stretch: 2, streakQualification: 'any-recorded-value' },
  }],
  qualificationRule: { kind: 'threshold', metricId: 'progress', level: 'minimum' },
  customFields: [], milestones: [], strictMode: false,
  createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z', archivedAt: null, deletedAt: null,
}

function changeThreshold(tracker: TrackerDefinition, threshold: number): TrackerDefinition {
  return {
    ...tracker,
    metrics: tracker.metrics.map((metric) => ({ ...metric, thresholds: { direction: 'increase', minimum: threshold, streakQualification: 'minimum' } })),
    qualificationRule: { kind: 'comparison', metricId: 'amount', operator: 'at-least', value: threshold },
  }
}

function entry(date: string, amount: number): TrackerEntry {
  return { id: `entry-${date}`, trackerId: oldTracker.id, date, outcome: 'recorded', values: { amount }, note: '', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', deletedAt: null }
}

function prospective(before: TrackerDefinition, after: TrackerDefinition, today = '2026-10-10') {
  return versionTrackerRuleChange({
    before, after, application: 'apply-from-today', today,
    historyStartDate: '2026-10-01', recordedAt: '2026-10-10T12:00:00.000Z',
  })
}

describe('date-effective tracker rule history', () => {
  it('builds a v10 baseline from the exact legacy v6 definition without filling missing fields from modern defaults', () => {
    expect(legacyV6Tracker).not.toHaveProperty('streakRule')
    expect(legacyV6Tracker).not.toHaveProperty('streakRuleMode')
    expect(legacyV6Tracker.scheduling).not.toHaveProperty('effectiveDayCounting')

    const after: TrackerDefinition = {
      ...legacyV6Tracker,
      streakRuleMode: 'custom',
      streakRule: { kind: 'threshold', metricId: 'progress', level: 'target' },
    }
    const versioned = versionTrackerRuleChange({
      before: legacyV6Tracker, after, application: 'apply-from-today', today: '2026-10-17',
      historyStartDate: '2026-10-16', recordedAt: '2026-10-17T01:00:00.000Z',
    })
    const baseline = versioned.ruleVersions?.[0]

    expect(versioned.ruleVersions).toHaveLength(2)
    expect(baseline).toMatchObject({ effectiveFrom: '2026-10-16', revision: 1, application: 'baseline' })
    expect(baseline?.evaluation).toMatchObject({
      schedule: legacyV6Tracker.schedule,
      startDate: '2026-10-16',
      deadline: '2027-01-23',
      scheduling: legacyV6Tracker.scheduling,
      metrics: legacyV6Tracker.metrics,
      qualificationRule: legacyV6Tracker.qualificationRule,
      strictMode: false,
    })
    expect(baseline?.evaluation.streakRuleMode).toBeNull()
    expect(baseline?.evaluation.streakRule).toBeNull()
    expect(baseline?.evaluation.scheduling).not.toHaveProperty('effectiveDayCounting')
    expect(versioned.ruleVersions?.[1]).toMatchObject({
      effectiveFrom: '2026-10-17', revision: 2, application: 'apply-from-today',
      evaluation: { streakRuleMode: 'custom', streakRule: { kind: 'threshold', level: 'target' } },
    })
  })

  it('keeps legacy streak and success results before an apply-from-today v10 boundary', () => {
    const historicalEntry: TrackerEntry = {
      id: 'legacy-progress', trackerId: legacyV6Tracker.id, date: '2026-10-16', outcome: 'recorded',
      values: { progress: 0.5 }, note: '', createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z', deletedAt: null,
    }
    const after: TrackerDefinition = {
      ...legacyV6Tracker,
      streakRuleMode: 'custom',
      streakRule: { kind: 'threshold', metricId: 'progress', level: 'target' },
    }
    const versioned = versionTrackerRuleChange({
      before: legacyV6Tracker, after, application: 'apply-from-today', today: '2026-10-17',
      historyStartDate: '2026-10-16', recordedAt: '2026-10-17T01:00:00.000Z',
    })

    expect(evaluateTrackerEntry(versioned, historicalEntry).qualified).toBe(false)
    expect(qualifiesForStreak(versioned, historicalEntry)).toBe(true)
    expect(qualifiesForStreak(versioned, { ...historicalEntry, date: '2026-10-17' })).toBe(false)
  })

  it('uses the legacy effective-day fallback and measure identity for v6 baselines', () => {
    const after: TrackerDefinition = {
      ...legacyV6Tracker,
      scheduling: { ...legacyV6Tracker.scheduling!, effectiveDayCounting: 'all-non-holiday-days' },
      streakRuleMode: 'same-as-success',
    }
    const versioned = versionTrackerRuleChange({
      before: legacyV6Tracker, after, application: 'apply-from-today', today: '2026-10-17',
      historyStartDate: '2026-10-16', recordedAt: '2026-10-17T01:00:00.000Z',
    })

    expect(versioned.ruleVersions?.[0]?.evaluation.metrics[0]?.id).toBe('progress')
    expect(isEffectiveDateEligible(legacyV6Tracker, '2026-10-17', new Set(), 'Asia/Calcutta')).toBe(true)
    expect(isEffectiveDateEligible({
      ...legacyV6Tracker,
      scheduling: { ...legacyV6Tracker.scheduling!, effectiveDayCounting: 'all-non-holiday-days' },
    }, '2026-10-17', new Set(), 'Asia/Calcutta')).toBe(true)
  })

  it('uses the activity date for success and Same as Success, including backdated entries', () => {
    const versioned = prospective(oldTracker, changeThreshold(oldTracker, 10))
    expect(trackerRuleVersionForDate(versioned, '2026-10-09')?.effectiveFrom).toBe('2026-10-01')
    expect(trackerRuleVersionForDate(versioned, '2026-10-10')?.effectiveFrom).toBe('2026-10-10')
    expect(evaluateTrackerEntry(versioned, entry('2026-10-09', 5)).qualified).toBe(true)
    expect(qualifiesForStreak(versioned, entry('2026-10-09', 5))).toBe(true)
    expect(evaluateTrackerEntry(versioned, entry('2026-10-10', 5)).qualified).toBe(false)
    expect(evaluateTrackerEntry(versioned, entry('2026-10-05', 5)).qualified).toBe(true)
  })

  it('keeps scheduled-day and active-period changes date-scoped', () => {
    const before = { ...oldTracker, schedule: { kind: 'weekdays' as const }, startDate: '2026-10-01' }
    const after = { ...changeThreshold(before, 10), schedule: { kind: 'every-day' as const }, startDate: '2026-10-10', strictMode: true }
    const versioned = prospective(before, after)
    expect(isTrackerScheduledOccurrence(versioned, '2026-10-03')).toBe(false)
    expect(isTrackerScheduledOccurrence(versioned, '2026-10-10')).toBe(true)
    expect(isTrackerInActivePeriod(versioned, '2026-10-09')).toBe(true)
    expect(isTrackerInActivePeriod(versioned, '2026-10-10')).toBe(true)
    expect(trackerDefinitionForDate(versioned, '2026-10-09').strictMode).toBe(false)
    expect(trackerDefinitionForDate(versioned, '2026-10-10').strictMode).toBe(true)
  })

  it('carries streak continuity across a rule-version boundary', () => {
    const versioned = prospective(oldTracker, changeThreshold(oldTracker, 10), '2026-10-04')
    const entries = [entry('2026-10-01', 5), entry('2026-10-02', 5), entry('2026-10-03', 5), entry('2026-10-04', 10)]
    expect(calculateStreak(versioned, entries, '2026-10-04').current).toBe(4)
    expect(calculateStreak(versioned, entries, '2026-10-04').longest).toBe(4)
  })

  it('replaces same-day versions and makes a repeated identical edit a no-op', () => {
    const first = prospective(oldTracker, changeThreshold(oldTracker, 10))
    const second = prospective(first, changeThreshold(first, 15))
    expect(second.ruleVersions?.map((version) => version.effectiveFrom)).toEqual(['2026-10-01', '2026-10-10'])
    expect(second.ruleVersions?.map((version) => version.revision)).toEqual([1, 3])
    expect(second.ruleVersions?.at(-1)?.evaluation.metrics[0]?.thresholds?.minimum).toBe(15)
    expect(trackerEvaluationChanged(second, { ...second, name: 'Renamed' })).toBe(false)
  })

  it('collapses old intervals when recalculating all history', () => {
    const prospectiveVersion = prospective(oldTracker, changeThreshold(oldTracker, 10))
    const recalculated = versionTrackerRuleChange({
      before: prospectiveVersion, after: changeThreshold(prospectiveVersion, 5), application: 'recalculate-all-history',
      today: '2026-10-20', historyStartDate: '2026-10-01', recordedAt: '2026-10-20T12:00:00.000Z',
    })
    expect(recalculated.ruleVersions).toHaveLength(1)
    expect(recalculated.ruleVersions?.[0]?.effectiveFrom).toBe('2026-10-01')
    expect(evaluateTrackerEntry(recalculated, entry('2026-10-05', 5)).qualified).toBe(true)
  })

  it('stores a stable snapshot with an immutable measure definition', () => {
    const snapshot = trackerEvaluationSnapshot(oldTracker)
    expect(snapshot).toMatchObject({ schedule: { kind: 'every-day' }, metrics: [{ id: 'amount', valueType: 'quantity' }], qualificationRule: oldTracker.qualificationRule })
    expect(snapshot).not.toHaveProperty('name')
    expect(snapshot).not.toHaveProperty('description')
  })

  it('does not treat measure labels, precision, or retirement metadata as historical rule changes', () => {
    const cosmetic = {
      ...oldTracker,
      name: 'Renamed',
      metrics: [{ ...oldTracker.metrics[0]!, name: 'Pages', precision: { decimalPlaces: 1 as const, increment: 0.1 }, retiredAt: '2026-10-10T00:00:00.000Z' }],
    }
    expect(trackerEvaluationChanged(oldTracker, cosmetic)).toBe(false)
    expect(trackerEvaluationChanged(oldTracker, { ...oldTracker, metrics: [{ ...oldTracker.metrics[0]!, unit: 'minutes' }] })).toBe(true)
    expect(trackerEvaluationChanged(oldTracker, { ...oldTracker, metrics: [...oldTracker.metrics, { id: 'unused', name: 'Unused', valueType: 'quantity' as const }] })).toBe(false)
  })

  it('recognizes an inferred creation date as equivalent to the same explicit workspace date', () => {
    const legacy = { ...oldTracker, startDate: undefined, createdAt: '2026-10-01T00:00:00.000Z' }
    expect(trackerEvaluationChanged(legacy, { ...legacy, startDate: '2026-10-01' }, 'UTC')).toBe(false)
  })
})
