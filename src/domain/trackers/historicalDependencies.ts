import type { TrackerDefinition, TrackerEvaluationSnapshot, TrackerMetricDefinition, TrackerRule } from './types'

type RuleSnapshot = Pick<TrackerDefinition, 'metrics'> & {
  qualificationRule?: TrackerDefinition['qualificationRule'] | null
  streakRuleMode?: TrackerDefinition['streakRuleMode'] | null
  streakRule?: TrackerDefinition['streakRule'] | null
}
  & Partial<Pick<TrackerDefinition, 'ruleVersions' | 'milestones' | 'goalPlanning'>>

/** Collect measure references recursively so composite rules cannot hide dependencies. */
export function referencedMetricIds(...rules: Array<TrackerRule | null | undefined>): Set<string> {
  const ids = new Set<string>()
  const visit = (rule: TrackerRule | null | undefined): void => {
    if (!rule) return
    if (rule.kind === 'threshold' || rule.kind === 'comparison') {
      ids.add(rule.metricId)
      return
    }
    rule.operands.forEach(visit)
  }
  rules.forEach(visit)
  return ids
}

function ruleDependencies(tracker: RuleSnapshot): Set<string> {
  const ids = referencedMetricIds(
    tracker.qualificationRule,
    tracker.streakRuleMode === 'custom' ? tracker.streakRule : tracker.qualificationRule,
  )
  if (!tracker.qualificationRule) {
    const implicitMetric = tracker.metrics.find((metric) => metric.retiredAt === undefined)
    if (implicitMetric) ids.add(implicitMetric.id)
  }
  return ids
}

/** A newly effective rule may only use measures available in that version. */
export function currentRuleDependencyIssue(tracker: RuleSnapshot): string | null {
  const activeMetricIds = new Set(tracker.metrics.filter((metric) => metric.retiredAt === undefined).map((metric) => metric.id))
  for (const metricId of ruleDependencies(tracker)) {
    if (!activeMetricIds.has(metricId)) return 'This rule depends on a measure that is no longer available.'
  }
  return null
}

function semanticSignature(metric: TrackerMetricDefinition): string {
  return JSON.stringify({
    id: metric.id,
    name: metric.name,
    valueType: metric.valueType,
    unit: metric.unit ?? null,
    thresholds: metric.thresholds ?? null,
    checklistItems: metric.checklistItems?.map(({ id, label }) => ({ id, label })) ?? null,
  })
}

/**
 * Return a conservative explanation when replacing date-effective evaluation
 * history with one all-history rule snapshot would change a rule dependency.
 */
export function historicalRuleDependencyIssue(before: TrackerDefinition, after: TrackerDefinition, affectedStartDate?: string): string | null {
  if (before.schemaVersion < 10 || !before.ruleVersions?.length) {
    return 'Historical measure settings can’t be verified.'
  }
  const historyStart = affectedStartDate ?? before.startDate ?? before.createdAt.slice(0, 10)
  if (before.ruleVersions[0]!.effectiveFrom > historyStart) {
    return 'Historical measure settings can’t be verified.'
  }
  const dependencies = ruleDependencies(after)
  const milestones = before.milestones ?? []
  if (milestones.some((milestone) => milestone.type === 'successful-days' || milestone.type === 'streak-length')) {
    return 'Past milestone rewards could change.'
  }

  const goalPlanDependencies = new Set([
    ...Object.keys(before.goalPlanning?.progressSemantics ?? {}),
    ...Object.keys(before.goalPlanning?.dailyTargets ?? {}),
    ...Object.keys(before.goalPlanning?.cumulativeTargets ?? {}),
    ...Object.keys(before.goalPlanning?.allocations ?? {}),
    ...Object.keys(before.goalPlanning?.manualAllocations ?? {}),
  ])
  for (const metricId of goalPlanDependencies) dependencies.add(metricId)
  for (const milestone of milestones) if (milestone.metricId) dependencies.add(milestone.metricId)

  const proposed = new Map(after.metrics.map((metric) => [metric.id, metric]))
  const evaluations: Array<Pick<TrackerEvaluationSnapshot, 'metrics'>> = before.ruleVersions?.length
    ? before.ruleVersions.map(({ evaluation }) => evaluation)
    : [{ metrics: before.metrics }]

  for (const evaluation of evaluations) {
    const historical = new Map(evaluation.metrics.map((metric) => [metric.id, metric]))
    for (const metricId of dependencies) {
      const historicalMetric = historical.get(metricId)
      if (!historicalMetric || historicalMetric.retiredAt !== undefined) {
        return 'This measure was unavailable during part of the selected period.'
      }
      const proposedMetric = proposed.get(metricId)
      if (!proposedMetric || proposedMetric.retiredAt !== undefined) {
        return 'This rule depends on a measure that is no longer available.'
      }
      if (semanticSignature(historicalMetric) !== semanticSignature(proposedMetric)) {
        return 'Historical measure settings can’t be verified.'
      }
    }
  }
  return null
}
