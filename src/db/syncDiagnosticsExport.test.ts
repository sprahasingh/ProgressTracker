import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncDiagnosticsExport } from './syncDiagnosticsExport'

const state = vi.hoisted(() => ({ operations: [] as unknown[], records: [] as unknown[], mode: '' }))
vi.mock('./database', () => ({
  openDatabase: async () => {
    const table = (rows: unknown[]) => ({ where: (field: string) => ({ equals: (value: string) => ({ toArray: async () => rows.filter((row) => Boolean(row && (row as Record<string, unknown>)[field] === value)) }) }) })
    return {
      workspaceMetadata: { get: async () => ({ key: 'workspace', userId: 'account-secret' }) },
      syncOperations: table(state.operations), syncRecords: table(state.records),
      transaction: async (mode: string, _tables: unknown[], fn: () => unknown) => { state.mode = mode; return fn() },
    }
  },
}))

const trackerPayload = (schemaVersion: number, strictMode?: boolean) => ({
  schemaVersion, id: 'tracker-uuid', name: 'Private tracker name', notes: 'private journal', kind: 'habit', status: 'active',
  schedule: { kind: 'weekdays' }, scheduling: { mode: 'calendar', effectiveDayCounting: 'planned-activity-days' },
  metrics: [{ id: 'metric-1', valueType: 'quantity', precision: { decimalPlaces: 1, increment: 0.5 }, thresholds: { direction: 'increase', minimum: 1, target: 3, stretch: 5 }, secretValue: 'do not export' }],
  streakRuleMode: 'custom', streakRule: { kind: 'comparison', metricId: 'metric-1', operator: 'at-least', value: 2 },
  qualificationRule: { kind: 'threshold', metricId: 'metric-1', level: 'target' },
  ...(strictMode === undefined ? {} : { strictMode }),
  ...(schemaVersion === 10 ? { ruleVersions: [{ revision: 1, application: 'baseline', effectiveFrom: '2026-01-01', evaluation: { schedule: { kind: 'weekdays' }, scheduling: { mode: 'calendar', effectiveDayCounting: 'planned-activity-days' }, metrics: [{ id: 'metric-1', valueType: 'quantity', thresholds: { minimum: 1, target: 3, stretch: 5, direction: 'increase' } }], qualificationRule: { kind: 'threshold', metricId: 'metric-1', level: 'target' }, streakRuleMode: 'custom', streakRule: { kind: 'comparison', metricId: 'metric-1', operator: 'at-least', value: 2 }, strictMode: false } }] } : {}),
})

function operation(id: string, status: string, schemaVersion: number, strictMode?: boolean) {
  return { id, ownerUserId: 'account-secret', entity: 'tracker', entityId: 'tracker-uuid', operation: 'upsert', status, expectedRevision: 1, createdAt: `2026-01-0${id.length}T00:00:00Z`, attempts: 2, lastError: 'Rejected user@example.com https://private.invalid Bearer abcdefghijklmnop', failureCode: '23514', failureDiagnostic: { code: '23514', message: 'Rejected user@example.com https://private.invalid Bearer abcdefghijklmnop', table: 'trackers', constraint: 'trackers_schema_version_check' }, payload: trackerPayload(schemaVersion, strictMode) }
}

describe('safe sync diagnostics export', () => {
  beforeEach(() => { state.operations = []; state.records = []; state.mode = '' })

  it('includes all matching historical rows, redacts messages, fingerprints tracker structure, and reads only', async () => {
    state.operations = [operation('blocked-a', 'blocked', 8), operation('blocked-b', 'superseded', 10, false), operation('pending-c', 'pending', 10, true), { ...operation('conflict-d', 'conflict', 6), ownerUserId: 'another-account' }]
    state.records = [{ ownerUserId: 'account-secret', entity: 'tracker', entityId: 'tracker-uuid', serverRevision: 3 }]
    const before = structuredClone(state.operations)
    const exported = JSON.parse(await createSyncDiagnosticsExport('account-secret'))
    expect(state.mode).toBe('r')
    expect(state.operations).toEqual(before)
    expect(exported.operations).toHaveLength(3)
    expect(exported.summary).toMatchObject({ blockedOperations: 1, supersededOperations: 1, pendingOperations: 1 })
    expect(exported.operations[0]).toMatchObject({ operationId: 'blocked-a', expectedCloudRevision: 1, lastAcknowledgedCloudRevision: 3, payloadSchemaVersion: 8, sqlState: '23514', databaseConstraint: 'trackers_schema_version_check' })
    expect(exported.operations[0].serverErrorMessage).not.toMatch(/user@example|https:\/\/|abcdefghijklmnop/)
    expect(exported.operations[0].trackerConfiguration).toMatchObject({ schemaVersion: 8, strictMode: { present: false, value: null }, latestRuleVersionMatchesCurrentEvaluation: null })
    expect(exported.operations[1].trackerConfiguration).toMatchObject({ schemaVersion: 10, strictMode: { present: true, value: false }, ruleVersions: [{ revision: 1, evaluationFieldConsistency: { available: true, presentEvaluationFields: expect.arrayContaining(['schedule', 'scheduling', 'metrics', 'strictMode']), metricsIsArray: true, strictModeValue: false, signatureComputable: true } }], latestRuleVersionMatchesCurrentEvaluation: true })
    const json = JSON.stringify(exported)
    for (const secret of ['Private tracker name', 'private journal', 'secretValue', 'do not export', 'account-secret', 'another-account']) expect(json).not.toContain(secret)
  })

  it('emits a valid empty report when there are no relevant operations', async () => {
    const report = JSON.parse(await createSyncDiagnosticsExport('account-secret'))
    expect(report.format).toBe('progress-tracker-sync-diagnostics-v1')
    expect(report.summary.totalRelevantOperations).toBe(0)
    expect(report.operations).toEqual([])
  })

  it('keeps v6, v8, v9, and v10 payload versions distinct', async () => {
    state.operations = [6, 8, 9, 10].map((version, index) => operation(`op-${index}`, 'blocked', version, false))
    const report = JSON.parse(await createSyncDiagnosticsExport('account-secret'))
    expect(report.operations.map((row: { payloadSchemaVersion: number }) => row.payloadSchemaVersion)).toEqual([6, 8, 9, 10])
  })

  it('omits malformed historical rows and reports a warning count', async () => {
    state.operations = [null, { ownerUserId: 'account-secret', id: 'incomplete', status: 'blocked' }, operation('valid-block', 'blocked', 6)]
    const report = JSON.parse(await createSyncDiagnosticsExport('account-secret'))
    expect(report.operations).toHaveLength(1)
    expect(report.warnings.malformedOperations).toBe(1)
  })
})
