import { describe, expect, it, vi } from 'vitest'
import { classifyCloudRecoveryError, readCloudRecoverySnapshot, CLOUD_RECOVERY_DIAGNOSTIC_EVENT } from './cloudRecovery'
import { activateWorkspace, db } from '../../db/database'

const tracker = {
  schemaVersion: 1, id: 'tracker-a', name: 'Read', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' },
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' }],
  qualificationRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 1 }, customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', archivedAt: null, deletedAt: null,
}
const trackerRow = { id: tracker.id, user_id: 'owner-a', server_revision: 4, definition: tracker, kind: tracker.kind, status: tracker.status, schema_version: 1, created_at: tracker.createdAt, updated_at: tracker.updatedAt, deleted_at: null }
const entryRow = { id: 'entry-a', user_id: 'owner-a', tracker_id: tracker.id, entry_date: '2026-01-02', outcome: 'recorded', holiday_treatment: null, entry_values: { pages: 3 }, note: '', created_at: tracker.createdAt, updated_at: tracker.updatedAt, deleted_at: null, server_revision: 7 }

function clientFor(options: { trackers?: unknown[]; entries?: unknown[]; authUserId?: string | null; authError?: unknown; readError?: unknown; readErrorFor?: (table: string, columns: string) => unknown } = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: options.authUserId === undefined ? { id: 'owner-a' } : options.authUserId ? { id: options.authUserId } : null }, error: options.authError ?? null }) },
    from: vi.fn((table: string) => {
      const query: Record<string, unknown> = {}
      const chain = (method: string) => (...args: unknown[]) => { calls.push({ table, method, args }); query[method] = args; return chainObject }
      const chainObject = {
        select: chain('select'), eq: chain('eq'), order: chain('order'), limit: chain('limit'), gt: chain('gt'),
        then: (resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) => {
          const columns = (query.select as string[] | undefined)?.[0] ?? ''
          const configuredError = options.readErrorFor?.(table, columns) ?? options.readError
          const data = table === 'trackers' ? options.trackers ?? [trackerRow] : (options.entries ?? [entryRow]).map((row) => {
            if (table === 'tracker_entries' && !columns.split(',').includes('holiday_treatment')) {
              const { holiday_treatment: _ignored, ...legacyRow } = row as Record<string, unknown>
              return legacyRow
            }
            return row
          })
          return Promise.resolve({ data, error: configuredError ?? null }).then(resolve, reject)
        },
      }
      return chainObject
    }),
  }
  return { client: client as never, rawClient: client, calls }
}

describe('read-only cloud recovery snapshot', () => {
  it('verifies account identity, scopes both paged reads to that user, validates records, and preserves revisions', async () => {
    const { client, calls } = clientFor()
    const result = await readCloudRecoverySnapshot('owner-a', client)
    expect(result.trackers).toEqual([{ record: tracker, serverRevision: 4 }])
    expect(result.entries).toEqual([{ record: expect.objectContaining({ id: 'entry-a', trackerId: tracker.id, values: { pages: 3 } }), serverRevision: 7 }])
    expect(result.retrievedAt).toMatch(/^\d{4}-\d\d-/)
    expect(calls.filter((call) => call.method === 'eq')).toEqual([
      { table: 'trackers', method: 'eq', args: ['user_id', 'owner-a'] },
      { table: 'tracker_entries', method: 'eq', args: ['user_id', 'owner-a'] },
    ])
    expect(calls.every((call) => !/insert|update|delete|upsert|rpc/i.test(call.method))).toBe(true)
  })

  it('returns an empty cloud snapshot without treating it as proof that device-local records do not exist', async () => {
    const { client } = clientFor({ trackers: [], entries: [] })
    await expect(readCloudRecoverySnapshot('owner-a', client)).resolves.toMatchObject({ trackers: [], entries: [] })
  })

  it('stops before querying when the authenticated account differs', async () => {
    const { client, rawClient } = clientFor({ authUserId: 'owner-b' })
    await expect(readCloudRecoverySnapshot('owner-a', client)).rejects.toMatchObject({ category: 'authentication' })
    expect(rawClient.from).not.toHaveBeenCalled()
  })

  it('classifies PostgreSQL permission failures as authorization and preserves only safe codes', async () => {
    const { client } = clientFor({ readError: { code: '42501', message: 'private database detail' } })
    await expect(readCloudRecoverySnapshot('owner-a', client)).rejects.toMatchObject({ category: 'authorization', code: '42501', message: expect.not.stringContaining('private') })
  })

  it('reports network and RLS failures as distinct safe diagnostic categories', async () => {
    const network = clientFor({ readError: { name: 'TypeError', message: 'private URL and token' } })
    await expect(readCloudRecoverySnapshot('owner-a', network.client)).rejects.toMatchObject({ category: 'network' })
    const rls = clientFor({ readError: { code: '42501', message: 'policy detail' } })
    await expect(readCloudRecoverySnapshot('owner-a', rls.client)).rejects.toMatchObject({ category: 'authorization' })
  })

  it.each([
    [{ status: 401 }, 'authentication'],
    [{ name: 'AuthApiError', message: 'JWT expired' }, 'authentication'],
    [{ code: '42501' }, 'authorization'],
    [{ status: 403 }, 'authorization'],
    [{ name: 'TypeError' }, 'network'],
    [{ code: '42703', message: 'column tracker_entries.holiday_treatment does not exist' }, 'schema-compatibility'],
    [{ code: '42P01' }, 'schema-compatibility'],
    [{ name: 'LocalStorageFailure' }, 'local-storage'],
    [{ name: 'QuotaExceededError' }, 'local-storage'],
    [{ message: 'email, token, and private record' }, 'unknown'],
  ] as const)('maps safe error evidence to %s', (error, category) => {
    expect(classifyCloudRecoveryError(error)).toBe(category)
  })

  it('preserves safe operation, stage, and database code in diagnostics without raw server text', async () => {
    let detail: unknown
    window.addEventListener(CLOUD_RECOVERY_DIAGNOSTIC_EVENT, ((event: CustomEvent) => { detail = event.detail }) as EventListener, { once: true })
    const { client } = clientFor({ readError: { code: '42501', message: 'sensitive policy and row details' } })
    await expect(readCloudRecoverySnapshot('owner-a', client)).rejects.toBeInstanceOf(Error)
    expect(detail).toMatchObject({ category: 'authorization', stage: 'read', code: '42501' })
    expect((detail as { operation: string }).operation).toMatch(/^cloudRecovery\.(trackers|tracker_entries)\.select$/)
    expect(JSON.stringify(detail)).not.toMatch(/sensitive|policy|row details/)
  })

  it('reads an older schema without the nullable holiday-treatment column and labels that limitation', async () => {
    const { client, calls } = clientFor({
      readErrorFor: (table, columns) => table === 'tracker_entries' && columns.includes('holiday_treatment')
        ? { code: '42703', message: 'column tracker_entries.holiday_treatment does not exist' }
        : null,
    })
    const snapshot = await readCloudRecoverySnapshot('owner-a', client)
    expect(snapshot.schemaCompatibility).toBe('legacy-no-holiday-treatment')
    expect(snapshot.entries[0]?.record).not.toHaveProperty('holidayTreatment')
    expect(calls.filter((call) => call.method === 'select' && call.table === 'tracker_entries').map((call) => call.args[0])).toEqual([
      'id,user_id,tracker_id,entry_date,outcome,holiday_treatment,entry_values,note,created_at,updated_at,deleted_at,server_revision',
      'id,user_id,tracker_id,entry_date,outcome,entry_values,note,created_at,updated_at,deleted_at,server_revision',
    ])
  })

  it('does not use legacy fallback for missing required columns', async () => {
    const { client, calls } = clientFor({ readError: { code: '42703', message: 'column tracker_entries.server_revision does not exist' } })
    await expect(readCloudRecoverySnapshot('owner-a', client)).rejects.toMatchObject({ category: 'schema-compatibility' })
    expect(calls.filter((call) => call.method === 'select' && call.table === 'tracker_entries')).toHaveLength(1)
  })

  it('rejects malformed cloud rows instead of displaying partial or guessed history', async () => {
    const { client } = clientFor({ trackers: [{ ...trackerRow, definition: { ...tracker, name: '' } }] })
    await expect(readCloudRecoverySnapshot('owner-a', client)).rejects.toMatchObject({ category: 'invalid-cloud-data' })
  })

  it('leaves a pending offline check-in and its queued operation byte-for-byte unchanged', async () => {
    const owner = `offline-recovery-${crypto.randomUUID()}`
    await activateWorkspace(owner)
    const localDb = db
    const localEntry = { id: 'offline-entry', trackerId: tracker.id, date: '2026-01-03', outcome: 'recorded' as const, values: { pages: 9 }, note: 'offline', createdAt: tracker.createdAt, updatedAt: tracker.updatedAt, deletedAt: null }
    const pendingOperation = { id: 'offline-operation', ownerUserId: owner, entity: 'tracker_entry' as const, entityId: localEntry.id, operation: 'upsert' as const, expectedRevision: null, payload: localEntry, createdAt: tracker.createdAt, attempts: 0, status: 'pending' as const, lastError: null }
    await localDb.workspaceMetadata.put({ key: 'workspace', userId: owner })
    await localDb.trackerEntries.put(localEntry)
    await localDb.syncOperations.put(pendingOperation)
    const { client } = clientFor({ trackers: [], entries: [] })
    const cloud = await readCloudRecoverySnapshot('owner-a', client)
    expect(cloud.entries).toEqual([])
    await expect(localDb.trackerEntries.get(localEntry.id)).resolves.toEqual(localEntry)
    await expect(localDb.syncOperations.get(pendingOperation.id)).resolves.toEqual(pendingOperation)
    localDb.close()
    await localDb.delete()
    await activateWorkspace(null)
  })
})
