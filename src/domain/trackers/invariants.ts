import type { TrackerDefinition } from './types'

/** Prevent an existing metric ID from changing the type of its saved values. */
export function trackerMetricTypeChange(previous: TrackerDefinition, next: TrackerDefinition): string | undefined {
  const previousById = new Map(previous.metrics.map((metric) => [metric.id, metric]))
  return next.metrics.find((metric) => previousById.get(metric.id)?.valueType !== undefined && previousById.get(metric.id)!.valueType !== metric.valueType)?.name
}

/** Keep retired metric definitions and their interpretation stable after retirement. */
export function retiredMetricMeaningChange(previous: TrackerDefinition, next: TrackerDefinition): string | undefined {
  const nextById = new Map(next.metrics.map((metric) => [metric.id, metric]))
  for (const metric of previous.metrics) {
    const candidate = nextById.get(metric.id)
    if (metric.retiredAt && !candidate) return metric.name
    if (!candidate || (!metric.retiredAt && !candidate.retiredAt)) continue
    const { retiredAt: _oldRetiredAt, ...oldMeaning } = metric
    const { retiredAt: _nextRetiredAt, ...nextMeaning } = candidate
    if (JSON.stringify(oldMeaning) !== JSON.stringify(nextMeaning)) return metric.name
  }
  return undefined
}

/** Keep the definition stable for any measure whose values have already been recorded. */
export function historicalMetricMeaningChange(previous: TrackerDefinition, next: TrackerDefinition, historicalMetricIds: ReadonlySet<string>): string | undefined {
  const nextById = new Map(next.metrics.map((metric) => [metric.id, metric]))
  for (const metric of previous.metrics) {
    if (!historicalMetricIds.has(metric.id)) continue
    const candidate = nextById.get(metric.id)
    if (!candidate) return metric.name
    const { retiredAt: _oldRetiredAt, precision: _oldPrecision, ...oldMeaning } = metric
    const { retiredAt: _nextRetiredAt, precision: _nextPrecision, ...nextMeaning } = candidate
    if (JSON.stringify(oldMeaning) !== JSON.stringify(nextMeaning)) return metric.name
  }
  return undefined
}
