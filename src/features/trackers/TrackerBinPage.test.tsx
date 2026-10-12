import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { StoredTrackerDefinition } from '../../db/models'
import { TrackerBinPage } from './TrackerBinPage'

const mocks = vi.hoisted(() => ({
  listDeletedTrackers: vi.fn(), listPermanentDeletionRequests: vi.fn(), restoreTracker: vi.fn(), requestPermanentDeletion: vi.fn(), syncNow: vi.fn(),
}))
vi.mock('../../db/localRepository', () => ({ localRepository: {
  listDeletedTrackers: mocks.listDeletedTrackers, listPermanentDeletionRequests: mocks.listPermanentDeletionRequests,
  restoreTracker: mocks.restoreTracker, requestPermanentDeletion: mocks.requestPermanentDeletion,
} }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'signed-in', user: { id: 'bin-account' }, workspaceStatus: 'ready', workspaceUserId: 'bin-account', sessionTransitionPending: false, syncNow: mocks.syncNow, isOnline: false }) }))

const deletedTracker: StoredTrackerDefinition = {
  schemaVersion: 2, id: 'trash-goal', name: 'Read 12 books', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, deadline: '2026-12-31', metrics: [{ id: 'books', name: 'Books', valueType: 'quantity', unit: 'books' }], customFields: [], milestones: [],
  goalPlanning: { mode: 'daily-recurring', progressSemantics: {}, dailyTargets: { books: 1 }, cumulativeTargets: {} },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset() })

describe('Tracker Bin', () => {
  it('uses the shared vector bin icon in its empty state', async () => {
    mocks.listDeletedTrackers.mockResolvedValue([])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Your Bin is empty' })).toBeInTheDocument()
    const emptyState = screen.getByRole('heading', { name: 'Your Bin is empty' }).closest('.empty-state')
    expect(emptyState?.querySelector('.empty-state-icon svg')).toHaveAttribute('viewBox', '0 0 24 24')
  })

  it('explains the production availability without exposing migration details', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'false')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    expect(await screen.findByRole('status')).toHaveTextContent('Permanent deletion isn’t available in this app version')
    expect(screen.queryByText(/hosted database migration/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Permanently delete' })).not.toBeInTheDocument()
  })

  it('only claims automatic deletion when the dedicated verified-cleanup build flag is enabled', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    vi.stubEnv('VITE_ENABLE_AUTOMATIC_BIN_CLEANUP', 'false')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    const { unmount } = render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)
    expect(await screen.findByText(/Trackers are not automatically removed after 30 days/)).toBeInTheDocument()
    unmount()

    vi.stubEnv('VITE_ENABLE_AUTOMATIC_BIN_CLEANUP', 'true')
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)
    expect(await screen.findByText('Trackers in the Bin are permanently deleted after 30 days. You can restore or permanently delete them sooner.')).toBeInTheDocument()
  })

  it('shows the recovery countdown and confirms before restoring a goal', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValueOnce([deletedTracker]).mockResolvedValue([])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    expect(await screen.findByText(/29 days left to restore · recovery ends/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Read 12 books' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(mocks.restoreTracker).toHaveBeenCalledWith('trash-goal')
  })

  it('requires an irreversible-delete confirmation and leaves an offline request pending', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    mocks.requestPermanentDeletion.mockResolvedValue('queued')
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Permanently delete' }))
    expect(await screen.findByRole('alertdialog', { name: 'Delete “Read 12 books” permanently?' })).toHaveTextContent('cannot be restored')
    expect(mocks.requestPermanentDeletion).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mocks.requestPermanentDeletion).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Permanently delete' }))
    await user.click(await screen.findByRole('button', { name: 'Delete permanently' }))
    expect(mocks.requestPermanentDeletion).toHaveBeenCalledWith('trash-goal')
    expect(await screen.findByText(/Permanent deletion requests will remain pending until the server confirms them/)).toBeInTheDocument()
  })

  it('keeps the tracker in the Bin and reports when the local deletion request fails', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    mocks.requestPermanentDeletion.mockRejectedValue(new Error('request failed'))
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Permanently delete' }))
    await user.click(await screen.findByRole('button', { name: 'Delete permanently' }))

    expect(await screen.findByRole('heading', { name: 'Read 12 books' })).toBeInTheDocument()
    expect(mocks.requestPermanentDeletion).toHaveBeenCalledTimes(1)
  })

  it('shows a disabled deleting state while the deletion request is pending', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    let resolveRequest!: (value: 'queued') => void
    mocks.requestPermanentDeletion.mockReturnValue(new Promise<'queued'>((resolve) => { resolveRequest = resolve }))
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Permanently delete' }))
    await user.click(await screen.findByRole('button', { name: 'Delete permanently' }))
    const deleting = await screen.findByRole('button', { name: 'Deleting…' })
    expect(deleting).toBeDisabled()
    expect(deleting).toHaveAttribute('aria-busy', 'true')
    expect(mocks.requestPermanentDeletion).toHaveBeenCalledTimes(1)

    resolveRequest('queued')
    expect(await screen.findByText(/Permanent deletion requests will remain pending until the server confirms them/)).toBeInTheDocument()
  })

  it('blocks restore and another delete attempt until a sync conflict is resolved', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([{ id: 'delete-conflict', ownerUserId: 'bin-account', trackerId: deletedTracker.id, requestedAt: new Date().toISOString(), status: 'conflict', lastError: 'The cloud tracker changed. Resolve its sync conflict before deleting it permanently.' }])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    expect(await screen.findByText(/Resolve its sync conflict before deleting it permanently/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Resolve sync conflict' })).toBeDisabled()
  })

  it('keeps account recovery decisions server-authoritative after the local countdown expires', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([{ ...deletedTracker, deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() }])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)
    expect(await screen.findByText('Recovery estimate passed · reconnect to check status')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check recovery status' })).toBeEnabled()
  })
})
