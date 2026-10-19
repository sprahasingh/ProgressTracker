import { describe, expect, it, vi } from 'vitest'
import { ensureAccountWorkspaceTimeZone, saveAccountWorkspaceTimeZone } from './workspaceTimeZone'

function clientFor({ existing, configured = false, readError, writeError }: { existing?: string; configured?: boolean; readError?: Error; writeError?: Error } = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: existing ? { timezone: existing, timezone_configured: configured } : null, error: readError ?? null })
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const upsert = vi.fn().mockResolvedValue({ error: writeError ?? null })
  return { client: { from: vi.fn(() => ({ select, upsert })) } as never, select, eq, maybeSingle, upsert }
}

describe('account workspace timezone persistence', () => {
  it('keeps an existing account timezone authoritative', async () => {
    const mock = clientFor({ existing: 'Asia/Kolkata', configured: true })
    await expect(ensureAccountWorkspaceTimeZone('user-1', 'UTC', mock.client)).resolves.toBe('Asia/Kolkata')
    expect(mock.upsert).not.toHaveBeenCalled()
  })

  it('seeds the account timezone when the account row has not been created', async () => {
    const mock = clientFor()
    await expect(ensureAccountWorkspaceTimeZone('user-1', 'Asia/Kolkata', mock.client)).resolves.toBe('Asia/Kolkata')
    expect(mock.upsert).toHaveBeenCalledWith({ id: 'general', user_id: 'user-1', timezone: 'Asia/Kolkata', timezone_configured: true }, { onConflict: 'user_id' })
  })

  it('replaces a database default timezone that has never been intentionally configured', async () => {
    const mock = clientFor({ existing: 'UTC', configured: false })
    await expect(ensureAccountWorkspaceTimeZone('user-1', 'Asia/Kolkata', mock.client)).resolves.toBe('Asia/Kolkata')
    expect(mock.upsert).toHaveBeenCalledWith({ id: 'general', user_id: 'user-1', timezone: 'Asia/Kolkata', timezone_configured: true }, { onConflict: 'user_id' })
  })

  it('preserves account write failures so sync diagnostics expose the underlying error', async () => {
    const mock = clientFor({ writeError: new Error('offline') })
    await expect(ensureAccountWorkspaceTimeZone('user-1', 'UTC', mock.client)).rejects.toThrow('Unable to save the account workspace time zone: offline')
    await expect(saveAccountWorkspaceTimeZone('user-1', 'UTC', mock.client)).resolves.toBe(false)
  })

  it('preserves account read failures instead of reporting them as write failures', async () => {
    const mock = clientFor({ readError: Object.assign(new Error('permission denied'), { code: '42501' }) })
    await expect(ensureAccountWorkspaceTimeZone('user-1', 'UTC', mock.client)).rejects.toThrow('Unable to read the account workspace time zone (42501): permission denied')
    expect(mock.upsert).not.toHaveBeenCalled()
  })
})
