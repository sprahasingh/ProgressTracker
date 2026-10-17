import { openDatabase } from './database'
import { trackerEvaluationSignature } from '../domain/trackers/ruleVersions'
import type { SyncOperation } from './models'

const relevantStatuses = new Set(['blocked', 'conflict', 'superseded', 'pending', 'in-flight'])
type JsonRecord = Record<string, unknown>
const object = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
const text = (value: unknown): string | null => typeof value === 'string' ? value : null

function safeRule(value: unknown): unknown {
  const rule = object(value)
  if (!rule || typeof rule.kind !== 'string') return null
  if (rule.kind === 'threshold') return { kind: rule.kind, metricId: text(rule.metricId), level: text(rule.level) }
  if (rule.kind === 'comparison') return { kind: rule.kind, metricId: text(rule.metricId), operator: text(rule.operator), valueType: typeof rule.value, value: typeof rule.value === 'boolean' || typeof rule.value === 'number' ? rule.value : null }
  if (['all', 'any', 'at-least'].includes(rule.kind)) return { kind: rule.kind, ...(typeof rule.required === 'number' ? { required: rule.required } : {}), operands: Array.isArray(rule.operands) ? rule.operands.map(safeRule) : null }
  return { kind: 'unavailable' }
}

function evaluationFrom(source: JsonRecord): JsonRecord {
  const metrics = Array.isArray(source.metrics) ? source.metrics.map((item) => {
    const metric = object(item)
    if (!metric) return null
    const precision = object(metric.precision)
    const thresholds = object(metric.thresholds)
    return {
      id: text(metric.id), type: text(metric.valueType),
      precision: precision ? { decimalPlaces: precision.decimalPlaces ?? null, increment: precision.increment ?? null } : null,
      thresholds: thresholds ? { direction: text(thresholds.direction), minimum: typeof thresholds.minimum === 'number' ? thresholds.minimum : null, target: typeof thresholds.target === 'number' ? thresholds.target : null, stretch: typeof thresholds.stretch === 'number' ? thresholds.stretch : null, streakQualification: text(thresholds.streakQualification) } : null,
      retired: metric.retiredAt !== undefined,
    }
  }) : null
  return {
    schedule: object(source.schedule) ? { kind: text(object(source.schedule)!.kind) } : null,
    startDate: text(source.startDate), deadline: text(source.deadline),
    scheduling: object(source.scheduling) ? source.scheduling : null,
    metrics,
    qualificationRule: safeRule(source.qualificationRule),
    streakRuleMode: text(source.streakRuleMode), streakRule: safeRule(source.streakRule),
    strictMode: Object.hasOwn(source, 'strictMode') ? (typeof source.strictMode === 'boolean' ? source.strictMode : null) : null,
    strictModePresent: Object.hasOwn(source, 'strictMode'),
  }
}

function trackerSummary(payload: unknown): JsonRecord | null {
  const tracker = object(payload)
  if (!tracker || tracker.schemaVersion === undefined) return null
  const current = { ...tracker, streakRule: tracker.streakRule }
  const versions = Array.isArray(tracker.ruleVersions) ? tracker.ruleVersions.map((item) => {
    const version = object(item)
    const evaluation = object(version?.evaluation)
    const signature = evaluation ? safeSignature(evaluation) : null
    return { revision: typeof version?.revision === 'number' ? version.revision : null, application: text(version?.application), effectiveFrom: text(version?.effectiveFrom), evaluationFieldConsistency: evaluation ? { available: true, presentEvaluationFields: ['schedule', 'startDate', 'deadline', 'scheduling', 'metrics', 'qualificationRule', 'streakRuleMode', 'streakRule', 'strictMode'].filter((key) => Object.hasOwn(evaluation, key)), metricsIsArray: Array.isArray(evaluation.metrics), strictModeValue: Object.hasOwn(evaluation, 'strictMode') ? (typeof evaluation.strictMode === 'boolean' ? evaluation.strictMode : null) : null, signatureComputable: signature !== null } : { available: false, presentEvaluationFields: [], metricsIsArray: false, strictModeValue: null, signatureComputable: false } }
  }) : null
  const latest = Array.isArray(tracker.ruleVersions) ? object(tracker.ruleVersions.at(-1)) : null
  const latestEvaluation = object(latest?.evaluation)
  return {
    schemaVersion: typeof tracker.schemaVersion === 'number' ? tracker.schemaVersion : null,
    kind: text(tracker.kind), status: text(tracker.status),
    schedule: { present: Object.hasOwn(tracker, 'schedule'), value: object(tracker.schedule) ? { kind: text(object(tracker.schedule)!.kind) } : null },
    scheduling: { present: Object.hasOwn(tracker, 'scheduling'), value: object(tracker.scheduling) ? { mode: text(object(tracker.scheduling)!.mode), effectiveDayCounting: text(object(tracker.scheduling)!.effectiveDayCounting) } : null },
    strictMode: { present: Object.hasOwn(tracker, 'strictMode'), value: typeof tracker.strictMode === 'boolean' ? tracker.strictMode : null },
    streakRuleMode: { present: Object.hasOwn(tracker, 'streakRuleMode'), value: text(tracker.streakRuleMode) },
    streakRule: { present: Object.hasOwn(tracker, 'streakRule'), value: safeRule(tracker.streakRule) },
    qualificationRule: { present: Object.hasOwn(tracker, 'qualificationRule'), value: safeRule(tracker.qualificationRule) },
    metrics: { present: Object.hasOwn(tracker, 'metrics'), value: evaluationFrom(current).metrics },
    ruleVersions: versions,
    latestRuleVersionMatchesCurrentEvaluation: latestEvaluation ? safeSignature(latestEvaluation) === safeSignature(current) : null,
  }
}

function safeSignature(evaluation: JsonRecord): string | null {
  try {
    return trackerEvaluationSignature(evaluation as never)
  } catch { return null }
}

function redact(message: unknown): string | null {
  if (typeof message !== 'string') return null
  return message.slice(0, 500)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
    .replace(/https?:\/\/\S+/gi, '[redacted URL]')
    .replace(/\b(Bearer|token|access_token|refresh_token|apikey|api_key|authorization)\s*[:=]?\s*[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/\b(?:sb_secret_|sb_publishable_|sk_live_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+\b/gi, '[redacted credential]')
    .replace(/(?<!\w)\+?\d[\d\s().-]{7,}\d(?!\w)/g, '[redacted phone]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted identifier]')
}

function isWellFormedOperation(value: unknown): value is SyncOperation {
  const row = object(value)
  return Boolean(row && typeof row.id === 'string' && typeof row.ownerUserId === 'string' && typeof row.entityId === 'string' && typeof row.entity === 'string' && typeof row.operation === 'string' && typeof row.status === 'string' && typeof row.createdAt === 'string')
}

function operationSummary(operation: SyncOperation, serverRevision: number | null) {
  const diagnostic = object(operation.failureDiagnostic)
  return {
    operationId: operation.id, entityId: operation.entityId, entity: operation.entity, operation: operation.operation,
    status: operation.status, createdAt: operation.createdAt, updatedAt: text((operation as JsonRecord).updatedAt),
    blockedAt: operation.blockedAt ?? null, supersededAt: operation.supersededAt ?? null,
    supersededByRevision: operation.supersededByRevision ?? null, expectedCloudRevision: operation.expectedRevision ?? null,
    lastAcknowledgedCloudRevision: serverRevision, payloadSchemaVersion: operation.entity === 'tracker' ? (object(operation.payload)?.schemaVersion ?? null) : null,
    failureCode: operation.failureCode ?? null, sqlState: operation.failureDiagnostic?.code ?? operation.failureCode ?? null,
    databaseTable: text(diagnostic?.table), databaseConstraint: text(diagnostic?.constraint),
    serverErrorMessage: redact(operation.failureDiagnostic?.message ?? operation.lastError),
    attemptCount: Number.isFinite(operation.attempts) ? operation.attempts : null,
    lastAttemptAt: text((operation as JsonRecord).lastAttemptAt),
    lineage: { orderingTimestamp: operation.createdAt, supersededByRevision: operation.supersededByRevision ?? null },
    ...(operation.entity === 'tracker' ? { trackerConfiguration: trackerSummary(operation.payload) } : {}),
  }
}

/** Reads only the active account's sync outbox and revision metadata. */
export async function createSyncDiagnosticsExport(userId: string): Promise<string> {
  const database = await openDatabase()
  const result = await database.transaction('r', [database.workspaceMetadata, database.syncOperations, database.syncRecords], async () => {
    const workspace = await database.workspaceMetadata.get('workspace')
    if (workspace?.userId !== userId) throw new Error('The open local workspace does not belong to this account.')
    const [allOperations, records] = await Promise.all([
      database.syncOperations.where('ownerUserId').equals(userId).toArray(),
      database.syncRecords.where('ownerUserId').equals(userId).toArray(),
    ])
    return { allOperations, records }
  })
  const validOperations = result.allOperations.filter(isWellFormedOperation)
  const operations = validOperations.filter((operation) => relevantStatuses.has(operation.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((operation) => operationSummary(operation, result.records.find((record) => record.entity === operation.entity && record.entityId === operation.entityId)?.serverRevision ?? null))
  const count = (status: string) => operations.filter((operation) => operation.status === status).length
  return JSON.stringify({
    format: 'progress-tracker-sync-diagnostics-v1', generatedAt: new Date().toISOString(),
    privacy: { identifiersIncluded: 'Operation and entity UUIDs are included for support reconciliation. Review before sharing.', payloads: 'Full tracker payloads and personal content are excluded.' },
    summary: { totalRelevantOperations: operations.length, blockedOperations: count('blocked'), conflictOperations: count('conflict'), supersededOperations: count('superseded'), pendingOperations: count('pending'), inFlightOperations: count('in-flight') },
    warnings: {
      malformedOperations: result.allOperations.length - validOperations.length,
      malformedTrackerConfigurations: operations.filter((operation) => operation.entity === 'tracker' && operation.trackerConfiguration === null).length,
      note: 'Optional unavailable fields are null. Malformed operation rows and tracker configurations are counted; malformed operation rows are omitted.',
    },
    operations,
  }, null, 2)
}
