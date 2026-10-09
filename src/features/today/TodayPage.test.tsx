import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { TodayPage } from './TodayPage'

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete() })
const today = () => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}` as `${number}-${number}-${number}`

const tracker = (schedule: StoredTrackerDefinition['schedule'] = { kind: 'every-day' }): StoredTrackerDefinition => ({
  schemaVersion: 1, id: 'today-tracker', name: 'Daily reading', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule,
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', thresholds: { direction: 'increase', target: 5, streakQualification: 'target' } }],
  qualificationRule: { kind: 'threshold', metricId: 'pages', level: 'target' },
  customFields: [{ id: 'mood', name: 'Mood', type: 'single-select', required: true, position: 0, options: ['Focused', 'Tired'] }],
  milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
})

describe('Today check-ins', () => {
  it('validates required fields, saves locally, evaluates the rule, and edits the same daily entry', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)

    expect(await screen.findByRole('heading', { name: 'Daily reading' })).toBeInTheDocument()
    await user.tab()
    expect(screen.getByLabelText('Pages')).toHaveFocus()
    await user.type(screen.getByLabelText('Pages'), '5')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Please complete all required fields.')
    await user.selectOptions(screen.getByLabelText(/Mood/), 'Focused')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))

    expect(await screen.findByText('Your configured success rule is met.')).toBeInTheDocument()
    const savedDate = today()
    const saved = await localRepository.getTrackerEntry('today-tracker', savedDate)
    expect(saved).toMatchObject({ outcome: 'recorded', values: { pages: 5, 'field:mood': 'Focused' } })

    await user.clear(screen.getByLabelText('Pages'))
    await user.type(screen.getByLabelText('Pages'), '2')
    await user.click(screen.getByRole('button', { name: 'Update check-in' }))
    await waitFor(async () => expect(await localRepository.getTrackerEntry('today-tracker', savedDate)).toMatchObject({ id: saved?.id, values: { pages: 2 } }))
    expect(await screen.findByText('Saved. The configured success rule is not met yet.')).toBeInTheDocument()
  })

  it('filters trackers that are not scheduled today and records a skip for scheduled trackers', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker({ kind: 'none' }))
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByText('Nothing scheduled today')).toBeInTheDocument()

    await db.trackers.put(tracker())
    cleanup()
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Skip today' }))
    await waitFor(() => expect(screen.getByText('Skipped')).toBeInTheDocument())
  })

  it('shows a retry state rather than treating a failed local read as an empty day', async () => {
    const user = userEvent.setup()
    vi.spyOn(localRepository, 'listTrackers').mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    expect(screen.getByText('Your check-ins are still here')).toBeInTheDocument()
    expect(screen.queryByText('Nothing scheduled today')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Nothing scheduled today')).toBeInTheDocument()
  })
})
