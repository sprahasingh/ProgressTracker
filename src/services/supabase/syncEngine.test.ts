import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { activateWorkspace, db, queueSyncMutation } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { synchronizeWorkspace } from './syncEngine'

const tracker = (id = 'sync-tracker'): StoredTrackerDefinition => ({
  schemaVersion: 1, id, name: 'Sync tracker', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [], customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', archivedAt: null, deletedAt: null,
})
const plannedGoal: StoredTrackerDefinition = {
  ...tracker('planned-goal'), schemaVersion: 2, kind: 'goal', deadline: '2026-12-31',
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', minimum: 2, target: 5, stretch: 8, streakQualification: 'minimum' } }],
  goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: { pages: 3 }, cumulativeTargets: { pages: 100 } },
}

const serverTracker = (record: StoredTrackerDefinition, owner = 'sync-user', revision = 1) => ({
  id: record.id, user_id: owner, schema_version: record.schemaVersion, kind: record.kind, status: record.status,
  name: record.name, definition: record, created_at: record.createdAt, updated_at: record.updatedAt,
  deleted_at: record.deletedAt, server_revision: revision,
})

function fakeClient(options: { userId?: string; rpcResult?: unknown; rpcError?: { message: string } | null; trackerRows?: unknown[]; trackerEntryRows?: unknown[]; holidayRows?: unknown[]; ledgerRows?: unknown[] } = {}) {
  const rpc = vi.fn().mockResolvedValue({ data: options.rpcResult ?? null, error: options.rpcError ?? null })
  const getUser = vi.fn().mockResolvedValue({ data: { user: options.userId === undefined ? { id: 'sync-user' } : options.userId ? { id: options.userId } : null }, error: null })
  const from = vi.fn((table: string) => {
    const rows = table === 'trackers' ? options.trackerRows ?? [] : table === 'tracker_entries' ? options.trackerEntryRows ?? [] : table === 'account_holidays' ? options.holidayRows ?? [] : table === 'tracker_deletion_ledger' ? options.ledgerRows ?? [] : []
    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      gt: () => builder,
      then: (resolve: (result: unknown) => unknown) => Promise.resolve(resolve({ data: rows, error: null })),
    }
    return builder
  })
  return { client: { auth: { getUser }, rpc, from } as unknown as SupabaseClient, rpc, getUser, from }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  db.close()
  await db.delete()
})

describe('account-scoped sync engine', () => {
  it('uploads and downloads account-wide holiday rows through the revisioned owner-scoped RPC', async () => {
    await activateWorkspace('sync-user')
    const [row] = await localRepository.saveAccountHolidays(['2026-10-12'], 'travel')
    if (!row) throw new Error('Holiday did not persist locally.')
    const { client, rpc } = fakeClient({ rpcResult: { status: 'applied', record: { id: row.id, user_id: 'sync-user', holiday_date: row.date, reason: row.reason, created_at: row.createdAt, updated_at: row.updatedAt, deleted_at: null, server_revision: 1 } } })
    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    expect(rpc).toHaveBeenCalledWith('apply_account_holiday_sync_operation', expect.objectContaining({ p_expected_user_id: 'sync-user', p_expected_revision: null, p_record: expect.objectContaining({ holiday_date: row.date, reason: 'travel' }) }))
    await expect(db.syncRecords.get(`account_holiday:${row.id}`)).resolves.toMatchObject({ ownerUserId: 'sync-user', serverRevision: 1 })

    await db.accountHolidays.clear()
    await db.syncRecords.clear()
    const { client: downloadClient } = fakeClient({ holidayRows: [{ id: row.id, user_id: 'sync-user', holiday_date: row.date, reason: row.reason, created_at: row.createdAt, updated_at: row.updatedAt, deleted_at: null, server_revision: 1 }] })
    await expect(synchronizeWorkspace('sync-user', downloadClient)).resolves.toMatchObject({ downloaded: 1, failed: 0 })
    await expect(db.accountHolidays.get(row.id)).resolves.toMatchObject({ date: row.date, reason: 'travel', deletedAt: null })

    await activateWorkspace('different-user')
    await expect(localRepository.listAccountHolidays()).resolves.toEqual([])
  })

  it('syncs holiday removal and restoration as revisioned tombstones without changing tracker entries', async () => {
    await activateWorkspace('sync-user')
    const [row] = await localRepository.saveAccountHolidays(['2026-10-13'], 'personal')
    if (!row) throw new Error('Holiday did not persist locally.')
    await db.syncRecords.put({ key: `account_holiday:${row.id}`, ownerUserId: 'sync-user', entity: 'account_holiday', entityId: row.id, serverRevision: 2 })
    await localRepository.removeAccountHoliday(row.date)
    const queued = await db.syncOperations.where('ownerUserId').equals('sync-user').first()
    expect(queued).toMatchObject({ entity: 'account_holiday', expectedRevision: 2, payload: { deletedAt: expect.any(String) } })
    await localRepository.restoreAccountHoliday(row.date)
    await expect(db.accountHolidays.get(row.id)).resolves.toMatchObject({ deletedAt: null, reason: 'personal' })
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').first()).resolves.toMatchObject({ entity: 'account_holiday', expectedRevision: 2, payload: { deletedAt: null } })
  })

  it('uploads and downloads version 2 planning fields without changing thresholds or revisions', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(plannedGoal)
    const { client, rpc } = fakeClient({ rpcResult: { status: 'applied', record: serverTracker(plannedGoal, 'sync-user', 1) } })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    const uploadedRecord = rpc.mock.calls[0]?.[1]?.p_record as Record<string, unknown>
    const uploadedDefinition = uploadedRecord.definition as StoredTrackerDefinition
    expect(uploadedRecord.schema_version).toBe(2)
    expect(uploadedDefinition.schemaVersion).toBe(2)
    expect(uploadedDefinition.goalPlanning).toEqual(plannedGoal.goalPlanning)
    expect(uploadedDefinition.metrics[0]?.thresholds).toMatchObject({ minimum: 2, target: 5, stretch: 8 })
    await expect(db.syncRecords.get(`tracker:${plannedGoal.id}`)).resolves.toMatchObject({ serverRevision: 1 })

    await db.trackers.clear()
    await db.syncRecords.clear()
    const { client: pullClient } = fakeClient({ trackerRows: [serverTracker(plannedGoal)] })
    await expect(synchronizeWorkspace('sync-user', pullClient)).resolves.toMatchObject({ downloaded: 1 })
    await expect(db.trackers.get(plannedGoal.id)).resolves.toMatchObject({ schemaVersion: 2, goalPlanning: plannedGoal.goalPlanning })
  })

  it('uploads, downloads, and retains v3 allocations through the existing sync revision path', async () => {
    await activateWorkspace('sync-user')
    const v3: StoredTrackerDefinition = {
      ...plannedGoal, schemaVersion: 3,
      goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'Asia/Kolkata', allocations: { pages: { '2026-10-09': 4 } } },
    }
    await localRepository.saveTracker(v3)
    const { client, rpc } = fakeClient({ rpcResult: { status: 'applied', record: serverTracker(v3, 'sync-user', 1) } })
    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    expect(rpc.mock.calls[0]?.[1]?.p_record).toMatchObject({ schema_version: 3, definition: { schemaVersion: 3, goalPlanning: v3.goalPlanning } })
    await db.trackers.clear()
    await db.syncRecords.clear()
    const { client: pullClient } = fakeClient({ trackerRows: [serverTracker(v3)] })
    await expect(synchronizeWorkspace('sync-user', pullClient)).resolves.toMatchObject({ downloaded: 1 })
    await expect(db.trackers.get(v3.id)).resolves.toMatchObject({ schemaVersion: 3, goalPlanning: v3.goalPlanning })
  })

  it('holds v3 outbox writes in production until the hosted migration readiness flag is enabled', async () => {
    await activateWorkspace('sync-user')
    const v3: StoredTrackerDefinition = {
      ...plannedGoal, schemaVersion: 3, startDate: '2026-01-01',
      goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'UTC', allocations: { pages: { '2026-10-09': 4 } } },
    }
    await db.trackers.put(v3)
    await queueSyncMutation(db, 'sync-user', 'tracker', v3)
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V3', '')
    const { client, rpc } = fakeClient()
    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ uploaded: 0, failed: 1 })
    expect(rpc).not.toHaveBeenCalled()
    await expect(db.trackers.get(v3.id)).resolves.toMatchObject({ schemaVersion: 3, goalPlanning: v3.goalPlanning })
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').first()).resolves.toMatchObject({ status: 'pending', lastError: expect.stringContaining('disabled until the hosted migration') })
  })

  it('uploads only the active owner’s queued tracker and records the server revision', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker())
    const { client, rpc } = fakeClient({ rpcResult: { status: 'applied', record: serverTracker(tracker()) } })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ uploaded: 1, downloaded: 0, conflicts: 0, failed: 0 })
    expect(rpc).toHaveBeenCalledWith('apply_tracker_sync_operation', expect.objectContaining({
      p_expected_user_id: 'sync-user', p_entity: 'tracker', p_expected_revision: null,
      p_record: expect.objectContaining({ id: 'sync-tracker', name: 'Sync tracker' }),
    }))
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').count()).resolves.toBe(0)
    await expect(db.syncRecords.get('tracker:sync-tracker')).resolves.toMatchObject({ serverRevision: 1, ownerUserId: 'sync-user' })
  })

  it('single-flights concurrent automatic and manual requests for the same account', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker())
    let finishRequest: ((result: { data: unknown; error: null }) => void) | undefined
    const { client, rpc } = fakeClient()
    rpc.mockImplementation(() => new Promise((resolve) => { finishRequest = resolve }))

    const automatic = synchronizeWorkspace('sync-user', client)
    const manual = synchronizeWorkspace('sync-user', client)
    expect(manual).toBe(automatic)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
    finishRequest?.({ data: { status: 'applied', record: serverTracker(tracker()) }, error: null })
    await expect(Promise.all([automatic, manual])).resolves.toEqual([
      { uploaded: 1, downloaded: 0, conflicts: 0, failed: 0 },
      { uploaded: 1, downloaded: 0, conflicts: 0, failed: 0 },
    ])
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('repeated download checks update the existing local identity without duplicating records', async () => {
    await activateWorkspace('sync-user')
    const remote = tracker('repeated-download')
    const { client } = fakeClient({ trackerRows: [serverTracker(remote)] })

    await synchronizeWorkspace('sync-user', client)
    await synchronizeWorkspace('sync-user', client)

    await expect(db.trackers.where('id').equals(remote.id).count()).resolves.toBe(1)
  })

  it('compares server tombstones by instant when PostgreSQL returns an offset timestamp', async () => {
    await activateWorkspace('sync-user')
    const remote = { ...tracker('offset-tombstone'), deletedAt: '2026-10-09T11:00:00.000Z' }
    const row = { ...serverTracker(remote), deleted_at: '2026-10-09 11:00:00+00' }
    const { client } = fakeClient({ trackerRows: [row] })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ downloaded: 1, failed: 0 })
    await expect(db.trackers.get(remote.id)).resolves.toMatchObject({ deletedAt: '2026-10-09T11:00:00.000Z' })
  })

  it('reconciles the durable account ledger before uploads and discards stale tracker and entry outbox work', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker('permanently-gone'))
    await localRepository.saveTrackerEntry({ trackerId: 'permanently-gone', date: '2026-10-01', outcome: 'recorded', values: {}, note: 'stale client copy' })
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    const { client, rpc } = fakeClient({ ledgerRows: [{ user_id: 'sync-user', tracker_id: 'permanently-gone', permanently_deleted_at: '2026-10-10T00:00:00.000Z' }] })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ failed: 0 })
    expect(rpc).not.toHaveBeenCalled()
    await expect(db.trackers.get('permanently-gone')).resolves.toBeUndefined()
    await expect(db.trackerEntries.where('trackerId').equals('permanently-gone').count()).resolves.toBe(0)
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').count()).resolves.toBe(0)
    await expect(db.permanentDeletionLedger.get('sync-user:permanently-gone')).resolves.toMatchObject({ trackerId: 'permanently-gone' })
  })

  it('stops before any upload if the deletion ledger returns a different owner', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker('must-not-upload'))
    const { client, rpc } = fakeClient({ ledgerRows: [{ user_id: 'another-user', tracker_id: 'other-deletion', permanently_deleted_at: '2026-10-10T00:00:00.000Z' }] })
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')

    await expect(synchronizeWorkspace('sync-user', client)).rejects.toThrow('another account')
    expect(rpc).not.toHaveBeenCalled()
    await expect(db.trackers.get('must-not-upload')).resolves.toMatchObject({ id: 'must-not-upload' })
  })

  it('waits for the server confirmation before clearing an offline permanent-delete request', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker('delete-request'))
    await localRepository.deleteTracker('delete-request')
    await localRepository.requestPermanentDeletion('delete-request')
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    const { client, rpc } = fakeClient({ rpcError: { message: 'network unavailable' } })
    rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      if (args.p_entity === 'tracker') {
        const local = db.trackers.get('delete-request')
        const current = await local
        return { data: { status: 'applied', record: serverTracker(current!, 'sync-user', 2) }, error: null }
      }
      return { data: null, error: { message: 'network unavailable' } }
    })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ failed: 1 })
    await expect(db.trackers.get('delete-request')).resolves.toMatchObject({ deletedAt: expect.any(String) })
    await expect(db.permanentDeletionRequests.where('ownerUserId').equals('sync-user').first()).resolves.toMatchObject({ status: 'pending', lastError: expect.stringContaining('network unavailable') })
    expect(rpc).toHaveBeenCalledWith('permanently_delete_tracker', expect.objectContaining({ p_expected_user_id: 'sync-user', p_tracker_id: 'delete-request', p_expected_revision: 2 }))
  })

  it('purges local content only after the server confirms permanent deletion', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker('confirmed-delete'))
    await localRepository.saveTrackerEntry({ trackerId: 'confirmed-delete', date: '2026-10-09', outcome: 'recorded', values: {}, note: 'remove after confirmation' })
    await localRepository.deleteTracker('confirmed-delete')
    await localRepository.requestPermanentDeletion('confirmed-delete')
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    const { client, rpc } = fakeClient()
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'permanently_delete_tracker') return { data: { status: 'deleted', tracker_id: 'confirmed-delete', permanently_deleted_at: '2026-10-10 00:00:00+00' }, error: null }
      const payload = args.p_record as StoredTrackerDefinition
      return { data: { status: 'applied', record: serverTracker(payload, 'sync-user', 1) }, error: null }
    })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ uploaded: 2, failed: 0 })
    await expect(db.trackers.get('confirmed-delete')).resolves.toBeUndefined()
    await expect(db.trackerEntries.where('trackerId').equals('confirmed-delete').count()).resolves.toBe(0)
    await expect(db.permanentDeletionLedger.get('sync-user:confirmed-delete')).resolves.toMatchObject({ permanentlyDeletedAt: '2026-10-10T00:00:00Z' })
  })

  it('preserves an offline edit made while the earlier version is in flight', async () => {
    await activateWorkspace('sync-user')
    const original = tracker()
    await localRepository.saveTracker(original)
    let finishRequest: ((result: { data: unknown; error: null }) => void) | undefined
    const { client, rpc } = fakeClient()
    rpc.mockImplementation(() => new Promise((resolve) => { finishRequest = resolve }))

    const syncing = synchronizeWorkspace('sync-user', client)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
    await localRepository.saveTracker({ ...original, name: 'Edited during upload' })
    finishRequest?.({ data: { status: 'applied', record: serverTracker(original, 'sync-user', 1) }, error: null })
    await syncing

    await expect(db.trackers.get(original.id)).resolves.toMatchObject({ name: 'Edited during upload' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['sync-user', 'tracker', original.id]).first()).resolves.toMatchObject({
      status: 'pending', expectedRevision: 1, payload: { name: 'Edited during upload' },
    })
    await expect(db.syncRecords.get(`tracker:${original.id}`)).resolves.toMatchObject({ serverRevision: 1 })
  })

  it('uploads tracker parents before entry tombstones and keeps retries ordered', async () => {
    await activateWorkspace('sync-user')
    const definition = tracker()
    await localRepository.saveTracker(definition)
    const entryDate = '2026-10-09' as const
    const entry = await localRepository.saveTrackerEntry({ trackerId: definition.id, date: entryDate, outcome: 'skipped', values: {}, note: 'Rest day' })
    await localRepository.deleteTrackerEntry(definition.id, entryDate)
    const { client, rpc } = fakeClient()
    rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      const payload = args.p_record as Record<string, unknown>
      return { data: { status: 'applied', record: { ...payload, user_id: 'sync-user', server_revision: 1 } }, error: null }
    })

    const result = await synchronizeWorkspace('sync-user', client)
    expect(result.uploaded).toBe(2)
    expect(rpc.mock.calls.map(([, args]) => args.p_entity)).toEqual(['tracker', 'tracker_entry'])
    expect(rpc.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      p_expected_user_id: 'sync-user',
      p_record: expect.objectContaining({ id: entry.id, deleted_at: expect.any(String), note: 'Rest day' }),
    }))
  })

  it('keeps entry uploads queued while the parent is in the Bin so they can retry after restore', async () => {
    await activateWorkspace('sync-user')
    const parent = tracker('bin-parent')
    await localRepository.saveTracker(parent)
    await localRepository.saveTrackerEntry({ trackerId: parent.id, date: '2026-10-09', outcome: 'recorded', values: {}, note: 'keep this progress' })
    await localRepository.deleteTracker(parent.id)
    const { client, rpc } = fakeClient()
    rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      if (args.p_entity === 'tracker') {
        const payload = args.p_record as Record<string, unknown>
        const definition = payload.definition as StoredTrackerDefinition
        const record = { ...serverTracker(definition, 'sync-user', 2), deleted_at: definition.deletedAt }
        return { data: { status: 'applied', record }, error: null }
      }
      return { data: { status: 'parent_in_bin', tracker_id: parent.id }, error: null }
    })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ failed: 1, conflicts: 0 })
    const entryOperation = await db.syncOperations.where('ownerUserId').equals('sync-user').filter((item) => item.entity === 'tracker_entry').first()
    expect(entryOperation).toMatchObject({ status: 'pending', lastError: expect.stringContaining('tracker is in the Bin') })
    expect(await db.syncConflicts.where('ownerUserId').equals('sync-user').count()).toBe(0)
  })

  it('does not upload child entries when their parent has a revision conflict', async () => {
    await activateWorkspace('sync-user')
    const definition = tracker()
    await localRepository.saveTracker(definition)
    const entry = await localRepository.saveTrackerEntry({ trackerId: definition.id, date: '2026-10-09', outcome: 'recorded', values: {}, note: 'Child must wait' })
    const { client, rpc } = fakeClient({ rpcResult: { status: 'conflict', record: serverTracker({ ...definition, name: 'Cloud parent' }, 'sync-user', 3) } })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ conflicts: 1, uploaded: 0 })

    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ p_entity: 'tracker', p_record: expect.objectContaining({ id: definition.id }) }))
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['sync-user', 'tracker', definition.id]).first()).resolves.toMatchObject({ status: 'conflict' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['sync-user', 'tracker_entry', entry.id]).first()).resolves.toMatchObject({ status: 'pending', payload: { note: 'Child must wait' } })
  })

  it('refuses to send queued work when the authenticated user differs from the workspace', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker())
    const { client, rpc } = fakeClient({ userId: 'other-user' })

    await expect(synchronizeWorkspace('sync-user', client)).rejects.toThrow('does not match this account workspace')
    expect(rpc).not.toHaveBeenCalled()
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').count()).resolves.toBe(1)
  })

  it('keeps queued work local when the session is signed out or offline', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker())
    const { client, rpc } = fakeClient({ userId: '' })

    await expect(synchronizeWorkspace('sync-user', client)).rejects.toThrow('does not match this account workspace')
    expect(rpc).not.toHaveBeenCalled()
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').count()).resolves.toBe(1)
    await expect(db.trackers.get('sync-tracker')).resolves.toMatchObject({ name: 'Sync tracker' })
  })

  it('retains failed uploads and increments their retry metadata', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker())
    const { client } = fakeClient({ rpcError: { message: 'RPC migration is not installed.' } })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ uploaded: 0, failed: 1 })
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').first()).resolves.toMatchObject({ attempts: 1, status: 'pending', lastError: 'RPC migration is not installed.' })
    await expect(db.trackers.get('sync-tracker')).resolves.toMatchObject({ name: 'Sync tracker' })
  })

  it('keeps an operation queued when the server rejects it after an account-session switch', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker())
    const { client, rpc } = fakeClient()
    rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      // Models the session changing after the last client-side getUser check but before
      // the server evaluates auth.uid() and the expected workspace owner.
      expect(args.p_expected_user_id).toBe('sync-user')
      return { data: null, error: { code: '42501', message: 'authenticated owner does not match sync workspace' } }
    })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ uploaded: 0, failed: 1 })
    expect(rpc).toHaveBeenCalledOnce()
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').first()).resolves.toMatchObject({ status: 'pending', attempts: 1 })
    await expect(db.trackers.get('sync-tracker')).resolves.toMatchObject({ name: 'Sync tracker' })
  })

  it('retains the local version and records a server revision conflict', async () => {
    await activateWorkspace('sync-user')
    await localRepository.saveTracker(tracker())
    const remote = { ...serverTracker({ ...tracker(), name: 'Remote title' }, 'sync-user', 4) }
    const { client } = fakeClient({ rpcResult: { status: 'conflict', record: remote } })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ conflicts: 1, uploaded: 0 })
    await expect(db.trackers.get('sync-tracker')).resolves.toMatchObject({ name: 'Sync tracker' })
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').first()).resolves.toMatchObject({ status: 'conflict' })
    await expect(db.syncConflicts.where('ownerUserId').equals('sync-user').first()).resolves.toMatchObject({ remoteRecord: expect.objectContaining({ name: 'Remote title', server_revision: 4 }) })
    await expect(db.syncRecords.get('tracker:sync-tracker')).resolves.toBeUndefined()
  })

  it('downloads owner rows but refuses a row belonging to another account', async () => {
    await activateWorkspace('sync-user')
    const remote = tracker('remote-tracker')
    const { client } = fakeClient({ trackerRows: [serverTracker(remote)] })
    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ downloaded: 1 })
    await expect(db.trackers.get('remote-tracker')).resolves.toMatchObject({ name: 'Sync tracker' })

    await db.trackers.clear()
    await db.syncRecords.clear()
    const { client: foreignClient } = fakeClient({ trackerRows: [serverTracker(tracker('foreign-tracker'), 'other-user')] })
    await expect(synchronizeWorkspace('sync-user', foreignClient)).rejects.toThrow('different account')
    await expect(db.trackers.get('foreign-tracker')).resolves.toBeUndefined()
  })

  it('discards a cloud page when the authenticated account changes before a row is merged', async () => {
    await activateWorkspace('sync-user')
    const remote = tracker('session-switched-row')
    const { client, getUser } = fakeClient({ trackerRows: [serverTracker(remote)] })
    getUser
      .mockResolvedValueOnce({ data: { user: { id: 'sync-user' } }, error: null })
      .mockResolvedValueOnce({ data: { user: { id: 'sync-user' } }, error: null })
      .mockResolvedValueOnce({ data: { user: { id: 'other-user' } }, error: null })

    await expect(synchronizeWorkspace('sync-user', client)).rejects.toThrow('does not match this account workspace')
    await expect(db.trackers.get(remote.id)).resolves.toBeUndefined()
  })

  it('downloads PostgreSQL-style tracker timestamps as canonical UTC without changing their instants', async () => {
    await activateWorkspace('sync-user')
    const remote = {
      ...tracker('postgres-tracker'),
      createdAt: '2026-10-09 04:05:06.123456+00',
      updatedAt: '2026-10-09T09:35:06.123456+05:30',
    }
    const { client } = fakeClient({ trackerRows: [serverTracker(remote)] })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ downloaded: 1 })
    await expect(db.trackers.get('postgres-tracker')).resolves.toMatchObject({
      createdAt: '2026-10-09T04:05:06.123456Z',
      updatedAt: '2026-10-09T04:05:06.123456Z',
    })
  })

  it('downloads PostgreSQL timestamp columns for entries without weakening entry validation', async () => {
    await activateWorkspace('sync-user')
    const remoteEntry = {
      id: 'postgres-entry', user_id: 'sync-user', tracker_id: 'parent', entry_date: '2026-10-09', outcome: 'recorded',
      entry_values: {}, note: 'round trip', created_at: '2026-10-09 04:05:06.123456+00',
      updated_at: '2026-10-09T09:35:06.123456+05:30', deleted_at: null, server_revision: 1,
    }
    const { client } = fakeClient({ trackerEntryRows: [remoteEntry] })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ downloaded: 1 })
    await expect(db.trackerEntries.get('postgres-entry')).resolves.toMatchObject({
      createdAt: '2026-10-09T04:05:06.123456Z',
      updatedAt: '2026-10-09T04:05:06.123456Z',
    })
  })

  it('uploads previously persisted offset timestamps using UTC while preserving the IndexedDB copy', async () => {
    await activateWorkspace('sync-user')
    const legacy = {
      ...tracker('legacy-offset-tracker'),
      createdAt: '2026-10-09T09:35:06.123456+05:30',
      updatedAt: '2026-10-09 04:05:06.123456+00',
    } as StoredTrackerDefinition
    await db.trackers.put(legacy)
    await queueSyncMutation(db, 'sync-user', 'tracker', legacy)
    const { client, rpc } = fakeClient()
    rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      const payload = args.p_record as Record<string, unknown>
      return { data: { status: 'applied', record: {
        ...payload, user_id: 'sync-user', schema_version: 1, kind: 'habit', status: 'active',
        definition: payload.definition, created_at: payload.created_at, updated_at: payload.updated_at,
        deleted_at: null, server_revision: 1,
      } }, error: null }
    })

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    expect(rpc.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      p_record: expect.objectContaining({
        created_at: '2026-10-09T04:05:06.123456Z',
        updated_at: '2026-10-09T04:05:06.123456Z',
        definition: expect.objectContaining({
          createdAt: '2026-10-09T04:05:06.123456Z',
          updatedAt: '2026-10-09T04:05:06.123456Z',
        }),
      }),
    }))
    await expect(db.trackers.get(legacy.id)).resolves.toMatchObject({ createdAt: legacy.createdAt, updatedAt: legacy.updatedAt })
  })

  it('retains a malformed pre-existing local timestamp and its queued operation for recovery', async () => {
    await activateWorkspace('sync-user')
    const malformed = { ...tracker('malformed-local'), createdAt: 'not-a-datetime' } as StoredTrackerDefinition
    await db.trackers.put(malformed)
    await queueSyncMutation(db, 'sync-user', 'tracker', malformed)
    const { client, rpc } = fakeClient()

    await expect(synchronizeWorkspace('sync-user', client)).resolves.toMatchObject({ failed: 1 })
    expect(rpc).not.toHaveBeenCalled()
    await expect(db.trackers.get(malformed.id)).resolves.toMatchObject({ createdAt: 'not-a-datetime' })
    await expect(db.syncOperations.where('ownerUserId').equals('sync-user').first()).resolves.toMatchObject({ status: 'pending', attempts: 1 })
  })
})
