import type { TrackerDefinition, TrackerRule } from './types'

export function ruleUsesCombinedSum(rule: TrackerRule | null | undefined): boolean {
  if (!rule) return false
  if (rule.kind === 'combined-sum') return true
  if (rule.kind === 'threshold' || rule.kind === 'comparison') return false
  return rule.operands.some(ruleUsesCombinedSum)
}

export function trackerUsesCombinedSum(tracker: Pick<TrackerDefinition, 'qualificationRule' | 'streakRule' | 'ruleVersions'>): boolean {
  if (ruleUsesCombinedSum(tracker.qualificationRule) || ruleUsesCombinedSum(tracker.streakRule)) return true
  return tracker.ruleVersions?.some(({ evaluation }) => ruleUsesCombinedSum(evaluation.qualificationRule) || ruleUsesCombinedSum(evaluation.streakRule)) ?? false
}
