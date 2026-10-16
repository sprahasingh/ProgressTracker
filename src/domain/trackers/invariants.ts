import type { CustomFieldDefinition, TrackerDefinition } from './types'

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

/** Keep a custom field's label and value interpretation stable while preserving its stable ID. */
export function historicalCustomFieldMeaningChange(previous: TrackerDefinition, next: TrackerDefinition, historicalFieldIds: ReadonlySet<string>): string | undefined {
  const nextById = new Map(next.customFields.map((field) => [field.id, field]))
  for (const field of previous.customFields) {
    if (!historicalFieldIds.has(field.id)) continue
    const candidate = nextById.get(field.id)
    if (!candidate) return field.name
    if (customFieldMeaning(field) !== customFieldMeaning(candidate)) return field.name
  }
  return undefined
}

/** Retired custom fields must remain available to display and safely resave old values. */
export function retiredCustomFieldMeaningChange(previous: TrackerDefinition, next: TrackerDefinition): string | undefined {
  const nextById = new Map(next.customFields.map((field) => [field.id, field]))
  for (const field of previous.customFields) {
    if (!field.retiredAt) continue
    const candidate = nextById.get(field.id)
    if (!candidate || customFieldMeaning(field) !== customFieldMeaning(candidate) || candidate.retiredAt !== field.retiredAt) return field.name
  }
  return undefined
}

function customFieldMeaning(field: CustomFieldDefinition): string {
  const { position: _position, retiredAt: _retiredAt, ...meaning } = field
  return JSON.stringify(meaning)
}
