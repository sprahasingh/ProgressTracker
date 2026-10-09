import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { DashboardPage } from './DashboardPage'

afterEach(async () => { cleanup(); await db.delete() })

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
    expect(screen.getByRole('grid', { name: 'Check-in activity this month' })).toBeInTheDocument()
    const yesterdayCell = screen.getByRole('gridcell', { name: new RegExp(`${Number(yesterday.slice(8, 10))}: 1 check-ins, 1 successes`) })
    expect(yesterdayCell).toBeInTheDocument()
    expect(screen.getByText('personal best')).toBeInTheDocument()
  })

  it('does not invent activity when no trackers exist', async () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByText('Your overview starts with a tracker')).toBeInTheDocument()
    expect(screen.queryByRole('grid', { name: 'Check-in activity this month' })).not.toBeInTheDocument()
  })
})
