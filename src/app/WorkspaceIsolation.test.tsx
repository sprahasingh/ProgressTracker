import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredTrackerDefinition } from '../db/models'
import { AuthProvider, useAuth } from '../features/auth/AuthProvider'
import { TrackerLibraryPage } from '../features/trackers/TrackerLibraryPage'
import { AppShell } from './AppShell'

const isolationMocks = vi.hoisted(() => ({
  authListener: undefined as undefined | ((event: string, session: { user: { id: string; email: string } } | null) => void),
  activeOwner: null as string | null,
  activateWorkspace: vi.fn(), decideGuestData: vi.fn(), getGuestDecision: vi.fn(), getGuestWorkspaceSummary: vi.fn(),
  getAppSettings: vi.fn(), listTrackers: vi.fn(), listTrackerEntriesBetween: vi.fn(), synchronizeWorkspace: vi.fn(), signOut: vi.fn(),
}))

vi.mock('../db/database', () => ({
  activateWorkspace: isolationMocks.activateWorkspace,
  decideGuestData: isolationMocks.decideGuestData,
  getGuestDecision: isolationMocks.getGuestDecision,
  getGuestWorkspaceSummary: isolationMocks.getGuestWorkspaceSummary,
}))
vi.mock('../db/localRepository', () => ({
  localRepository: {
    getAppSettings: isolationMocks.getAppSettings,
    listTrackers: isolationMocks.listTrackers,
    listTrackerEntriesBetween: isolationMocks.listTrackerEntriesBetween,
    archiveTracker: vi.fn(),
  },
}))
vi.mock('../services/supabase/syncEngine', () => ({ synchronizeWorkspace: isolationMocks.synchronizeWorkspace }))
vi.mock('../services/supabase/client', () => ({
  getSupabaseClient: () => ({ auth: {
    onAuthStateChange: (callback: typeof isolationMocks.authListener) => {
      isolationMocks.authListener = callback
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    },
    signOut: isolationMocks.signOut,
  } }),
}))

const savedTracker = (name: string) => ({
  schemaVersion: 1 as const,
  id: name.toLowerCase().replaceAll(' ', '-'), name, description: '', kind: 'habit' as const,
  status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '',
  schedule: { kind: 'every-day' as const }, metrics: [], customFields: [], milestones: [],
  createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', archivedAt: null, deletedAt: null,
}) as StoredTrackerDefinition

function emit(event: string, userId?: string) {
  const session = userId ? { user: { id: userId, email: `${userId}@example.com` } } : null
  act(() => isolationMocks.authListener?.(event, session))
}

function renderTrackers() {
  return render(<AuthProvider><SignOutAction /><MemoryRouter initialEntries={['/trackers']}><Routes><Route path="/" element={<AppShell />}>
    <Route path="trackers" element={<TrackerLibraryPage />} />
  </Route></Routes></MemoryRouter></AuthProvider>)
}

function SignOutAction() {
  const auth = useAuth()
  return <button onClick={() => void auth.signOut()}>request-signout</button>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('workspace rendering isolation', () => {
  beforeEach(() => {
    isolationMocks.authListener = undefined
    isolationMocks.activeOwner = null
    isolationMocks.activateWorkspace.mockReset().mockImplementation(async (ownerId: string | null) => { isolationMocks.activeOwner = ownerId })
    isolationMocks.decideGuestData.mockReset().mockResolvedValue(undefined)
    isolationMocks.getGuestDecision.mockReset().mockResolvedValue('kept-separate')
    isolationMocks.getGuestWorkspaceSummary.mockReset().mockResolvedValue({ hasData: false, counts: {} })
    isolationMocks.getAppSettings.mockReset().mockResolvedValue({
      id: 'general', timezone: 'UTC', appearance: 'system', backupReminderDays: null,
      updatedAt: '2026-10-09T00:00:00.000Z',
    })
    isolationMocks.listTrackers.mockReset().mockImplementation(async () => isolationMocks.activeOwner === null ? [savedTracker('Guest tracker')] : [savedTracker(`Test ${isolationMocks.activeOwner}`)])
    isolationMocks.listTrackerEntriesBetween.mockReset().mockResolvedValue([])
    isolationMocks.synchronizeWorkspace.mockReset().mockResolvedValue({ uploaded: 0, downloaded: 0, conflicts: 0, failed: 0 })
    isolationMocks.signOut.mockReset().mockResolvedValue({ error: null })
  })
  afterEach(() => cleanup())

  it('does not expose guest rows while authentication is unresolved, including a pre-initialization auth event', async () => {
    renderTrackers()
    emit('SIGNED_IN', 'account-a')
    expect(screen.getByRole('heading', { name: 'Opening your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
    expect(screen.queryByText('Guest tracker')).not.toBeInTheDocument()
    expect(isolationMocks.activateWorkspace).not.toHaveBeenCalled()

    emit('INITIAL_SESSION')
    expect(await screen.findByText('Guest tracker')).toBeInTheDocument()
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
  })

  it('keeps tracker content hidden during restored-session and IndexedDB workspace initialization', async () => {
    const opening = deferred<void>()
    isolationMocks.activateWorkspace.mockImplementation(async (ownerId: string | null) => {
      if (ownerId === 'account-a') await opening.promise
      isolationMocks.activeOwner = ownerId
    })
    renderTrackers()
    emit('INITIAL_SESSION', 'account-a')

    expect(await screen.findByRole('heading', { name: 'Opening your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
    expect(isolationMocks.listTrackers).not.toHaveBeenCalled()
    opening.resolve()

    expect(await screen.findByText('Test account-a')).toBeInTheDocument()
    expect(screen.queryByText('Guest tracker')).not.toBeInTheDocument()
  })

  it('hides the signed-in account immediately on sign-out and then shows only guest data', async () => {
    const guestOpening = deferred<void>()
    isolationMocks.activateWorkspace.mockImplementation(async (ownerId: string | null) => {
      if (ownerId === null && isolationMocks.activeOwner === 'account-a') await guestOpening.promise
      isolationMocks.activeOwner = ownerId
    })
    renderTrackers()
    emit('INITIAL_SESSION', 'account-a')
    expect(await screen.findByText('Test account-a')).toBeInTheDocument()

    emit('SIGNED_OUT')
    expect(screen.getByRole('heading', { name: 'Opening your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
    guestOpening.resolve()
    expect(await screen.findByText('Guest tracker')).toBeInTheDocument()
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
  })

  it('hides loaded trackers as soon as sign-out is requested, before Supabase resolves it', async () => {
    const request = deferred<{ error: null }>()
    isolationMocks.signOut.mockReturnValue(request.promise)
    renderTrackers()
    emit('INITIAL_SESSION', 'account-a')
    expect(await screen.findByText('Test account-a')).toBeInTheDocument()

    act(() => screen.getByRole('button', { name: 'request-signout' }).click())
    expect(screen.getByRole('heading', { name: 'Opening your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
    request.resolve({ error: null })
    expect(await screen.findByText('Guest tracker')).toBeInTheDocument()
  })

  it('hides Account A during a switch and renders only Account B after B workspace verification', async () => {
    const accountBOpening = deferred<void>()
    isolationMocks.activateWorkspace.mockImplementation(async (ownerId: string | null) => {
      if (ownerId === 'account-b') await accountBOpening.promise
      isolationMocks.activeOwner = ownerId
    })
    renderTrackers()
    emit('INITIAL_SESSION', 'account-a')
    expect(await screen.findByText('Test account-a')).toBeInTheDocument()

    emit('SIGNED_IN', 'account-b')
    expect(screen.getByRole('heading', { name: 'Opening your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
    expect(screen.queryByText('Test account-b')).not.toBeInTheDocument()
    accountBOpening.resolve()
    expect(await screen.findByText('Test account-b')).toBeInTheDocument()
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
  })

  it('isolates guest-to-account and account-to-guest transitions without dropping guest records', async () => {
    renderTrackers()
    emit('INITIAL_SESSION')
    expect(await screen.findByText('Guest tracker')).toBeInTheDocument()

    emit('SIGNED_IN', 'account-a')
    expect(await screen.findByText('Test account-a')).toBeInTheDocument()
    expect(screen.queryByText('Guest tracker')).not.toBeInTheDocument()

    emit('SIGNED_OUT')
    expect(await screen.findByText('Guest tracker')).toBeInTheDocument()
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
  })

  it('ignores a stale tracker read that resolves after switching workspaces', async () => {
    const staleRead = deferred<StoredTrackerDefinition[]>()
    isolationMocks.listTrackers.mockImplementation(async () => {
      if (isolationMocks.activeOwner === 'account-a') return staleRead.promise
      return [savedTracker(`Test ${isolationMocks.activeOwner ?? 'Guest'}`)]
    })
    renderTrackers()
    emit('INITIAL_SESSION', 'account-a')
    await waitFor(() => expect(isolationMocks.listTrackers).toHaveBeenCalledOnce())

    emit('SIGNED_IN', 'account-b')
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
    expect(await screen.findByText('Test account-b')).toBeInTheDocument()
    staleRead.resolve([savedTracker('Test account-a')])
    await act(async () => { await staleRead.promise })
    expect(screen.queryByText('Test account-a')).not.toBeInTheDocument()
    expect(screen.getByText('Test account-b')).toBeInTheDocument()
  })
})
