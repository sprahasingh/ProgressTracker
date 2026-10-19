import type { TrackerDefinition, TrackerEntry } from './types'
import { trackerDefinitionForDate, trackerRuleVersionForDate } from './ruleVersions'
import { formatTrackerNumber } from './formatNumber'

/** Formats saved metric values using the metric definitions effective on the entry date. */
export function trackerEntryMetricLabels(tracker: TrackerDefinition, entry: TrackerEntry, options: { showNumericTarget?: boolean } = {}): string[] {
  const datedTracker = trackerDefinitionForDate(tracker, entry.date)
  const datedMetrics = datedTracker.metrics
  const snapshotMetrics = trackerRuleVersionForDate(tracker, entry.date)?.evaluation.metrics

  return datedMetrics.flatMap((metric) => {
    const value = entry.values[metric.id]
    if (typeof value === 'number') {
      const unit = metric.unit ? ` ${metric.unit}` : ''
      const target = options.showNumericTarget ? metric.thresholds?.target : undefined
      if (target === undefined) return [`${metric.name}: ${formatTrackerNumber(value)}${unit}`]
      return [metric.thresholds?.direction === 'decrease'
        ? `${metric.name}: ${formatTrackerNumber(value)}${unit} · target ≤ ${formatTrackerNumber(target)}${unit}`
        : `${metric.name}: ${formatTrackerNumber(value)} / ${formatTrackerNumber(target)}${unit}`]
    }
    if (typeof value === 'boolean') return [`${metric.name}: ${value ? 'Done' : 'Not Done'}`]
    if (metric.valueType !== 'checklist' || typeof value !== 'object' || value === null) return []

    const checked = Object.values(value).filter((item) => item === true).length
    const snapshotMetric = snapshotMetrics?.find((item) => item.id === metric.id && item.valueType === 'checklist')
    const itemIds = new Set(snapshotMetric?.checklistItems?.map((item) => item.id) ?? [])
    const canShowTotal = !Array.isArray(value) && snapshotMetric?.checklistItems !== undefined &&
      Object.keys(value).every((id) => itemIds.has(id))
    const count = canShowTotal ? `${checked} of ${itemIds.size} checked` : `${checked} done`
    return [`${metric.name}: ${count}`]
  })
}
