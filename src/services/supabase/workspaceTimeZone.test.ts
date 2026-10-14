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

  it('reports account write failures so the UI can explain that local settings did not sync', async () => {
    const mock = clientFor({ writeError: new Error('offline') })
    await expect(ensureAccountWorkspaceTimeZone('user-1', 'UTC', mock.client)).resolves.toBeNull()
    await expect(saveAccountWorkspaceTimeZone('user-1', 'UTC', mock.client)).resolves.toBe(false)
  })
})
