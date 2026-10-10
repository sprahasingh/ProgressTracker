import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TrackerLibraryPage } from './TrackerLibraryPage'
import { ToastProvider } from '../../components/ui/ToastProvider'
import type { StoredTrackerDefinition } from '../../db/models'

const libraryMocks = vi.hoisted(() => ({ listTrackers: vi.fn(), listTrackerEntriesBetween: vi.fn().mockResolvedValue([]), archiveTracker: vi.fn(), unarchiveTracker: vi.fn(), deleteTracker: vi.fn() }))
vi.mock('../../db/localRepository', () => ({ localRepository: libraryMocks }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'signed-in', user: { id: 'account-a' }, workspaceStatus: 'ready', workspaceUserId: 'account-a', syncStatus: 'syncing', isOnline: true }) }))

describe('TrackerLibraryPage initial cloud state', () => {
  afterEach(() => cleanup())

  it('does not describe an empty local list as an empty account during initial cloud sync', async () => {
    libraryMocks.listTrackers.mockResolvedValue([])
    render(<ToastProvider><MemoryRouter><TrackerLibraryPage /></MemoryRouter></ToastProvider>)

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

  it('keeps archive and delete in the overflow menu and preserves delete confirmation', async () => {
    const tracker = {
      schemaVersion: 1 as const, id: 'menu-habit', name: 'Read daily', description: '', kind: 'habit' as const, status: 'active' as const, categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const }, metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true }, customFields: [], milestones: [],
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    } as StoredTrackerDefinition
    libraryMocks.listTrackers.mockResolvedValue([tracker])
    libraryMocks.archiveTracker.mockResolvedValue(tracker)
    libraryMocks.deleteTracker.mockResolvedValue(tracker)
    vi.stubGlobal('confirm', vi.fn(() => true))
    const user = userEvent.setup()
    render(<ToastProvider><MemoryRouter><TrackerLibraryPage /></MemoryRouter></ToastProvider>)

    expect(await screen.findByRole('link', { name: 'Check in today' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit setup' })).toHaveAttribute('href', '/trackers/menu-habit/edit')
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions for Read daily' }))
    await user.click(screen.getByRole('menuitem', { name: 'Archive tracker' }))
    expect(libraryMocks.archiveTracker).toHaveBeenCalledWith('menu-habit')
    expect(await screen.findByRole('status', { name: 'Tracker archived' })).toHaveTextContent('Its history and plan are still available.')

    await user.click(screen.getByRole('button', { name: 'More actions for Read daily' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete tracker' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Move “Read daily” to the Bin?'))
    expect(libraryMocks.deleteTracker).toHaveBeenCalledWith('menu-habit')
    vi.unstubAllGlobals()
  })

  it('offers Restore for archived trackers and closes the menu with Escape', async () => {
    const archived = {
      schemaVersion: 1 as const, id: 'archived-habit', name: 'Archived walk', description: '', kind: 'habit' as const, status: 'archived' as const, categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const }, metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true }, customFields: [], milestones: [],
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: '2026-10-02T00:00:00.000Z', deletedAt: null,
    } as StoredTrackerDefinition
    libraryMocks.listTrackers.mockResolvedValue([archived])
    libraryMocks.unarchiveTracker.mockResolvedValue({ ...archived, status: 'active', archivedAt: null })
    const user = userEvent.setup()
    render(<MemoryRouter><TrackerLibraryPage /></MemoryRouter>)

    await screen.findByText('Archived walk')
    await user.click(screen.getByRole('button', { name: 'More actions for Archived walk' }))
    expect(screen.getByRole('menuitem', { name: 'Restore tracker' })).toBeInTheDocument()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Delete tracker' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More actions for Archived walk' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'More actions for Archived walk' }))
    await user.click(screen.getByRole('menuitem', { name: 'Restore tracker' }))
    expect(libraryMocks.unarchiveTracker).toHaveBeenCalledWith('archived-habit')
  })

  it('labels the tracker action as editing when a check-in already exists today', async () => {
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 1, id: 'already-checked', name: 'Daily practice', description: '', kind: 'habit', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
      qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true }, customFields: [], milestones: [],
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    libraryMocks.listTrackers.mockResolvedValue([tracker])
    libraryMocks.listTrackerEntriesBetween.mockResolvedValue([{ trackerId: tracker.id, deletedAt: null }])
    render(<MemoryRouter><TrackerLibraryPage /></MemoryRouter>)

    expect(await screen.findByRole('link', { name: "Edit today's check-in" })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('link', { name: 'Check in today' })).not.toBeInTheDocument()
  })
})
