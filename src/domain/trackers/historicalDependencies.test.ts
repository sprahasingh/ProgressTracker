import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerMetricDefinition } from './types'
import { currentRuleDependencyIssue, historicalRuleDependencyIssue } from './historicalDependencies'
import { trackerEvaluationSnapshot } from './ruleVersions'

const originalMetric: TrackerMetricDefinition = {
  id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages',
  thresholds: { direction: 'increase', minimum: 1, target: 5, streakQualification: 'minimum' },
}

function tracker(overrides: Partial<TrackerDefinition> = {}): TrackerDefinition {
  const base: TrackerDefinition = {
    schemaVersion: 10, id: 'dependencies', name: 'Reading', description: '', kind: 'habit', status: 'active',
    categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: '2026-01-01',
    metrics: [originalMetric], qualificationRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 1 },
    streakRuleMode: 'same-as-success', customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z', archivedAt: null, deletedAt: null,
  }
  const complete = { ...base, ...overrides }
  return {
    ...complete,
    ruleVersions: complete.ruleVersions ?? [{
      id: 'baseline', effectiveFrom: '2026-01-01', revision: 1, application: 'baseline',
      recordedAt: '2026-01-01T00:00:00Z', evaluation: trackerEvaluationSnapshot(complete),
    }],
  }
}

describe('historical rule dependency compatibility', () => {
  it('blocks a recursively referenced measure introduced after history began', () => {
    const before = tracker()
    const extra = { id: 'minutes', name: 'Minutes', valueType: 'quantity' as const, unit: 'minutes' }
    const after = tracker({
      metrics: [...before.metrics, extra],
      qualificationRule: { kind: 'all', operands: [before.qualificationRule!, { kind: 'comparison', metricId: 'minutes', operator: 'greater-than', value: 0 }] },
    })
    expect(historicalRuleDependencyIssue(before, after)).toBe('This measure was unavailable during part of the selected period.')
  })

  it('blocks every measure introduced on different later dates in one nested rule', () => {
    const before = tracker()
    const first = { id: 'minutes', name: 'Minutes', valueType: 'quantity' as const, unit: 'minutes' }
    const second = { id: 'pages-later', name: 'Later pages', valueType: 'quantity' as const, unit: 'pages' }
    const firstVersion = { ...trackerEvaluationSnapshot(before), metrics: [...before.metrics, first] }
    const secondVersion = { ...trackerEvaluationSnapshot(before), metrics: [...before.metrics, first, second] }
    const history = tracker({
      metrics: [...before.metrics, first, second],
      qualificationRule: { kind: 'all', operands: [
        before.qualificationRule!, { kind: 'comparison', metricId: 'minutes', operator: 'greater-than', value: 0 },
        { kind: 'comparison', metricId: 'pages-later', operator: 'greater-than', value: 0 },
      ] },
      ruleVersions: [
        before.ruleVersions![0]!,
        { id: 'introduce-minutes', effectiveFrom: '2026-02-01', revision: 2, application: 'apply-from-today', recordedAt: '2026-02-01T00:00:00Z', evaluation: firstVersion },
        { id: 'introduce-pages', effectiveFrom: '2026-03-01', revision: 3, application: 'apply-from-today', recordedAt: '2026-03-01T00:00:00Z', evaluation: secondVersion },
      ],
    })
    expect(historicalRuleDependencyIssue(history, history)).toBe('This measure was unavailable during part of the selected period.')
  })

  it('disables all-history when saved v10 snapshots begin after the tracker history start', () => {
    const before = tracker({
      startDate: '2025-12-01',
      ruleVersions: [{
        ...tracker().ruleVersions![0]!, effectiveFrom: '2026-01-01',
      }],
    })
    expect(historicalRuleDependencyIssue(before, before, '2025-12-01')).toBe('Historical measure settings can’t be verified.')
  })

  it('checks custom streak-rule dependencies independently from success-rule dependencies', () => {
    const before = tracker()
    const later = { id: 'later', name: 'Later', valueType: 'quantity' as const, unit: 'items' }
    const after = tracker({
      metrics: [...before.metrics, later],
      streakRuleMode: 'custom',
      streakRule: { kind: 'any', operands: [{ kind: 'comparison', metricId: 'later', operator: 'greater-than', value: 0 }] },
    })
    expect(historicalRuleDependencyIssue(before, after)).toBe('This measure was unavailable during part of the selected period.')
  })

  it('blocks retired gaps and reactivation gaps in saved date-effective snapshots', () => {
    const first = tracker()
    const gapEvaluation = { ...trackerEvaluationSnapshot(first), metrics: [{ ...originalMetric, retiredAt: '2026-02-01' }] }
    const before = tracker({ ruleVersions: [
      first.ruleVersions![0]!,
      { id: 'retired', effectiveFrom: '2026-02-01', revision: 2, application: 'apply-from-today', recordedAt: '2026-02-01T00:00:00Z', evaluation: gapEvaluation },
      { id: 'reactivated', effectiveFrom: '2026-03-01', revision: 3, application: 'apply-from-today', recordedAt: '2026-03-01T00:00:00Z', evaluation: trackerEvaluationSnapshot(first) },
    ] })
    expect(historicalRuleDependencyIssue(before, before)).toBe('This measure was unavailable during part of the selected period.')
  })

  it.each([
    ['type', { ...originalMetric, valueType: 'duration' as const }],
    ['unit', { ...originalMetric, unit: 'chapters' }],
    ['checklist meaning', { ...originalMetric, valueType: 'checklist' as const, checklistItems: [{ id: 'a', label: 'Warm up', position: 0 }] }],
  ])('blocks changed historical measure meaning: %s', (_property, changed) => {
    const before = tracker({ ruleVersions: [{
      ...tracker().ruleVersions![0]!, evaluation: { ...tracker().ruleVersions![0]!.evaluation, metrics: [changed] },
    }] })
    expect(historicalRuleDependencyIssue(before, tracker())).toBe('Historical measure settings can’t be verified.')
  })

  it.each([
    { direction: 'decrease' as const, minimum: 2, target: 8 },
    { direction: 'increase' as const, minimum: 2, target: 5 },
  ])('allows historical threshold policy changes for safe raw-value recalculation', (thresholds) => {
    const before = tracker()
    const after = tracker({ metrics: [{ ...originalMetric, thresholds: { ...originalMetric.thresholds!, ...thresholds } }] })
    expect(historicalRuleDependencyIssue(before, after)).toBeNull()
  })

  it('rejects a newly effective success or streak rule that references a retired measure', () => {
    const retired = { ...originalMetric, retiredAt: '2026-02-01T00:00:00.000Z' }
    expect(currentRuleDependencyIssue(tracker({ metrics: [retired] }))).toBe('This rule depends on a measure that is no longer available.')
    expect(currentRuleDependencyIssue(tracker({
      metrics: [originalMetric, { id: 'later', name: 'Later', valueType: 'quantity', unit: 'items', retiredAt: '2026-02-01T00:00:00.000Z' }],
      streakRuleMode: 'custom', streakRule: { kind: 'comparison', metricId: 'later', operator: 'greater-than', value: 0 },
    }))).toBe('This rule depends on a measure that is no longer available.')
  })

  it('follows goal-plan and measure-milestone references and blocks rule-dependent rewards', () => {
    const base = tracker()
    const later = { id: 'later', name: 'Later', valueType: 'quantity' as const, unit: 'items' }
    const current = tracker({
      metrics: [...base.metrics, later],
      goalPlanning: { mode: 'daily-recurring', progressSemantics: {}, dailyTargets: { later: 1 }, cumulativeTargets: {} },
    })
    const withLaterPlan = { ...current, ruleVersions: [base.ruleVersions![0]!, {
      id: 'later-plan', effectiveFrom: '2026-02-01', revision: 2, application: 'apply-from-today' as const,
      recordedAt: '2026-02-01T00:00:00Z', evaluation: trackerEvaluationSnapshot(current),
    }] }
    expect(historicalRuleDependencyIssue(withLaterPlan, withLaterPlan)).toBe('This measure was unavailable during part of the selected period.')
    const measureMilestone = { ...current, milestones: [{
      id: 'later-metric', title: 'Later metric', description: '', type: 'cumulative-quantity' as const,
      metricId: 'later', targetValue: 10, measureTypeSnapshot: 'quantity' as const, unitSnapshot: 'items', position: 0,
    }], ruleVersions: withLaterPlan.ruleVersions }
    expect(historicalRuleDependencyIssue(measureMilestone, measureMilestone)).toBe('This measure was unavailable during part of the selected period.')
    const successMilestone = tracker({ milestones: [{ id: 'success', title: 'Success', description: '', type: 'successful-days', targetValue: 10, position: 0 }] })
    expect(historicalRuleDependencyIssue(successMilestone, successMilestone)).toBeNull()
  })
})
