import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateWorkspace, db } from './database'
import { localRepository } from './localRepository'
import type { StoredTrackerDefinition, StoredTrackerEntry, SyncOperation } from './models'
import { validateTrackerEntryValues } from '../domain/trackers/schema'
import { evaluateTrackerEntry } from '../domain/trackers/planning'
import {
  createTrackerRecoveryCloudReader, createTrackerRecoveryPreview, discardRejectedTrackerChanges, parseTrackerRecoveryBackup, queueConfirmedMeasureRepair, TRACKER_RECOVERY_TARGETS,
  type RecoveryCloudEntry, type RecoveryCloudTracker, type TrackerRecoveryCloudReader,
} from './trackerRecoveryPreview'

const owner = 'recovery-owner'
const mernId = TRACKER_RECOVERY_TARGETS[0]!.trackerId
const cpId = TRACKER_RECOVERY_TARGETS[1]!.trackerId
const mernMetricId = TRACKER_RECOVERY_TARGETS[0]!.metricId
const cpMetricId = TRACKER_RECOVERY_TARGETS[1]!.metricId

function tracker(id: string, metricId: string, schemaVersion: 6 | 8 | 10, valueType: 'quantity' | 'duration'): StoredTrackerDefinition {
  const metric = { id: metricId, name: 'Progress', valueType, unit: 'hours', thresholds: { direction: 'increase' as const, minimum: 0, streakQualification: 'minimum' as const } }
  const rule = { kind: 'comparison' as const, metricId, operator: 'greater-than' as const, value: 0 }
  const base = {
    schemaVersion, id, name: id === mernId ? '100 Days Of MERN' : '100 Days Of CP', description: '', kind: 'challenge' as const,
    status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const },
    startDate: '2026-10-16', scheduling: schemaVersion >= 6 ? { mode: 'ongoing' as const } : undefined,
    metrics: [metric], qualificationRule: rule, streakRuleMode: schemaVersion >= 8 ? 'custom' as const : undefined, streakRule: schemaVersion >= 8 ? rule : undefined,
    strictMode: false, customFields: [], milestones: [], createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z', archivedAt: null, deletedAt: null,
  }
  if (schemaVersion !== 10) return base as StoredTrackerDefinition
  return {
    ...base,
    ruleVersions: [{
      id: 'mern-rule-version-2', effectiveFrom: '2026-10-16', revision: 2, application: 'recalculate-all-history', recordedAt: '2026-10-17T00:00:00.000Z',
      evaluation: { schedule: base.schedule, startDate: base.startDate, deadline: null, scheduling: base.scheduling ?? null, metrics: [metric], qualificationRule: rule, streakRuleMode: 'custom', streakRule: rule, strictMode: false },
    }],
  } as StoredTrackerDefinition
}

const localEntry: StoredTrackerEntry = {
  id: 'local-mern-entry', trackerId: mernId, date: '2026-10-16', outcome: 'skipped', values: {}, note: '',
  createdAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T16:04:23.431Z', deletedAt: '2026-10-16T16:04:23.431Z',
}

function operation(id: string, trackerId: string, schemaVersion: 8 | 10, expectedRevision: number): SyncOperation {
  const payload = tracker(trackerId, trackerId === mernId ? mernMetricId : cpMetricId, schemaVersion, 'duration')
  return {
    id, ownerUserId: owner, entity: 'tracker', entityId: trackerId, operation: 'upsert', expectedRevision, payload,
    createdAt: `2026-10-17T00:00:0${schemaVersion === 10 ? '3' : schemaVersion === 8 && trackerId === mernId ? '1' : '2'}.000Z`,
    attempts: 1, status: 'blocked', lastError: 'The server rejected this saved change (23514).', failureCode: '23514',
    failureDiagnostic: { code: '23514', message: 'new row violates trigger guard_tracker_metric_integrity on public.trackers' },
  }
}

const cloudTrackers: RecoveryCloudTracker[] = [
  { id: mernId, user_id: owner, schema_version: 6, server_revision: 1, definition: tracker(mernId, mernMetricId, 6, 'quantity'), kind: 'challenge', status: 'active', name: '100 Days Of MERN', updated_at: '2026-10-16T00:00:00.000Z', deleted_at: null },
  { id: cpId, user_id: owner, schema_version: 8, server_revision: 3, definition: tracker(cpId, cpMetricId, 8, 'quantity'), kind: 'challenge', status: 'active', name: '100 Days Of CP', updated_at: '2026-10-16T00:00:00.000Z', deleted_at: null },
]
const cloudEntries: RecoveryCloudEntry[] = [{
  id: localEntry.id, user_id: owner, tracker_id: mernId, entry_date: localEntry.date, outcome: 'skipped', entry_values: {}, note: '',
  created_at: localEntry.createdAt, updated_at: localEntry.updatedAt, deleted_at: localEntry.deletedAt, server_revision: 2,
}]
const cloudReader: TrackerRecoveryCloudReader = { readTrackers: async () => cloudTrackers, readEntries: async () => cloudEntries }

beforeEach(async () => {
  await activateWorkspace(owner)
  await db.trackers.bulkPut([tracker(mernId, mernMetricId, 10, 'duration'), tracker(cpId, cpMetricId, 8, 'duration')])
  await db.trackerEntries.put(localEntry)
  await db.syncRecords.bulkPut([
    { key: `tracker:${mernId}`, ownerUserId: owner, entity: 'tracker', entityId: mernId, serverRevision: 1 },
    { key: `tracker:${cpId}`, ownerUserId: owner, entity: 'tracker', entityId: cpId, serverRevision: 3 },
    { key: `tracker_entry:${localEntry.id}`, ownerUserId: owner, entity: 'tracker_entry', entityId: localEntry.id, serverRevision: 2 },
  ])
  await db.syncOperations.bulkPut([
    operation('f4d5f15b-b890-437b-9fe2-bb9d8d23b1c6', mernId, 8, 1),
    operation('28bf5f83-9c6b-4ab4-b61f-acfee4e74d2e', mernId, 10, 1),
    operation('3f00df8b-5d9b-42e6-9693-312e3995035e', cpId, 8, 3),
    { ...operation('unrelated', 'other-tracker', 8, 9), entityId: 'other-tracker', payload: tracker('other-tracker', 'other-measure', 8, 'quantity') },
    { id: 'entry-write', ownerUserId: owner, entity: 'tracker_entry', entityId: localEntry.id, operation: 'upsert', expectedRevision: 2, payload: localEntry, createdAt: '2026-10-17T00:00:04.000Z', attempts: 0, status: 'pending', lastError: null },
  ])
})

afterEach(async () => {
  db.close()
  await db.delete()
})

describe('blocked tracker recovery preview', () => {
  it('reads account records and fresh cloud state without mutating IndexedDB; proposes only MERN v10 and CP type corrections', async () => {
    const beforeTrackers = await db.trackers.toArray()
    const beforeOperations = await db.syncOperations.toArray()
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    expect(preview).toMatchObject({ status: 'ready-for-review', safeToExecute: false, cloudReadOnly: true, unrelatedPendingOperationsExcluded: true })
    expect(preview.trackers[0]).toMatchObject({ localSchemaVersion: 10, localAcknowledgedRevision: 1, cloudSchemaVersion: 6, cloudRevision: 1, cloudMetricType: 'quantity', localMetricType: 'duration' })
    expect(preview.trackers[0]!.diffs.map((diff) => diff.path)).toEqual([
      `metrics[${mernMetricId}].valueType`, `ruleVersions[2].evaluation.metrics[${mernMetricId}].valueType`,
    ])
    expect(preview.trackers[0]!.latestRuleVersion).toMatchObject({ revision: 2, application: 'recalculate-all-history', matchesCurrentAfterCorrection: true })
    expect(preview.trackers[1]!.diffs).toEqual([{ path: `metrics[${cpMetricId}].valueType`, before: 'duration', after: 'quantity' }])
    expect(preview.trackers[0]!.operations.map((item) => item.id)).toEqual(expect.arrayContaining([
      'f4d5f15b-b890-437b-9fe2-bb9d8d23b1c6', '28bf5f83-9c6b-4ab4-b61f-acfee4e74d2e',
    ]))
    expect(preview.trackers[0]!.operations.find((item) => item.id === 'f4d5f15b-b890-437b-9fe2-bb9d8d23b1c6')?.obsolete).toBe(true)
    expect(preview.trackers[0]!.localEntries).toEqual([expect.objectContaining({ id: localEntry.id, values: {}, note: '', deletedAt: localEntry.deletedAt, syncStatus: 'pending', acknowledgedRevision: 2 })])
    expect(preview.trackers[0]!.cloudEntries).toEqual([expect.objectContaining({ id: localEntry.id, values: {}, note: '', deletedAt: localEntry.deletedAt, serverRevision: 2 })])
    expect(preview.trackers[0]!.operations.find((item) => item.id === '28bf5f83-9c6b-4ab4-b61f-acfee4e74d2e')).toMatchObject({ payload: { schemaVersion: 10, metrics: [{ valueType: 'duration' }] }, failureCode: '23514', serverError: expect.stringContaining('guard_tracker_metric_integrity') })
    expect(preview.trackers[0]!.entryConflicts).toEqual([])
    expect(await db.trackers.toArray()).toEqual(beforeTrackers)
    expect(await db.syncOperations.toArray()).toEqual(beforeOperations)
  })

  it('flags stale cloud revisions and never marks the preview executable', async () => {
    const staleReader: TrackerRecoveryCloudReader = { ...cloudReader, readTrackers: async () => cloudTrackers.map((row) => row.id === mernId ? { ...row, server_revision: 2 } : row) }
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader: staleReader })
    expect(preview.status).toBe('conflict')
    expect(preview.blockers.some((blocker) => blocker.includes('cloud revision is 2, expected 1'))).toBe(true)
    expect(preview.safeToExecute).toBe(false)
  })

  it('keeps the local backup available but blocks review when fresh cloud reads fail', async () => {
    const unavailable: TrackerRecoveryCloudReader = {
      readTrackers: async () => { throw new Error('offline') },
      readEntries: async () => { throw new Error('offline') },
    }
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader: unavailable })
    expect(preview.status).toBe('incomplete')
    expect(preview.safeToExecute).toBe(false)
    expect(preview.backup.manifest.trackerCount).toBe(2)
    expect(preview.blockers).toEqual(expect.arrayContaining([expect.stringContaining('Fresh cloud tracker read failed'), expect.stringContaining('Fresh cloud check-in read failed')]))
  })

  it('shows an unexpected operation status as a conflict and preserves it in the backup', async () => {
    const blocked = await db.syncOperations.get('28bf5f83-9c6b-4ab4-b61f-acfee4e74d2e')
    if (!blocked) throw new Error('Expected the MERN v10 operation.')
    await db.syncOperations.put({ ...blocked, status: 'superseded', supersededAt: '2026-10-17T01:00:00.000Z', supersededByRevision: 2 })
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    expect(preview.status).toBe('conflict')
    expect(preview.blockers.some((blocker) => blocker.includes('is superseded, not blocked'))).toBe(true)
    expect(preview.backup.stores.syncOperations.find((operation) => operation.id === blocked.id)).toMatchObject({ status: 'superseded', supersededByRevision: 2 })
  })

  it('blocks recovery and preserves a pending permanent-deletion request for an affected tracker', async () => {
    const request = { id: 'pending-mern-delete', ownerUserId: owner, trackerId: mernId, requestedAt: '2026-10-17T01:00:00.000Z', status: 'pending' as const, lastError: null, winsRetention: 'keep_wins' as const }
    await db.permanentDeletionRequests.put(request)
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    expect(preview.status).toBe('conflict')
    expect(preview.trackers[0]!.permanentDeletionRequests).toEqual([expect.objectContaining({ id: request.id, status: 'pending', requestedAt: request.requestedAt, winsRetention: 'keep_wins' })])
    expect(preview.backup.stores.permanentDeletionRequests).toEqual([request])
    expect(preview.blockers.some((blocker) => blocker.includes('permanent-deletion request is pending'))).toBe(true)
  })

  it('blocks a local/cloud same-date entry conflict and lists soft-deleted entries without changing them', async () => {
    const conflictingCloud: TrackerRecoveryCloudReader = { ...cloudReader, readEntries: async () => [...cloudEntries, { ...cloudEntries[0]!, id: 'cloud-duplicate-entry' }] }
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader: conflictingCloud })
    expect(preview.status).toBe('conflict')
    expect(preview.trackers[0]!.entryConflicts.some((conflict) => conflict.includes('occupy the same tracker date'))).toBe(true)
    expect(preview.trackers[0]!.localEntries[0]).toMatchObject({ deletedAt: localEntry.deletedAt })
  })

  it('serializes a complete scoped backup and preserves exact check-ins, blocked payloads, diagnostics, and revision metadata on parse', async () => {
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    const jsonRoundTrip = JSON.parse(JSON.stringify(preview.backup))
    const restoredArtifact = parseTrackerRecoveryBackup(jsonRoundTrip, owner)
    expect(restoredArtifact.manifest).toMatchObject({ trackerCount: 2, entryCount: 1, operationCount: 4, syncRecordCount: 3 })
    expect(restoredArtifact.stores.trackerEntries).toEqual([localEntry])
    expect(restoredArtifact.stores.syncOperations.find((item) => item.id === '28bf5f83-9c6b-4ab4-b61f-acfee4e74d2e')).toMatchObject({ failureDiagnostic: { code: '23514', message: expect.stringContaining('guard_tracker_metric_integrity') }, payload: expect.objectContaining({ schemaVersion: 10 }) })
    expect(restoredArtifact.stores.syncRecords).toEqual(await db.syncRecords.toArray())
    expect(restoredArtifact.stores.syncOperations.some((item) => item.id === 'unrelated')).toBe(false)
  })

  it('aborts backup creation when any original operation is missing', async () => {
    await db.syncOperations.delete('f4d5f15b-b890-437b-9fe2-bb9d8d23b1c6')
    await expect(createTrackerRecoveryPreview(owner, { cloudReader })).rejects.toThrow(/original operation records are missing/)
  })

  it('rejects a backup with a mismatched manifest or account owner', async () => {
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    const wrongManifest = { ...preview.backup, manifest: { ...preview.backup.manifest, entryCount: 2 } }
    expect(() => parseTrackerRecoveryBackup(wrongManifest, owner)).toThrow(/manifest/)
    expect(() => parseTrackerRecoveryBackup(preview.backup, 'other-owner')).toThrow(/different account/)
  })

  it('keeps numeric Hours values and rule evaluation identical for quantity and duration', () => {
    const duration = tracker(mernId, mernMetricId, 8, 'duration')
    const quantity = { ...duration, metrics: duration.metrics.map((metric) => ({ ...metric, valueType: 'quantity' as const })) }
    const checkin = { id: 'hours-checkin', trackerId: mernId, date: '2026-10-16', outcome: 'recorded' as const, values: { [mernMetricId]: 1.5 }, note: '', createdAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T12:00:00.000Z', deletedAt: null }
    expect(validateTrackerEntryValues(duration, checkin.values)).toBeUndefined()
    expect(validateTrackerEntryValues(quantity, checkin.values)).toBeUndefined()
    expect(evaluateTrackerEntry(duration, checkin)).toEqual(evaluateTrackerEntry(quantity, checkin))
    expect(checkin.values[mernMetricId]).toBe(1.5)
  })

  it('queues corrected MERN v10 and CP v8 configurations without replaying MERN v8 or changing IDs and values', async () => {
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    await queueConfirmedMeasureRepair(preview, mernId, true, { database: db, cloudReader })
    const afterMern = await createTrackerRecoveryPreview(owner, { cloudReader })
    await queueConfirmedMeasureRepair(afterMern, cpId, true, { database: db, cloudReader })
    const mern = await db.trackers.get(mernId)
    const cp = await db.trackers.get(cpId)
    expect(mern?.metrics[0]).toMatchObject({ id: mernMetricId, valueType: 'quantity', unit: 'hours' })
    expect(mern?.ruleVersions?.at(-1)?.evaluation.metrics[0]).toMatchObject({ id: mernMetricId, valueType: 'quantity' })
    expect(cp?.metrics[0]).toMatchObject({ id: cpMetricId, valueType: 'quantity' })
    expect(await db.trackerEntries.get(localEntry.id)).toEqual(localEntry)
    const ops = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([owner, 'tracker', mernId]).toArray()
    expect(ops.find((row) => row.id === 'f4d5f15b-b890-437b-9fe2-bb9d8d23b1c6')?.status).toBe('blocked')
    expect(ops.find((row) => row.id === '28bf5f83-9c6b-4ab4-b61f-acfee4e74d2e')?.status).toBe('blocked')
    expect(ops.find((row) => row.status === 'pending')).toMatchObject({ status: 'pending', expectedRevision: 1, payload: { schemaVersion: 10, metrics: [{ id: mernMetricId, valueType: 'quantity' }] } })
    expect((await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([owner, 'tracker', cpId]).toArray()).find((row) => row.status === 'pending')).toMatchObject({ status: 'pending', expectedRevision: 3, payload: { schemaVersion: 8, metrics: [{ id: cpMetricId, valueType: 'quantity' }] } })
  })

  it('requires backup confirmation and rejects a changed cloud revision before queueing a repair', async () => {
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    await expect(queueConfirmedMeasureRepair(preview, mernId, false, { database: db, cloudReader })).rejects.toThrow(/backup/)
    const stale: TrackerRecoveryCloudReader = { ...cloudReader, readTrackers: async () => cloudTrackers.map((row) => row.id === mernId ? { ...row, server_revision: 2 } : row) }
    await expect(queueConfirmedMeasureRepair(preview, mernId, true, { database: db, cloudReader: stale })).rejects.toThrow(/revision changed/)
    expect(await db.trackers.get(mernId)).toMatchObject({ metrics: [{ valueType: 'duration' }] })
  })

  it('discards CP blocked operations consistently, restores the same-schema cloud definition, and retains its audit payload', async () => {
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    await discardRejectedTrackerChanges(preview, cpId, true, { database: db, cloudReader })
    expect(await db.trackers.get(cpId)).toMatchObject({ id: cpId, schemaVersion: 8, metrics: [{ id: cpMetricId, valueType: 'quantity' }] })
    expect(await db.syncOperations.get('3f00df8b-5d9b-42e6-9693-312e3995035e')).toMatchObject({ status: 'discarded', payload: { metrics: [{ id: cpMetricId, valueType: 'duration' }] }, discardedAt: expect.any(String) })
    expect(await db.syncRecords.get(`tracker:${cpId}`)).toMatchObject({ serverRevision: 3 })
    expect(await db.trackerEntries.get(localEntry.id)).toEqual(localEntry)
    expect(await db.syncOperations.get('f4d5f15b-b890-437b-9fe2-bb9d8d23b1c6')).toMatchObject({ status: 'blocked' })
    const restored = await db.trackers.get(cpId)
    if (!restored) throw new Error('Expected the restored CP tracker.')
    await localRepository.saveTracker({ ...restored, description: 'Edited after safe discard' })
    const afterEdit = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([owner, 'tracker', cpId]).toArray()
    expect(afterEdit.find((operation) => operation.id === '3f00df8b-5d9b-42e6-9693-312e3995035e')).toMatchObject({ status: 'discarded' })
    expect(afterEdit.find((operation) => operation.status === 'pending')).toMatchObject({ expectedRevision: 3, payload: { description: 'Edited after safe discard', metrics: [{ id: cpMetricId, valueType: 'quantity' }] } })
    const afterDiscard = await createTrackerRecoveryPreview(owner, { cloudReader })
    await expect(discardRejectedTrackerChanges(afterDiscard, cpId, true, { database: db, cloudReader })).rejects.toThrow(/no rejected tracker changes/)
  })

  it('blocks MERN discard across the v10-to-v6 schema downgrade and blocks discard with unsynced entries', async () => {
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    await expect(discardRejectedTrackerChanges(preview, mernId, true, { database: db, cloudReader })).rejects.toThrow(/schemas differ/)
    const staleCloud: TrackerRecoveryCloudReader = { ...cloudReader, readTrackers: async () => cloudTrackers.map((row) => row.id === cpId ? { ...row, server_revision: 4 } : row) }
    await expect(discardRejectedTrackerChanges(preview, cpId, true, { database: db, cloudReader: staleCloud })).rejects.toThrow(/Cloud or acknowledged revision changed/)
    expect(await db.syncOperations.get('3f00df8b-5d9b-42e6-9693-312e3995035e')).toMatchObject({ status: 'blocked' })
    const cpEntry: StoredTrackerEntry = { ...localEntry, id: 'unsynced-cp-entry', trackerId: cpId, values: { [cpMetricId]: 1.5 }, deletedAt: null }
    await db.trackerEntries.put(cpEntry)
    await db.syncOperations.put({ id: 'unsynced-cp-write', ownerUserId: owner, entity: 'tracker_entry', entityId: cpEntry.id, operation: 'upsert', expectedRevision: null, payload: cpEntry, createdAt: '2026-10-17T01:00:00.000Z', attempts: 0, status: 'pending', lastError: null })
    const withPendingEntry = await createTrackerRecoveryPreview(owner, { cloudReader })
    await expect(discardRejectedTrackerChanges(withPendingEntry, cpId, true, { database: db, cloudReader })).rejects.toThrow(/Unresolved tracker or check-in conflicts|Unsynced check-in|not confirmed identical/)
    expect(await db.syncOperations.get('3f00df8b-5d9b-42e6-9693-312e3995035e')).toMatchObject({ status: 'blocked' })
  })

  it('reports duration milestone snapshots without silently rewriting them', async () => {
    const current = await db.trackers.get(mernId)
    const operation = await db.syncOperations.get('28bf5f83-9c6b-4ab4-b61f-acfee4e74d2e')
    if (!current || !operation) throw new Error('Expected MERN local records.')
    const withMilestone = { ...current, milestones: [{ id: 'hours-milestone', title: 'Study hours', description: '', type: 'cumulative-quantity' as const, metricId: mernMetricId, targetValue: 100, measureTypeSnapshot: 'duration' as const, unitSnapshot: 'hours', position: 0 }] }
    await db.trackers.put(withMilestone)
    await db.syncOperations.put({ ...operation, payload: withMilestone })
    const preview = await createTrackerRecoveryPreview(owner, { cloudReader })
    expect(preview.status).toBe('conflict')
    expect(preview.trackers[0]!.milestoneSnapshots).toEqual([{ id: 'hours-milestone', title: 'Study hours', measureTypeSnapshot: 'duration' }])
    expect(preview.trackers[0]!.proposedDefinition?.milestones[0]?.measureTypeSnapshot).toBe('duration')
    expect(preview.blockers.some((blocker) => blocker.includes('milestone “Study hours” snapshots duration'))).toBe(true)
  })

  it('uses authenticated, paged SELECT queries for cloud rows and does not call any write RPC', async () => {
    const selectCalls: Array<{ table: string; selection: string; range?: [number, number] }> = []
    const client = {
      auth: { getUser: async () => ({ data: { user: { id: owner } }, error: null }) },
      from: (table: string) => {
        let selection = ''
        let range: [number, number] | undefined
        const builder: any = {
          select(value: string) { selection = value; return builder },
          eq() { return builder }, in() { return builder }, order() { return builder },
          range(start: number, end: number) { range = [start, end]; return builder },
          then(resolve: (value: unknown) => unknown) {
            selectCalls.push({ table, selection, range })
            return Promise.resolve(resolve({ data: table === 'trackers' ? cloudTrackers : cloudEntries, error: null }))
          },
        }
        return builder
      },
    } as never
    const reader = createTrackerRecoveryCloudReader(client)
    await expect(reader.readTrackers(owner, [mernId, cpId])).resolves.toEqual(cloudTrackers)
    await expect(reader.readEntries(owner, [mernId, cpId])).resolves.toEqual(cloudEntries)
    expect(selectCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'trackers', selection: expect.stringContaining('server_revision') }),
      expect.objectContaining({ table: 'tracker_entries', selection: expect.stringContaining('server_revision'), range: [0, 499] }),
    ]))
  })
})
