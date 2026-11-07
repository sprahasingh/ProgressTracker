import { describe, expect, it } from 'vitest'
import { ruleUsesCombinedSum, trackerUsesCombinedSum } from './combinedSumRules'

const sum = { kind: 'combined-sum' as const, metricIds: ['a', 'b'], target: 5 }

describe('Combined Sum rule detection', () => {
  it('finds Combined Sum nested in success or custom streak conditions', () => {
    expect(ruleUsesCombinedSum({ kind: 'all', operands: [{ kind: 'comparison', metricId: 'a', operator: 'at-least', value: 1 }, sum] })).toBe(true)
    expect(trackerUsesCombinedSum({ qualificationRule: undefined, streakRule: { kind: 'any', operands: [sum, { kind: 'comparison', metricId: 'a', operator: 'at-least', value: 1 }] }, ruleVersions: [] })).toBe(true)
  })

  it('finds Combined Sum in date-versioned historical rule snapshots', () => {
    expect(trackerUsesCombinedSum({
      qualificationRule: { kind: 'comparison', metricId: 'a', operator: 'at-least', value: 1 },
      streakRule: undefined,
      ruleVersions: [{ id: 'v1', effectiveFrom: '2026-01-01', revision: 1, application: 'baseline', recordedAt: '2026-01-01T00:00:00.000Z', evaluation: {
        schedule: { kind: 'every-day' }, metrics: [], qualificationRule: { kind: 'at-least', required: 1, operands: [sum] },
      } }],
    })).toBe(true)
  })

  it('leaves ordinary rules and schema versions independent of feature detection', () => {
    expect(ruleUsesCombinedSum({ kind: 'comparison', metricId: 'a', operator: 'at-least', value: 1 })).toBe(false)
    expect(trackerUsesCombinedSum({ qualificationRule: undefined, streakRule: undefined, ruleVersions: [] })).toBe(false)
  })
})
