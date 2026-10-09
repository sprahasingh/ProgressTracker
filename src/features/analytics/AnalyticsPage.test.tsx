import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { AnalyticsPage } from './AnalyticsPage'

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({
  status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false,
}) }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete() })

const definition: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'analytics-run', name: 'Morning run', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: shiftCalendarDate(localCalendarDate(), -3),
  metrics: [
    { id: 'distance', name: 'Distance', valueType: 'quantity', unit: 'km', thresholds: { direction: 'increase', target: 3, streakQualification: 'target' } },
    { id: 'minutes', name: 'Minutes', valueType: 'duration', unit: 'min', thresholds: { direction: 'increase', target: 20, streakQualification: 'target' } },
  ], qualificationRule: { kind: 'all', operands: [
    { kind: 'threshold', metricId: 'distance', level: 'target' }, { kind: 'threshold', metricId: 'minutes', level: 'target' },
  ] }, customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

describe('Analytics page', () => {
  it('shows workspace-local consistency and distinct per-metric values', async () => {
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    await localRepository.saveTracker(definition)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: yesterday, outcome: 'recorded', values: { distance: 5, minutes: 25 }, note: '' })
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: localCalendarDate(), outcome: 'recorded', values: { distance: 2, minutes: 40 }, note: '' })

    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    expect(await screen.findByRole('heading', { name: /Analytics/ })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Morning run' })).toBeInTheDocument()
    expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Distance analysis' })).toHaveTextContent('average 3.5 km')
    expect(screen.getByRole('region', { name: 'Minutes analysis' })).toHaveTextContent('average 32.5 min')
    expect(screen.getAllByText(/does not add values across dates/)).toHaveLength(2)
  })
})
