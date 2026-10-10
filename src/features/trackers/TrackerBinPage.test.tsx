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

  it('shows the recovery countdown and confirms before restoring a goal', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValueOnce([deletedTracker]).mockResolvedValue([])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)

    expect(await screen.findByText(/29 days left · eligible/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Read 12 books' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(mocks.restoreTracker).toHaveBeenCalledWith('trash-goal')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('requires an irreversible-delete confirmation and leaves an offline request pending', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([deletedTracker])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    mocks.requestPermanentDeletion.mockResolvedValue('queued')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Permanently delete' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('cannot be recovered'))
    expect(mocks.requestPermanentDeletion).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Permanently delete' }))
    expect(mocks.requestPermanentDeletion).toHaveBeenCalledWith('trash-goal')
    expect(await screen.findByText(/Permanent deletion requests will remain pending until the server confirms them/)).toBeInTheDocument()
  })

  it('keeps account recovery decisions server-authoritative after the local countdown expires', async () => {
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    mocks.listDeletedTrackers.mockResolvedValue([{ ...deletedTracker, deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() }])
    mocks.listPermanentDeletionRequests.mockResolvedValue([])
    render(<MemoryRouter><TrackerBinPage /></MemoryRouter>)
    expect(await screen.findByText('Local estimate passed · reconnect to verify recovery status')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check recovery status' })).toBeEnabled()
  })
})
