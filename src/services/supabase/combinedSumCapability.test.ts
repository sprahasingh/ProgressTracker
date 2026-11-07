import { describe, expect, it, vi } from 'vitest'
import { createCombinedSumCapabilityStore, getCombinedSumCapability, refreshCombinedSumCapability, resetCombinedSumCapabilityForTests } from './combinedSumCapability'

function capabilityClient(data: unknown, error: { message: string; code?: string } | null = null, userId = 'user-1') {
  return {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: userId ? { user: { id: userId } } : null }, error: null }) },
    rpc: vi.fn().mockResolvedValue({ data, error }),
  }
}

describe('Combined Sum server capability', () => {
  it('enables writes only for the versioned verified true response', async () => {
    const client = capabilityClient({ version: 1, capabilities: { combinedSum: true } })
    const store = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-a' })
    await expect(store.refresh()).resolves.toMatchObject({ status: 'enabled', userId: 'user-1' })
    expect(client.rpc).toHaveBeenCalledWith('progress_tracker_capabilities', {})
  })

  it('represents a valid false response as disabled', async () => {
    const client = capabilityClient({ version: 1, capabilities: { combinedSum: false } })
    const store = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-a' })
    await expect(store.refresh()).resolves.toMatchObject({ status: 'disabled' })
  })

  it.each([
    ['missing RPC', null, { message: 'function not found', code: 'PGRST202' }],
    ['network failure', null, { message: 'offline' }],
  ])('fails closed on %s', async (_label, data, error) => {
    const client = capabilityClient(data, error)
    const store = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-a' })
    await expect(store.refresh()).resolves.toMatchObject({ status: 'unknown' })
  })

  it('fails closed for malformed or unknown capability versions', async () => {
    const client = capabilityClient({ version: 2, capabilities: { combinedSum: true } })
    const store = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-a' })
    await expect(store.refresh()).resolves.toMatchObject({ status: 'unknown', reason: 'invalid-response' })
  })

  it('requires an authenticated session and scopes cache by project and user', async () => {
    const client = capabilityClient({ version: 1, capabilities: { combinedSum: true } })
    const store = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-a' })
    await store.refresh()
    expect(store.getCached('user-2')).toMatchObject({ status: 'unknown' })
    expect(store.getCached('user-1')).toMatchObject({ status: 'enabled' })
    const switchedProject = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-b' })
    await switchedProject.refresh()
    expect(switchedProject.getCached('user-1')).toMatchObject({ status: 'enabled' })
    expect(store.getCached('user-1')).toMatchObject({ status: 'enabled' })
    const unauthenticated = capabilityClient(null, null, '')
    const noSessionStore = createCombinedSumCapabilityStore({ clientProvider: () => unauthenticated as never, projectProvider: () => 'project-a' })
    await expect(noSessionStore.refresh()).resolves.toMatchObject({ status: 'unknown', reason: 'unauthenticated' })
  })

  it('allows an unexpired verified result offline, but expires it and fails closed after restart', async () => {
    let time = 100
    let online = true
    const client = capabilityClient({ version: 1, capabilities: { combinedSum: true } })
    const store = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-a', now: () => time, isOnline: () => online, ttlMs: 50 })
    await store.refresh()
    online = false
    await expect(store.refresh(true)).resolves.toMatchObject({ status: 'enabled' })
    const freshStore = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-a', now: () => time, isOnline: () => online, ttlMs: 50 })
    await expect(freshStore.refresh()).resolves.toMatchObject({ status: 'unknown' })
    time = 151
    expect(store.getCached('user-1')).toMatchObject({ status: 'unknown' })
  })

  it('invalidates verified support after a failed recheck', async () => {
    const client = capabilityClient({ version: 1, capabilities: { combinedSum: true } })
    const store = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-a' })
    await store.refresh()
    client.rpc.mockResolvedValueOnce({ data: null, error: { message: 'network error' } })
    await expect(store.refresh(true)).resolves.toMatchObject({ status: 'unknown' })
    expect(store.getCached('user-1')).toMatchObject({ status: 'unknown' })
  })
  it('invalidates cached support when the configured Supabase project changes', async () => {
    let project = 'project-a'
    const client = capabilityClient({ version: 1, capabilities: { combinedSum: true } })
    const store = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => project })
    await store.refresh()
    expect(store.getCached('user-1')).toMatchObject({ status: 'enabled' })
    project = 'project-b'
    expect(store.getCached('user-1')).toMatchObject({ status: 'unknown' })
    project = 'project-a'
    expect(store.getCached('user-1')).toMatchObject({ status: 'unknown' })
  })

  it('does not cache a late enabled response after the session scope is invalidated', async () => {
    let resolveRpc!: (value: { data: unknown; error: null }) => void
    const client = capabilityClient(null)
    client.rpc.mockImplementation(() => new Promise((resolve) => { resolveRpc = resolve }) as never)
    const store = createCombinedSumCapabilityStore({ clientProvider: () => client as never, projectProvider: () => 'project-a' })
    const request = store.refresh(true)
    await Promise.resolve()
    await Promise.resolve()
    store.invalidate()
    resolveRpc({ data: { version: 1, capabilities: { combinedSum: true } }, error: null })
    await expect(request).resolves.toMatchObject({ status: 'unknown' })
    expect(store.getCached('user-1')).toMatchObject({ status: 'unknown' })
  })

  it('invalidates the session cache on sign-out and account changes', async () => {
    resetCombinedSumCapabilityForTests()
    let authListener: ((event: string, session: { user: { id: string } } | null) => void) | undefined
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'session-user' } } }, error: null }),
        onAuthStateChange: vi.fn((listener: typeof authListener) => { authListener = listener; return { data: { subscription: { unsubscribe: vi.fn() } } } }),
      },
      rpc: vi.fn().mockResolvedValue({ data: { version: 1, capabilities: { combinedSum: true } }, error: null }),
    }
    await expect(refreshCombinedSumCapability(true, client as never)).resolves.toMatchObject({ status: 'enabled' })
    expect(getCombinedSumCapability('session-user')).toMatchObject({ status: 'enabled' })
    authListener?.('SIGNED_OUT', null)
    expect(getCombinedSumCapability('session-user')).toMatchObject({ status: 'unknown' })
    resetCombinedSumCapabilityForTests()
  })

})
