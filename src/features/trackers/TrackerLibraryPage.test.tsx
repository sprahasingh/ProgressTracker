import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TrackerLibraryPage } from './TrackerLibraryPage'

const libraryMocks = vi.hoisted(() => ({ listTrackers: vi.fn() }))
vi.mock('../../db/localRepository', () => ({ localRepository: { listTrackers: libraryMocks.listTrackers, archiveTracker: vi.fn() } }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'signed-in', user: { id: 'account-a' }, workspaceStatus: 'ready', workspaceUserId: 'account-a', syncStatus: 'syncing', isOnline: true }) }))

describe('TrackerLibraryPage initial cloud state', () => {
  afterEach(() => cleanup())

  it('does not describe an empty local list as an empty account during initial cloud sync', async () => {
    libraryMocks.listTrackers.mockResolvedValue([])
    render(<MemoryRouter><TrackerLibraryPage /></MemoryRouter>)

    expect(await screen.findByText('Checking your cloud progress')).toBeInTheDocument()
    expect(screen.queryByText('A blank page is a good start')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Account and sync status' })).toHaveAttribute('href', '/auth')
  })
})
