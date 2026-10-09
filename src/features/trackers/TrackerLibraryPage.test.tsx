import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TrackerLibraryPage } from './TrackerLibraryPage'
import type { StoredTrackerDefinition } from '../../db/models'

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

  it('shows a goal’s actual planned total separately from its per-check-in threshold and offers today’s action', async () => {
    const id = 'dsa-goal'
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 2, id, name: 'Solve problems', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' },
      deadline: '2026-10-30', metrics: [{ id: 'problems', name: 'Problems', valueType: 'quantity', unit: 'items', thresholds: { direction: 'increase', target: 1, streakQualification: 'any-recorded-value' } }],
      qualificationRule: { kind: 'threshold', metricId: 'problems', level: 'target' }, customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { problems: 'incremental' }, dailyTargets: {}, cumulativeTargets: { problems: 100 } },
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    libraryMocks.listTrackers.mockResolvedValue([tracker])
    render(<MemoryRouter><TrackerLibraryPage /></MemoryRouter>)

    const targets = await screen.findByRole('list', { name: 'Solve problems targets' })
    expect(within(targets).getByText('100 items')).toBeInTheDocument()
    expect(within(targets).getByText('1 items')).toBeInTheDocument()
    expect(within(targets).getByText('total by deadline')).toBeInTheDocument()
    expect(within(targets).getByText('per check-in')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Check in today' })).toHaveAttribute('href', '/')
  })
})
