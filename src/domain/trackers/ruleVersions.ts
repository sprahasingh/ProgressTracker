import type { TrackerDefinition, TrackerEvaluationSnapshot, TrackerRule, TrackerRuleVersion } from './types'
import { calendarDateInTimeZone } from '../../db/calendarDate'

export type RuleApplicationMode = 'apply-from-today' | 'recalculate-all-history'

type VersionedTracker = Pick<TrackerDefinition, 'ruleVersions'> & Partial<TrackerEvaluationSnapshot>

const evaluationKeys = [
  'schedule', 'startDate', 'deadline', 'scheduling', 'metrics',
  'qualificationRule', 'streakRuleMode', 'streakRule', 'strictMode',
] as const

export function trackerEvaluationSnapshot(tracker: TrackerDefinition): TrackerEvaluationSnapshot {
  return {
    schedule: tracker.schedule,
    startDate: tracker.startDate ?? null,
    deadline: tracker.deadline ?? null,
    scheduling: tracker.scheduling ?? null,
    metrics: tracker.metrics,
    qualificationRule: tracker.qualificationRule ?? null,
    streakRuleMode: tracker.streakRuleMode ?? null,
    streakRule: tracker.streakRule ?? null,
    strictMode: tracker.strictMode ?? false,
  }
}

/** Compare normalized evaluation settings so touched-but-identical and cosmetic edits do not version rules. */
export function trackerEvaluationChanged(before: TrackerDefinition, after: TrackerDefinition, timeZone = 'UTC'): boolean {
  return trackerEvaluationSignature(comparableEvaluation(before, timeZone)) !== trackerEvaluationSignature(comparableEvaluation(after, timeZone))
}

export function trackerEvaluationSignature(evaluation: Partial<TrackerEvaluationSnapshot>): string {
  const referencedMetricIds = new Set<string>()
  collectRuleMetricIds(evaluation.qualificationRule, referencedMetricIds)
  if (evaluation.streakRuleMode === 'custom') collectRuleMetricIds(evaluation.streakRule, referencedMetricIds)
  if (!evaluation.qualificationRule) {
    const firstActiveMetric = evaluation.metrics?.find((metric) => metric.retiredAt === undefined)
    if (firstActiveMetric) referencedMetricIds.add(firstActiveMetric.id)
  }
  return stableStringify({
    schedule: evaluation.schedule ?? null,
    startDate: evaluation.startDate ?? null,
    deadline: evaluation.deadline ?? null,
    scheduling: evaluation.scheduling ?? null,
    metrics: (evaluation.metrics ?? []).filter((metric) => referencedMetricIds.has(metric.id)).map((metric) => ({
      id: metric.id,
      valueType: metric.valueType,
      unit: metric.unit ?? null,
      thresholds: metric.thresholds ?? null,
      checklistItems: metric.checklistItems?.map((item) => item.id).sort() ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    qualificationRule: evaluation.qualificationRule ?? null,
    streakRuleMode: evaluation.streakRuleMode ?? null,
    streakRule: evaluation.streakRule ?? null,
    strictMode: evaluation.strictMode ?? false,
  })
}

function collectRuleMetricIds(rule: TrackerRule | null | undefined, ids: Set<string>): void {
  if (!rule) return
  if (rule.kind === 'threshold' || rule.kind === 'comparison') {
    ids.add(rule.metricId)
    return
  }
  for (const operand of rule.operands) collectRuleMetricIds(operand, ids)
}

function comparableEvaluation(tracker: TrackerDefinition, timeZone: string): Partial<TrackerEvaluationSnapshot> {
  const snapshot = trackerEvaluationSnapshot(tracker)
  // A legacy tracker with no explicit start date uses its creation date in the
  // workspace timezone. Materializing that same date in the editor is not a
  // historical rule change.
  const inferredStart = calendarDateInTimeZone(tracker.createdAt, timeZone)
  return {
    ...snapshot,
    startDate: snapshot.startDate ?? inferredStart,
  }
}

/** Resolve an inclusive effective date. Versions are validated as ordered and unique by the tracker schema. */
export function trackerEvaluationForDate<T extends VersionedTracker>(tracker: T, date: string): Partial<TrackerEvaluationSnapshot> {
  const version = trackerRuleVersionForDate(tracker, date)
  if (version) return version.evaluation
  const current: Partial<TrackerEvaluationSnapshot> = {}
  for (const key of evaluationKeys) {
    const value = tracker[key]
    if (value !== undefined) Object.assign(current, { [key]: value })
  }
  return current
}

export function trackerRuleVersionForDate<T extends VersionedTracker>(tracker: T, date: string): TrackerRuleVersion | undefined {
  for (let index = (tracker.ruleVersions?.length ?? 0) - 1; index >= 0; index--) {
    const version = tracker.ruleVersions![index]!
    if (version.effectiveFrom <= date) return version
  }
  return undefined
}

export function trackerDefinitionForDate(tracker: TrackerDefinition, date: string): TrackerDefinition {
  const version = trackerRuleVersionForDate(tracker, date)
  if (!version) return tracker
  const evaluation = version.evaluation
  return {
    ...tracker,
    ...evaluation,
    startDate: evaluation.startDate ?? undefined,
    deadline: evaluation.deadline ?? undefined,
    scheduling: evaluation.scheduling ?? undefined,
    qualificationRule: evaluation.qualificationRule ?? undefined,
    streakRuleMode: evaluation.streakRuleMode ?? undefined,
    streakRule: evaluation.streakRule ?? undefined,
    strictMode: evaluation.strictMode === true,
  }
}

export function trackerStrictModeForDate(tracker: TrackerDefinition, date: string): boolean {
  const version = trackerRuleVersionForDate(tracker, date)
  return version ? version.evaluation.strictMode === true : tracker.strictMode === true
}

/**
 * Materialize the old definition as a safe baseline on the first prospective
 * edit. Same-day edits replace that day's head version; retrospective edits
 * intentionally collapse evaluation to one version over the full history.
 */
export function versionTrackerRuleChange(input: {
  before: TrackerDefinition
  after: TrackerDefinition
  application: RuleApplicationMode
  today: string
  historyStartDate: string
  recordedAt: string
}): TrackerDefinition {
  const { before, after, application, today, historyStartDate, recordedAt } = input
  const prior = before.ruleVersions ?? (historyStartDate < today ? [{
    id: crypto.randomUUID(),
    effectiveFrom: historyStartDate,
    revision: 1,
    application: 'baseline' as const,
    recordedAt: before.createdAt,
    evaluation: trackerEvaluationSnapshot(before),
  }] : [])
  const revision = Math.max(0, ...prior.map((version) => version.revision)) + 1
  const effectiveFrom = application === 'apply-from-today'
    ? today
    : historyStartDate
  const version: TrackerRuleVersion = {
    id: crypto.randomUUID(),
    effectiveFrom,
    revision,
    application,
    recordedAt,
    evaluation: trackerEvaluationSnapshot(after),
  }
  const ruleVersions = application === 'recalculate-all-history'
    ? [version]
    : [...prior.filter((item) => item.effectiveFrom < today), version]

  return { ...after, schemaVersion: 10, ruleVersions }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortRecursively(value))
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecursively)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortRecursively(child)]))
}
