import { StrictMode, useEffect } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthProvider'
import { publishWorkspaceMutation } from '../../db/workspaceMutationEvents'

const providerMocks = vi.hoisted(() => ({
  authListener: undefined as undefined | ((event: string, session: { user: { id: string; email: string }; access_token?: string } | null) => void),
  activateWorkspace: vi.fn(), decideGuestData: vi.fn(), getGuestDecision: vi.fn(), getGuestWorkspaceSummary: vi.fn(), getSession: vi.fn(),
  synchronizeWorkspace: vi.fn(),
}))

vi.mock('../../db/database', () => ({
  activateWorkspace: providerMocks.activateWorkspace,
  decideGuestData: providerMocks.decideGuestData,
  getGuestDecision: providerMocks.getGuestDecision,
  getGuestWorkspaceSummary: providerMocks.getGuestWorkspaceSummary,
}))
vi.mock('../../services/supabase/syncEngine', () => ({ synchronizeWorkspace: providerMocks.synchronizeWorkspace }))
vi.mock('../../services/supabase/client', () => ({
  supabaseConfiguration: { status: 'ready', url: 'https://supabase.example.test', publishableKey: 'sb_publishable_test' },
  getSupabaseClient: () => ({ auth: {
    onAuthStateChange: (callback: typeof providerMocks.authListener) => {
      providerMocks.authListener = callback
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    },
    getSession: providerMocks.getSession,
    signOut: vi.fn().mockResolvedValue({ error: null }),
  }, functions: { invoke: vi.fn().mockResolvedValue({ error: null }) } }),
}))

function Probe() {
  const auth = useAuth()
  useEffect(() => { (window as Window & { latestSync?: () => Promise<void> }).latestSync = auth.syncNow }, [auth.syncNow])
  return <div>
    <span data-testid="auth-state">{auth.status}:{auth.user?.id ?? 'guest'}</span>
    <span data-testid="workspace-state">{auth.workspaceStatus}:{auth.workspaceUserId ?? 'guest'}</span>
    <span data-testid="sync-state">{auth.syncStatus}</span>
    <span data-testid="sync-error">{auth.syncError}</span>
    <span data-testid="sync-summary">{auth.syncSummary?.conflicts ?? 0}</span>
    <span data-testid="cloud-recovery-state">{auth.cloudRecoveryPending ? 'pausing' : auth.cloudRecoveryMode ? 'active' : 'off'}</span>
    <span data-testid="cloud-operations-pending">{auth.cloudRecoveryOperationsPending ? 'pending' : 'settled'}</span>
    <span data-testid="workspace-init-stalled">{auth.workspaceInitializationStalled ? 'stalled' : 'normal'}</span>
    <span data-testid="workspace-init-pending">{auth.workspaceInitializationPending ? 'pending' : 'settled'}</span>
    <span data-testid="push-ownership">{auth.pushOwnershipStatus}:{auth.pushOwnershipMessage}</span>
    <span data-testid="auth-user">{auth.status}:{auth.user?.id ?? 'guest'}</span>
    <button onClick={() => void auth.syncNow()}>manual-sync</button>
    <button onClick={auth.enterCloudRecovery}>enter-cloud-recovery</button>
    <button onClick={auth.retryWorkspace}>retry-workspace</button>
    <button onClick={() => void auth.chooseGuestData('kept-separate')}>keep-guest</button>
    <button onClick={() => void auth.signOut()}>auth-signout</button>
  </div>
}

function emit(event: string, userId?: string) {
  const session = userId ? { access_token: `token-${userId}`, user: { id: userId, email: `${userId}@example.com` } } : null
  act(() => providerMocks.authListener?.(event, session))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function captureRecoveryDelays() {
  const callbacks = new Map<number, () => void>()
  const nativeTimeout = window.setTimeout.bind(window)
  vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler === 'function' && (timeout === 5_000 || timeout === 1_500)) {
      callbacks.set(timeout, handler as () => void)
      return 0
    }
    return nativeTimeout(handler, timeout, ...args)
  }) as typeof window.setTimeout)
  return (delay: number) => {
    const callback = callbacks.get(delay)
    if (!callback) throw new Error(`Expected a captured ${delay}ms recovery timer.`)
    act(callback)
  }
}

describe('AuthProvider automatic sync lifecycle', () => {
  beforeEach(() => {
    providerMocks.authListener = undefined
    providerMocks.activateWorkspace.mockReset().mockResolvedValue(undefined)
    providerMocks.decideGuestData.mockReset().mockResolvedValue(undefined)
    providerMocks.getGuestDecision.mockReset().mockResolvedValue('kept-separate')
    providerMocks.getGuestWorkspaceSummary.mockReset().mockResolvedValue({ hasData: false, counts: {} })
    providerMocks.getSession.mockReset().mockResolvedValue({ data: { session: null } })
    providerMocks.synchronizeWorkspace.mockReset().mockResolvedValue({ uploaded: 0, downloaded: 2, conflicts: 0, failed: 0 })
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    delete (window as Window & { latestSync?: () => Promise<void> }).latestSync
    localStorage.removeItem('progress-tracker:push-owner')
    Reflect.deleteProperty(navigator, 'serviceWorker')
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() } })
  })

  afterEach(async () => {
    cleanup()
    window.history.replaceState({}, '', window.location.pathname)
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'serviceWorker')
    Reflect.deleteProperty(navigator, 'locks')
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('progress-tracker-push-ownership')
      request.onsuccess = request.onerror = request.onblocked = () => resolve()
    })
  })

  it('pauses automatic, mutation-triggered, and manual cloud sync for recovery inspection', async () => {
    window.history.replaceState({}, '', '/ProgressTracker/#/settings?recoveryPreview=1#sync-data')
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'read-only-account')
    await waitFor(() => expect(screen.getByTestId('workspace-state')).toHaveTextContent('ready:read-only-account'))

    await act(async () => { await (window as Window & { latestSync?: () => Promise<void> }).latestSync?.() })
    act(() => publishWorkspaceMutation('read-only-account'))
    await new Promise((resolve) => setTimeout(resolve, 550))

    expect(providerMocks.synchronizeWorkspace).not.toHaveBeenCalled()
    expect(screen.getByTestId('sync-state')).toHaveTextContent('idle')
  })

  it('keeps normal synchronization paused while explicit cloud recovery mode is active', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'recovery-mode-account')
    await waitFor(() => expect(screen.getByTestId('workspace-state')).toHaveTextContent('ready:recovery-mode-account'))
    providerMocks.synchronizeWorkspace.mockClear()
    await act(async () => { screen.getByRole('button', { name: 'enter-cloud-recovery' }).click() })
    await act(async () => { await screen.getByRole('button', { name: 'manual-sync' }).click() })
    act(() => publishWorkspaceMutation('recovery-mode-account'))
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(providerMocks.synchronizeWorkspace).not.toHaveBeenCalled()
  })

  it('waits for an already-running sync to settle before exposing cloud recovery', async () => {
    const inFlight = deferred<{ uploaded: number; downloaded: number; conflicts: number; failed: number }>()
    providerMocks.synchronizeWorkspace.mockReturnValue(inFlight.promise)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'recovery-waits-for-sync')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce())
    await act(async () => { screen.getByRole('button', { name: 'enter-cloud-recovery' }).click() })
    expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('pausing')
    await act(async () => { inFlight.resolve({ uploaded: 0, downloaded: 0, conflicts: 0, failed: 0 }); await inFlight.promise })
    await waitFor(() => expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('active'))
  })

  it('opens recovery after a stalled initialization and ignores its late completion until explicit retry', async () => {
    const fireDelay = captureRecoveryDelays()
    const opening = deferred<void>()
    providerMocks.activateWorkspace.mockImplementation((ownerId: string | null) => ownerId === 'stalled-account' ? opening.promise : Promise.resolve())
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'stalled-account')
    expect(providerMocks.activateWorkspace).toHaveBeenCalledWith('stalled-account')

    fireDelay(5_000)
    expect(screen.getByTestId('workspace-init-stalled')).toHaveTextContent('stalled')
    screen.getByRole('button', { name: 'enter-cloud-recovery' }).click()
    fireDelay(1_500)
    expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('active')
    expect(screen.getByTestId('cloud-operations-pending')).toHaveTextContent('pending')

    await act(async () => { opening.resolve(); await opening.promise })
    await waitFor(() => expect(screen.getByTestId('cloud-operations-pending')).toHaveTextContent('settled'))
    expect(screen.getByTestId('workspace-state')).toHaveTextContent('loading:guest')

    await act(async () => { screen.getByRole('button', { name: 'retry-workspace' }).click() })
    await waitFor(() => expect(screen.getByTestId('workspace-state')).toHaveTextContent('ready:stalled-account'))
  })

  it('does not let a late initialization rejection leave recovery or the account stuck', async () => {
    const fireDelay = captureRecoveryDelays()
    const opening = deferred<void>()
    providerMocks.activateWorkspace.mockReturnValue(opening.promise)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'rejecting-account')
    fireDelay(5_000)
    screen.getByRole('button', { name: 'enter-cloud-recovery' }).click()
    fireDelay(1_500)
    await act(async () => { opening.reject(new Error('late storage failure')); await opening.promise.catch(() => undefined) })
    await waitFor(() => expect(screen.getByTestId('cloud-operations-pending')).toHaveTextContent('settled'))
    expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('active')
    expect(screen.getByTestId('workspace-state')).toHaveTextContent('loading:guest')
  })

  it('keeps a stalled previous-account initialization from changing the replacement workspace', async () => {
    const fireDelay = captureRecoveryDelays()
    const accountAOpening = deferred<void>()
    providerMocks.activateWorkspace.mockImplementation((ownerId: string | null) => ownerId === 'account-a' ? accountAOpening.promise : Promise.resolve())
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    fireDelay(5_000)
    screen.getByRole('button', { name: 'enter-cloud-recovery' }).click()
    fireDelay(1_500)
    expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('active')

    emit('SIGNED_IN', 'account-b')
    await waitFor(() => expect(screen.getByTestId('workspace-state')).toHaveTextContent('ready:account-b'))
    await act(async () => { accountAOpening.resolve(); await accountAOpening.promise })
    expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-in:account-b')
    expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('off')
    expect(screen.getByTestId('workspace-state')).toHaveTextContent('ready:account-b')
  })

  it('cleans the stalled-initialization timer when the provider unmounts', () => {
    const clear = vi.spyOn(window, 'clearTimeout')
    captureRecoveryDelays()
    const opening = deferred<void>()
    providerMocks.activateWorkspace.mockReturnValue(opening.promise)
    const view = render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'unmount-account')
    expect(providerMocks.activateWorkspace).toHaveBeenCalledWith('unmount-account')
    view.unmount()
    expect(clear).toHaveBeenCalledWith(0)
  })

  it.each(['resolve', 'reject'] as const)('keeps recovery active and suppresses stale sync state when a timed-out sync later %s', async (completion) => {
    const inFlight = deferred<{ uploaded: number; downloaded: number; conflicts: number; failed: number }>()
    providerMocks.synchronizeWorkspace.mockReturnValue(inFlight.promise)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'late-sync-account')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce())
    const fireDelay = captureRecoveryDelays()
    screen.getByRole('button', { name: 'enter-cloud-recovery' }).click()
    fireDelay(1_500)
    expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('active')
    expect(screen.getByTestId('cloud-operations-pending')).toHaveTextContent('pending')
    await act(async () => { screen.getByRole('button', { name: 'manual-sync' }).click() })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()
    screen.getByRole('button', { name: 'retry-workspace' }).click()
    expect(providerMocks.activateWorkspace).toHaveBeenCalledTimes(1)

    if (completion === 'resolve') inFlight.resolve({ uploaded: 0, downloaded: 99, conflicts: 0, failed: 0 })
    else inFlight.reject(new Error('late network failure'))
    await act(async () => { await inFlight.promise.catch(() => undefined) })
    await waitFor(() => expect(screen.getByTestId('cloud-operations-pending')).toHaveTextContent('settled'))
    expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('active')
    expect(screen.getByTestId('sync-summary')).toHaveTextContent('0')
    await act(async () => { screen.getByRole('button', { name: 'retry-workspace' }).click() })
    await waitFor(() => expect(providerMocks.activateWorkspace).toHaveBeenCalledTimes(2))
  })

  it('clears recovery for a switched account and ignores the previous account sync completion', async () => {
    const accountA = deferred<{ uploaded: number; downloaded: number; conflicts: number; failed: number }>()
    providerMocks.synchronizeWorkspace.mockImplementation((ownerId: string) => ownerId === 'account-a' ? accountA.promise : Promise.resolve({ uploaded: 0, downloaded: 1, conflicts: 0, failed: 0 }))
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledWith('account-a'))
    const fireDelay = captureRecoveryDelays()
    screen.getByRole('button', { name: 'enter-cloud-recovery' }).click()
    fireDelay(1_500)
    expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('active')

    emit('SIGNED_IN', 'account-b')
    await waitFor(() => expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-in:account-b'))
    expect(screen.getByTestId('cloud-recovery-state')).toHaveTextContent('off')
    accountA.resolve({ uploaded: 0, downloaded: 99, conflicts: 0, failed: 0 })
    await act(async () => { await accountA.promise })
    expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-in:account-b')
    expect(screen.getByTestId('sync-summary')).not.toHaveTextContent('99')
  })

  it('revokes Account A with Account A’s captured token before allowing a direct Account A to B switch', async () => {
    const subscription = { endpoint: 'https://push.example.test/a', unsubscribe: vi.fn().mockResolvedValue(true) }
    const worker = { active: { postMessage: vi.fn() }, pushManager: { getSubscription: vi.fn().mockResolvedValueOnce(subscription).mockResolvedValue(null) } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(worker) } })
    localStorage.setItem('progress-tracker:push-owner', 'account-a')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'revoked' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))

    emit('SIGNED_IN', 'account-b')

    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer token-account-a' }) })
    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect(localStorage.getItem('progress-tracker:push-owner')).toBeNull()
  })

  it('blocks the new account and keeps a recoverable cleanup record when offline revocation fails', async () => {
    const subscription = { endpoint: 'https://push.example.test/offline-a', unsubscribe: vi.fn().mockResolvedValue(true) }
    const worker = { active: { postMessage: vi.fn() }, pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(worker) } })
    localStorage.setItem('progress-tracker:push-owner', 'account-a')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))
    emit('SIGNED_IN', 'account-b')

    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('cleanup-required:'))
    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect(localStorage.getItem('progress-tracker:push-owner')).toBe('account-a')
    const pending = await new Promise<{ ownerId: string; endpoint: string }[]>((resolve, reject) => {
      const request = indexedDB.open('progress-tracker-push-ownership', 1)
      request.onsuccess = () => {
        const get = request.result.transaction('pending-cleanups').objectStore('pending-cleanups').getAll()
        get.onsuccess = () => { resolve(get.result); request.result.close() }
        get.onerror = () => reject(get.error)
      }
      request.onerror = () => reject(request.error)
    })
    expect(pending).toEqual([{ ownerId: 'account-a', endpoint: subscription.endpoint }])
  })

  it('requires the previous account for restored sessions and clears queued cleanup when that account returns', async () => {
    const subscription = { endpoint: 'https://push.example.test/recovery', unsubscribe: vi.fn().mockResolvedValue(true) }
    const worker = { active: { postMessage: vi.fn() }, pushManager: { getSubscription: vi.fn().mockResolvedValueOnce(subscription).mockResolvedValue(null) } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(worker) } })
    localStorage.setItem('progress-tracker:push-owner', 'account-a')
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))
    emit('SIGNED_IN', 'account-b')
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('cleanup-required:'))
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer token-account-a' }) })

    emit('SIGNED_IN', 'account-a')
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer token-account-a' }) })
    expect(localStorage.getItem('progress-tracker:push-owner')).toBeNull()
  })

  it('fails closed when an app is restored under B but the stored subscription owner is A', async () => {
    const subscription = { endpoint: 'https://push.example.test/restored', unsubscribe: vi.fn().mockResolvedValue(true) }
    const worker = { active: { postMessage: vi.fn() }, pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(worker) } })
    localStorage.setItem('progress-tracker:push-owner', 'account-a')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-b')

    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('cleanup-required:'))
    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('progress-tracker:push-owner')).toBe('account-a')
  })

  it('uses Account A credentials for a cross-tab A to signed-out transition', async () => {
    const subscription = { endpoint: 'https://push.example.test/cross-tab', unsubscribe: vi.fn().mockResolvedValue(true) }
    const worker = { active: { postMessage: vi.fn() }, pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(worker) } })
    localStorage.setItem('progress-tracker:push-owner', 'account-a')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))
    emit('SIGNED_OUT')
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer token-account-a' }) })
    expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-out:guest')
    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
  })

  it('revokes the owned endpoint before a normal explicit sign-out', async () => {
    const subscription = { endpoint: 'https://push.example.test/explicit', unsubscribe: vi.fn().mockResolvedValue(true) }
    const worker = { active: { postMessage: vi.fn() }, pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(worker) } })
    localStorage.setItem('progress-tracker:push-owner', 'account-a')
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))
    act(() => screen.getByRole('button', { name: 'auth-signout' }).click())
    await waitFor(() => expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-out:guest'))
    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect(localStorage.getItem('progress-tracker:push-owner')).toBeNull()
  })

  it('serializes rapid A to B to A transitions so stale cleanup cannot run after the final identity', async () => {
    const subscription = { endpoint: 'https://push.example.test/rapid', unsubscribe: vi.fn().mockResolvedValue(true) }
    const worker = { active: { postMessage: vi.fn() }, pushManager: { getSubscription: vi.fn().mockResolvedValueOnce(subscription).mockResolvedValue(null) } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(worker) } })
    localStorage.setItem('progress-tracker:push-owner', 'account-a')
    let finish!: (response: Response) => void
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))
    emit('SIGNED_IN', 'account-b')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    emit('SIGNED_IN', 'account-a')
    finish(new Response('{}', { status: 200 }))
    await waitFor(() => expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-in:account-a'))
    await waitFor(() => expect(screen.getByTestId('push-ownership')).toHaveTextContent('ready:'))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer token-account-a' }) })
  })

  it('automatically syncs once after login only after the account workspace is ready', async () => {
    const opening = deferred<void>()
    providerMocks.activateWorkspace.mockImplementation((ownerId: string | null) => ownerId === 'account-a' ? opening.promise : Promise.resolve())
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION')
    await waitFor(() => expect(screen.getByTestId('workspace-state')).toHaveTextContent('ready:guest'))
    emit('SIGNED_IN', 'account-a')
    await waitFor(() => expect(providerMocks.activateWorkspace).toHaveBeenCalledWith('account-a'))
    expect(providerMocks.synchronizeWorkspace).not.toHaveBeenCalled()

    opening.resolve()
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledWith('account-a'))
    expect(await screen.findByTestId('sync-state')).toHaveTextContent('complete')
  })

  it('syncs once when an existing session is restored on app startup', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'restored-account')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledWith('restored-account'))
  })

  it('does not sync for guest or signed-out workspaces', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION')
    await waitFor(() => expect(screen.getByTestId('workspace-state')).toHaveTextContent('ready:guest'))
    expect(providerMocks.synchronizeWorkspace).not.toHaveBeenCalled()
  })

  it('waits for an explicit guest-data decision before starting cloud sync', async () => {
    providerMocks.getGuestDecision.mockResolvedValueOnce(null)
    providerMocks.getGuestWorkspaceSummary.mockResolvedValueOnce({ hasData: true, counts: { trackers: 1 } })
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION')
    emit('SIGNED_IN', 'account-a')
    await waitFor(() => expect(screen.getByTestId('workspace-state')).toHaveTextContent('needs-guest-choice:account-a'))
    expect(providerMocks.synchronizeWorkspace).not.toHaveBeenCalled()
    expect(providerMocks.decideGuestData).not.toHaveBeenCalled()

    act(() => screen.getByRole('button', { name: 'keep-guest' }).click())
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledWith('account-a'))
    expect(providerMocks.decideGuestData).toHaveBeenCalledWith('account-a', 'kept-separate')
  })

  it('does not sync while offline and starts one attempt on reconnection', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION')
    emit('SIGNED_IN', 'offline-account')
    await waitFor(() => expect(screen.getByTestId('sync-state')).toHaveTextContent('offline'))
    expect(providerMocks.synchronizeWorkspace).not.toHaveBeenCalled()

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    act(() => window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledWith('offline-account'))
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()
  })

  it('deduplicates repeated auth events and Strict Mode effects', async () => {
    render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce())
    emit('SIGNED_IN', 'account-a')
    emit('TOKEN_REFRESHED', 'account-a')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()
  })

  it('does not let an old account sync completion replace the new account status', async () => {
    const accountA = deferred<{ uploaded: number; downloaded: number; conflicts: number; failed: number }>()
    providerMocks.synchronizeWorkspace.mockImplementation((userId: string) => userId === 'account-a'
      ? accountA.promise
      : Promise.resolve({ uploaded: 0, downloaded: 1, conflicts: 0, failed: 0 }))
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledWith('account-a'))
    emit('SIGNED_IN', 'account-b')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledWith('account-b'))
    accountA.resolve({ uploaded: 9, downloaded: 9, conflicts: 0, failed: 0 })
    await waitFor(() => expect(screen.getByTestId('sync-state')).toHaveTextContent('complete'))
    expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:account-b')
  })

  it('joins automatic and manual requests and does not loop after a failure', async () => {
    const syncing = deferred<{ uploaded: number; downloaded: number; conflicts: number; failed: number }>()
    providerMocks.synchronizeWorkspace.mockReturnValue(syncing.promise)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce())
    act(() => { void (window as Window & { latestSync?: () => Promise<void> }).latestSync?.() })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()
    syncing.resolve({ uploaded: 0, downloaded: 0, conflicts: 0, failed: 1 })
    await waitFor(() => expect(screen.getByTestId('sync-state')).toHaveTextContent('error'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()
    expect(screen.getByTestId('sync-error')).toHaveTextContent('Some changes remain on this device')
  })

  it('keeps conflict summaries for the existing conflict-resolution screen', async () => {
    providerMocks.synchronizeWorkspace.mockResolvedValueOnce({ uploaded: 0, downloaded: 0, conflicts: 2, failed: 0 })
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(screen.getByTestId('sync-state')).toHaveTextContent('complete'))
    expect(screen.getByTestId('sync-summary')).toHaveTextContent('2')
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()
  })

  it('automatically syncs committed edits for the active account and coalesces rapid changes', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce())
    vi.useFakeTimers()

    act(() => {
      publishWorkspaceMutation('account-a')
      publishWorkspaceMutation('account-a')
      publishWorkspaceMutation('account-a')
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledTimes(2)
    expect(providerMocks.synchronizeWorkspace).toHaveBeenLastCalledWith('account-a')
  })

  it('does not upload guest or another account’s local edits', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce())
    vi.useFakeTimers()
    act(() => {
      publishWorkspaceMutation(null)
      publishWorkspaceMutation('account-b')
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()
  })

  it('holds offline edits until reconnection and does not automatically retry a failed attempt', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(screen.getByTestId('sync-state')).toHaveTextContent('offline'))
    vi.useFakeTimers()
    act(() => publishWorkspaceMutation('account-a'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(providerMocks.synchronizeWorkspace).not.toHaveBeenCalled()

    providerMocks.synchronizeWorkspace.mockResolvedValueOnce({ uploaded: 0, downloaded: 0, conflicts: 0, failed: 1 })
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    act(() => window.dispatchEvent(new Event('online')))
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); await Promise.resolve() })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()
  })

  it('runs one trailing sync when a committed edit lands during an in-flight sync', async () => {
    const firstSync = deferred<{ uploaded: number; downloaded: number; conflicts: number; failed: number }>()
    providerMocks.synchronizeWorkspace.mockReturnValueOnce(firstSync.promise)
    render(<AuthProvider><Probe /></AuthProvider>)
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce())
    vi.useFakeTimers()
    act(() => publishWorkspaceMutation('account-a'))
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledOnce()

    firstSync.resolve({ uploaded: 0, downloaded: 0, conflicts: 0, failed: 0 })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(providerMocks.synchronizeWorkspace).toHaveBeenCalledTimes(2)
  })
})
