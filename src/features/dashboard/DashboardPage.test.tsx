import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { DashboardPage } from './DashboardPage'

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false }) }))

afterEach(async () => { cleanup(); window.sessionStorage.clear(); vi.restoreAllMocks(); await db.delete() })

function tracker(): StoredTrackerDefinition {
  return {
    schemaVersion: 1, id: 'dashboard-reading', name: 'Read a book', description: '', kind: 'habit', status: 'active', categoryId: null,
    tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: shiftCalendarDate(localCalendarDate(), -1),
    metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', thresholds: { direction: 'increase', target: 5, streakQualification: 'target' } }],
    qualificationRule: { kind: 'threshold', metricId: 'pages', level: 'target' }, customFields: [], milestones: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
  }
}

describe('local progress dashboard', () => {
  it('summarizes only real scheduled entries and derives streak and reward totals', async () => {
    const definition = tracker()
    await localRepository.saveTracker(definition)
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: yesterday, outcome: 'recorded', values: { pages: 5 }, note: 'A real note' })
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: localCalendarDate(), outcome: 'recorded', values: { pages: 2 }, note: '' })

    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Read a book' })).toBeInTheDocument()
    expect(screen.getByText('Reward points')).toBeInTheDocument()
    expect(screen.getByText('Weekly consistency')).toBeInTheDocument()
    expect(screen.getByText('personal best')).toBeInTheDocument()
  })

  it('does not invent activity when no trackers exist', async () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByText('Your overview starts with a tracker')).toBeInTheDocument()
  })

  it('filters tracker cards and heatmap by stable tracker ID and exposes tap details', async () => {
    const user = userEvent.setup()
    const first = tracker()
    const second = { ...tracker(), id: 'dashboard-water', name: 'Drink water', strictMode: true }
    await localRepository.saveTracker(first)
    await localRepository.saveTracker(second)
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    await localRepository.saveTrackerEntry({ trackerId: first.id, date: yesterday, outcome: 'recorded', values: { pages: 5 }, note: '' })
    await localRepository.saveTrackerEntry({ trackerId: second.id, date: yesterday, outcome: 'recorded', values: { pages: 5 }, note: '' })
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Activity Heatmap' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Read a book' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Drink water' })).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show activity for' }), first.id)
    expect(screen.getByRole('heading', { name: 'Read a book' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Drink water' })).not.toBeInTheDocument()
    expect(screen.getByText('Read a book · last 12 weeks')).toBeInTheDocument()
    const info = screen.getByRole('button', { name: 'More about Activity Heatmap' })
    await user.click(info)
    expect(screen.getByRole('dialog', { name: 'Activity Heatmap' })).toHaveTextContent('qualified opportunities divided by eligible opportunities')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Activity Heatmap' })).not.toBeInTheDocument()
  })

  it('refreshes displayed weekly statistics when a check-in changes while the dashboard is mounted', async () => {
    const definition = tracker()
    await localRepository.saveTracker(definition)
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    await screen.findByText('Successes · 7 days')
    const successValue = () => screen.getByText('Successes · 7 days').closest('.dashboard-stat')?.querySelector('strong')
    await waitFor(() => expect(successValue()).toHaveTextContent('0'))

    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: localCalendarDate(), outcome: 'recorded', values: { pages: 5 }, note: '' })
    await waitFor(() => expect(successValue()).toHaveTextContent('1'))

    await localRepository.deleteTrackerEntry(definition.id, localCalendarDate())
    await waitFor(() => expect(successValue()).toHaveTextContent('0'))
  })

  it('shows a retry state instead of an empty account when local reads fail', async () => {
    const user = userEvent.setup()
    vi.spyOn(localRepository, 'listTrackers').mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    expect(screen.getByText('Your progress is still here')).toBeInTheDocument()
    expect(screen.queryByText('Your overview starts with a tracker')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Your overview starts with a tracker')).toBeInTheDocument()
  })
})
