import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { activateWorkspace, db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { synchronizeWorkspace } from './syncEngine'

const tracker = (id = 'sync-tracker'): StoredTrackerDefinition => ({
  schemaVersion: 1, id, name: 'Sync tracker', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [], customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', archivedAt: null, deletedAt: null,
})

const serverTracker = (record: StoredTrackerDefinition, owner = 'sync-user', revision = 1) => ({
  id: record.id, user_id: owner, schema_version: record.schemaVersion, kind: record.kind, status: record.status,
  name: record.name, definition: record, created_at: record.createdAt, updated_at: record.updatedAt,
  deleted_at: record.deletedAt, server_revision: revision,
})

function fakeClient(options: { userId?: string; rpcResult?: unknown; rpcError?: { message: string } | null; trackerRows?: unknown[] } = {}) {
  const rpc = vi.fn().mockResolvedValue({ data: options.rpcResult ?? null, error: options.rpcError ?? null })
  const getUser = vi.fn().mockResolvedValue({ data: { user: options.userId === undefined ? { id: 'sync-user' } : options.userId ? { id: options.userId } : null }, error: null })
  const from = vi.fn((table: string) => {
    const rows = table === 'trackers' ? options.trackerRows ?? [] : []
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
  db.close()
  await db.delete()
})

describe('account-scoped sync engine', () => {
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
})
