import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { DashboardPage } from './DashboardPage'

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete() })

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
    const calendar = screen.getByRole('table', { name: 'Check-in activity this month' })
    expect(within(calendar).getAllByRole('row').length).toBeGreaterThanOrEqual(5)
    expect(within(calendar).getAllByRole('columnheader')).toHaveLength(7)
    const yesterdayCell = screen.getByRole('cell', { name: new RegExp(`${Number(yesterday.slice(8, 10))}.*1 check-ins, 1 successes`) })
    expect(yesterdayCell).toBeInTheDocument()
    expect(screen.getByText('personal best')).toBeInTheDocument()
  })

  it('marks a holiday blue while retaining the saved activity count for that date', async () => {
    const definition = tracker()
    const today = localCalendarDate()
    await localRepository.saveTracker(definition)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: today, outcome: 'recorded', values: { pages: 5 }, note: 'Still available in history' })
    await localRepository.saveAccountHolidays([today], 'personal')

    render(<MemoryRouter><DashboardPage /></MemoryRouter>)

    const cell = await screen.findByRole('cell', { name: new RegExp(`${Number(today.slice(8, 10))}, holiday: 1 check-ins`) })
    expect(within(cell).getByLabelText('Holiday')).toBeInTheDocument()
    expect(within(cell).queryByLabelText('Completed')).not.toBeInTheDocument()
    expect(cell).toHaveAccessibleName(/1 check-ins/)
  })

  it('does not invent activity when no trackers exist', async () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByText('Your overview starts with a tracker')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Check-in activity this month' })).not.toBeInTheDocument()
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
