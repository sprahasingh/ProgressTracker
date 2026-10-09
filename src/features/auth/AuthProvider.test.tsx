import { StrictMode, useEffect } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthProvider'
import { publishWorkspaceMutation } from '../../db/workspaceMutationEvents'

const providerMocks = vi.hoisted(() => ({
  authListener: undefined as undefined | ((event: string, session: { user: { id: string; email: string } } | null) => void),
  activateWorkspace: vi.fn(), decideGuestData: vi.fn(), getGuestDecision: vi.fn(), getGuestWorkspaceSummary: vi.fn(),
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
  getSupabaseClient: () => ({ auth: {
    onAuthStateChange: (callback: typeof providerMocks.authListener) => {
      providerMocks.authListener = callback
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    },
    signOut: vi.fn().mockResolvedValue({ error: null }),
  } }),
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
    <button onClick={() => void auth.syncNow()}>manual-sync</button>
    <button onClick={() => void auth.chooseGuestData('kept-separate')}>keep-guest</button>
  </div>
}

function emit(event: string, userId?: string) {
  const session = userId ? { user: { id: userId, email: `${userId}@example.com` } } : null
  act(() => providerMocks.authListener?.(event, session))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('AuthProvider automatic sync lifecycle', () => {
  beforeEach(() => {
    providerMocks.authListener = undefined
    providerMocks.activateWorkspace.mockReset().mockResolvedValue(undefined)
    providerMocks.decideGuestData.mockReset().mockResolvedValue(undefined)
    providerMocks.getGuestDecision.mockReset().mockResolvedValue('kept-separate')
    providerMocks.getGuestWorkspaceSummary.mockReset().mockResolvedValue({ hasData: false, counts: {} })
    providerMocks.synchronizeWorkspace.mockReset().mockResolvedValue({ uploaded: 0, downloaded: 2, conflicts: 0, failed: 0 })
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    delete (window as Window & { latestSync?: () => Promise<void> }).latestSync
  })

  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

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
