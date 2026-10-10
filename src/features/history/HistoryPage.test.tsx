import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { ToastProvider } from '../../components/ui/ToastProvider'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { HistoryPage } from './HistoryPage'

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false }) }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete() })

const definition: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'history-run', name: 'Morning run', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' },
  metrics: [{ id: 'distance', name: 'Distance', valueType: 'quantity', unit: 'km', thresholds: { direction: 'increase', target: 3, streakQualification: 'target' } }],
  qualificationRule: { kind: 'threshold', metricId: 'distance', level: 'target' }, customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

describe('local check-in history', () => {
  it('confirms a historical check-in edit after the local write succeeds', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(definition)
    const date = localCalendarDate()
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date, outcome: 'recorded', values: { distance: 4 }, note: 'Park loop' })
    render(<ToastProvider><MemoryRouter><HistoryPage /></MemoryRouter></ToastProvider>)
    await user.click(await screen.findByRole('button', { name: 'Edit check-in' }))
    const input = screen.getByRole('spinbutton', { name: 'Distance' })
    await user.clear(input)
    await user.type(input, '6')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('status', { name: 'Check-in updated' })).toHaveTextContent('Your progress has been saved on this device.')
    await expect(localRepository.getTrackerEntry(definition.id, date)).resolves.toMatchObject({ values: { distance: 6 } })
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })

  it('lists saved values, notes, outcomes, and filters by tracker', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(definition)
    const yoga: StoredTrackerDefinition = { ...definition, id: 'history-yoga', name: 'Yoga', metrics: [{ ...definition.metrics[0]!, id: 'minutes', name: 'Minutes', unit: 'min' }], qualificationRule: { kind: 'threshold', metricId: 'minutes', level: 'target' } }
    await localRepository.saveTracker(yoga)
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: yesterday, outcome: 'recorded', values: { distance: 4 }, note: 'Park loop' })
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: localCalendarDate(), outcome: 'skipped', values: {}, note: 'Rested today' })
    await localRepository.saveTrackerEntry({ trackerId: yoga.id, date: localCalendarDate(), outcome: 'recorded', values: { minutes: 20 }, note: 'Easy flow' })
    render(<MemoryRouter><HistoryPage /></MemoryRouter>)

    expect(await screen.findAllByRole('heading', { name: 'Morning run' })).toHaveLength(2)
    expect(screen.getByText('4 km')).toBeInTheDocument()
    expect(screen.getByText('Park loop')).toBeInTheDocument()
    expect(screen.getAllByText('Completed · success rule met')).toHaveLength(2)
    expect(screen.getByText('Missed · marked intentionally')).toBeInTheDocument()
    expect(screen.getByText('Rested today')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Tracker'), yoga.id)
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Morning run' })).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Yoga' })).toBeInTheDocument()
  })

  it('shows a useful empty message without synthetic history', async () => {
    render(<MemoryRouter><HistoryPage /></MemoryRouter>)
    expect(await screen.findByText('No check-ins in this range')).toBeInTheDocument()
    expect(screen.queryByText(/Success rule met/)).not.toBeInTheDocument()
  })

  it('offers retry when the local history read fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(localRepository, 'listTrackerEntriesBetween').mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    render(<MemoryRouter><HistoryPage /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    expect(screen.getByText('Your history is still here')).toBeInTheDocument()
    expect(screen.queryByText('No check-ins in this range')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No check-ins in this range')).toBeInTheDocument()
  })
})
