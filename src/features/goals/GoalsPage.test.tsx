import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { GoalsPage } from './GoalsPage'

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({
  status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false,
}) }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete() })

describe('Goals page allocation preview', () => {
  it('exposes an unsaved preview without changing the stored plan or check-ins', async () => {
    // The fixture uses the UTC planning zone, so its entry date and the goal
    // page's planning "today" must be derived in that same zone.
    const today = localCalendarDate(new Date(), 'UTC')
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 4, id: 'goal-preview-integration', name: 'Finish a draft', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: shiftCalendarDate(today, 2),
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 2, increment: 0.01 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: {}, cumulativeTargets: { pages: 10 }, planningTimeZone: 'UTC', allocations: { pages: {} } },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome: 'recorded', values: { pages: 2 }, note: 'Actual work' })
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)

    expect(await screen.findByRole('region', { name: 'Pages allocation preview' })).toBeInTheDocument()
    expect(screen.getAllByText('8 pages').length).toBeGreaterThanOrEqual(1)
    fireEvent.change(screen.getByRole('spinbutton', { name: `Allocation for ${today}` }), { target: { value: '0' } })
    expect(await screen.findByText('2.67 pages remains unallocated.')).toBeInTheDocument()

    await waitFor(async () => {
      await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ goalPlanning: tracker.goalPlanning })
      await expect(db.trackerEntries.get(savedEntry.id)).resolves.toMatchObject({ values: { pages: 2 } })
    })
  })
})
