import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { StoredTrackerDefinition } from '../../db/models'
import { ToastProvider } from '../../components/ui/ToastProvider'
import { TrackerBinPage } from './TrackerBinPage'

const mocks = vi.hoisted(() => ({
  listDeletedTrackers: vi.fn(), listPendingTrackerRestores: vi.fn(), listPermanentDeletionRequests: vi.fn(), restoreTracker: vi.fn(), requestPermanentDeletion: vi.fn(), syncNow: vi.fn(),
  isOnline: false,
}))
vi.mock('../../db/localRepository', () => ({ localRepository: {
  listDeletedTrackers: mocks.listDeletedTrackers, listPendingTrackerRestores: mocks.listPendingTrackerRestores, listPermanentDeletionRequests: mocks.listPermanentDeletionRequests,
  restoreTracker: mocks.restoreTracker, requestPermanentDeletion: mocks.requestPermanentDeletion,
} }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'signed-in', user: { id: 'bin-account' }, workspaceStatus: 'ready', workspaceUserId: 'bin-account', sessionTransitionPending: false, syncNow: mocks.syncNow, isOnline: mocks.isOnline }) }))

const deletedTracker: StoredTrackerDefinition = {
  schemaVersion: 2, id: 'trash-goal', name: 'Read 12 books', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, deadline: '2026-12-31', metrics: [{ id: 'books', name: 'Books', valueType: 'quantity', unit: 'books' }], customFields: [], milestones: [],
  goalPlanning: { mode: 'daily-recurring', progressSemantics: {}, dailyTargets: { books: 1 }, cumulativeTargets: {} },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
beforeEach(() => { for (const mock of Object.values(mocks)) if (typeof mock === 'function') mock.mockReset(); mocks.isOnline = false })
beforeEach(() => { mocks.listPendingTrackerRestores.mockResolvedValue([]) })

describe('Tracker Bin', () => {
  it('uses the shared vector bin icon in its empty state', async () => {
    mocks.listDeletedTrackers.mockResolvedValue([])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Your Bin is empty' })).toBeInTheDocument()
    const emptyState = screen.getByRole('heading', { name: 'Your Bin is empty' }).closest('.empty-state')
    expect(emptyState?.querySelector('.empty-state-icon svg')).toHaveAttribute('viewBox', '0 0 24 24')
  })

  it('shows a quarantined restore with a clear pending status and no tracker actions', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([])
    mocks.listPendingTrackerRestores.mockResolvedValue([{ tracker: { ...deletedTracker, deletedAt: null }, status: 'pending', message: 'Restoration is waiting for server confirmation. This tracker stays unavailable until the server confirms it.' }])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    expect(await screen.findByText('Restore in progress')).toBeInTheDocument()
    expect(screen.getByText(/You’re offline\. Restore will finish when you reconnect/)).toHaveAttribute('role', 'status')
    expect(screen.getByText(/tracker stays unavailable until then/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Permanently Delete' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Your Bin is empty' })).not.toBeInTheDocument()
  })

  it('explains a rejected or conflicting restore without claiming it succeeded', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([])
    mocks.listPendingTrackerRestores.mockResolvedValue([{ tracker: { ...deletedTracker, deletedAt: null }, status: 'attention', message: 'The cloud record changed. Review the sync conflict in Account.' }])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    expect(await screen.findByText('Restore needs attention')).toBeInTheDocument()
    expect(screen.getByText('Restore needs attention. Your tracker and progress are still saved.')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('link', { name: 'Account and sync' })).toHaveAttribute('href', '/auth')
    expect(screen.queryByText('Tracker restored')).not.toBeInTheDocument()
  })

  it('explains the production availability without exposing migration details', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'false')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    expect(await screen.findByRole('status')).toHaveTextContent('Permanent deletion isn’t available in this app version')
    expect(screen.queryByText(/hosted database migration/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Permanently Delete' })).not.toBeInTheDocument()
  })

  it('describes Bin recovery without promising automatic deletion', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    vi.stubEnv('VITE_ENABLE_AUTOMATIC_BIN_CLEANUP', 'false')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    const { unmount } = render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)
    expect(await screen.findByText(/permanently delete one and choose what happens to its Wins/i)).toBeInTheDocument()
    unmount()
    expect(screen.queryByText(/scheduled cleanup|cron|cleanup flag|reward context/i)).not.toBeInTheDocument()
  })

  it('shows the recovery countdown and confirms before restoring a goal', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValueOnce([deletedTracker]).mockResolvedValue([])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    expect(await screen.findByText(/29 days left to restore · recovery ends/)).toBeInTheDocument()
    expect(screen.getByText(/Was Active/)).toBeInTheDocument()
    expect(screen.getByText(/Moved to Bin/)).toBeInTheDocument()
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
    await user.click(await screen.findByRole('button', { name: 'Permanently Delete' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Permanently Delete “Read 12 books”?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveClass('tracker-deletion-dialog')
    expect(dialog).toHaveTextContent('This cannot be undone.')
    expect(screen.getByRole('radio', { name: /Keep My Wins/ })).toBeChecked()
    expect(screen.getByText(/Keeps your XP, badges, achievements, and reward history with appropriate tracker context/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Choose what happens to its Wins' })).toBeInTheDocument()
    expect(mocks.requestPermanentDeletion).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mocks.requestPermanentDeletion).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Permanently Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Permanently Delete' }))
    expect(mocks.requestPermanentDeletion).toHaveBeenCalledWith('trash-goal', 'keep_wins')
    expect(await screen.findByText(/Permanent deletion will finish when you reconnect/)).toBeInTheDocument()
  })

  it('queues the explicit Delete Wins choice without silently changing it to retention', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    mocks.requestPermanentDeletion.mockResolvedValue('queued')
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Permanently Delete' }))
    await user.click(screen.getByRole('radio', { name: /Delete Tracker and Wins/ }))
    expect(screen.getByRole('radio', { name: /Delete Tracker and Wins/ })).toBeChecked()
    expect(screen.getByText(/If rewards can’t be safely separated, nothing will be deleted/)).toBeInTheDocument()
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Permanently Delete' }))
    expect(mocks.requestPermanentDeletion).toHaveBeenCalledWith('trash-goal', 'delete_wins')
  })

  it('keeps the tracker in the Bin and reports when the local deletion request fails', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    mocks.requestPermanentDeletion.mockRejectedValue(new Error('request failed'))
    const user = userEvent.setup()
    render(<ToastProvider><MemoryRouter><TrackerBinPage /></MemoryRouter></ToastProvider>)

    await user.click(await screen.findByRole('button', { name: 'Permanently Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Permanently Delete' }))

    expect(await screen.findByRole('heading', { name: 'Read 12 books' })).toBeInTheDocument()
    expect(await screen.findByRole('alert', { name: 'Couldn’t request permanent deletion' })).toHaveTextContent('Your tracker is unchanged. Check your connection and try again.')
    expect(mocks.requestPermanentDeletion).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Permanently Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Permanently Delete' }))
    expect(mocks.requestPermanentDeletion).toHaveBeenCalledTimes(2)
  })

  it('shows a disabled deleting state while the deletion request is pending', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    let resolveRequest!: (value: 'queued') => void
    mocks.requestPermanentDeletion.mockReturnValue(new Promise<'queued'>((resolve) => { resolveRequest = resolve }))
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Permanently Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Permanently Delete' }))
    const deleting = await screen.findByRole('button', { name: 'Deleting…' })
    expect(deleting).toBeDisabled()
    expect(deleting).toHaveAttribute('aria-busy', 'true')
    expect(mocks.requestPermanentDeletion).toHaveBeenCalledTimes(1)

    resolveRequest('queued')
    expect(await screen.findByText(/Permanent deletion will finish when you reconnect/)).toBeInTheDocument()
  })

  it('blocks restore and another delete attempt until a sync conflict is resolved', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([{ id: 'delete-conflict', ownerUserId: 'bin-account', trackerId: deletedTracker.id, requestedAt: new Date().toISOString(), status: 'conflict', lastError: 'The cloud tracker changed. Resolve its sync conflict before deleting it permanently.' }])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    expect(await screen.findByText(/This tracker changed on another device/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Resolve account issue' })).toBeDisabled()
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
