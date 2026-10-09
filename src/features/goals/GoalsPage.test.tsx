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
    const tomorrow = shiftCalendarDate(today, 1)
    fireEvent.change(screen.getByRole('spinbutton', { name: `Allocation for ${tomorrow}` }), { target: { value: '0' } })
    expect(await screen.findByText(/remains unallocated\./)).toBeInTheDocument()

    await waitFor(async () => {
      await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ goalPlanning: tracker.goalPlanning })
      await expect(db.trackerEntries.get(savedEntry.id)).resolves.toMatchObject({ values: { pages: 2 } })
    })
  })

  it('refreshes actual progress and the cumulative suggestion after a guest check-in is saved', async () => {
    const today = localCalendarDate(new Date(), 'UTC')
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 4, id: 'goal-live-progress', name: 'Practice questions', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: shiftCalendarDate(today, 2),
      metrics: [{ id: 'questions', name: 'Questions', valueType: 'quantity', unit: 'problems', precision: { decimalPlaces: 0, increment: 1 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { questions: 'incremental' }, dailyTargets: {}, cumulativeTargets: { questions: 9 }, planningTimeZone: 'UTC', allocations: { questions: { [shiftCalendarDate(today, 1)]: 4, [shiftCalendarDate(today, 2)]: 5 } } },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    expect(await screen.findByRole('region', { name: 'Questions allocation preview' })).toBeInTheDocument()
    expect(screen.getAllByText('9 problems').length).toBeGreaterThanOrEqual(1)

    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome: 'recorded', values: { questions: 3 }, note: '' })

    await waitFor(() => expect(screen.getAllByText('6 problems').length).toBeGreaterThanOrEqual(1))
    expect(screen.getByText(/automatic suggestions below have been recalculated/)).toBeInTheDocument()
    expect(screen.getByLabelText(`Suggested allocation for ${shiftCalendarDate(today, 1)}`)).toHaveTextContent('3 problems')
    expect(screen.getByLabelText(`Suggested allocation for ${shiftCalendarDate(today, 2)}`)).toHaveTextContent('3 problems')
  })

  it('recalculates displayed future suggestions after progress is created, edited, and deleted without replacing saved allocations', async () => {
    const today = localCalendarDate(new Date(), 'UTC')
    const tomorrow = shiftCalendarDate(today, 1)
    const nextDay = shiftCalendarDate(today, 2)
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 4, id: 'goal-adaptive-progress', name: 'Practice problems', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: nextDay,
      metrics: [{ id: 'problems', name: 'Problems', valueType: 'quantity', unit: 'problems', precision: { decimalPlaces: 0, increment: 1 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { problems: 'incremental' }, dailyTargets: {}, cumulativeTargets: { problems: 10 }, planningTimeZone: 'UTC', allocations: { problems: { [today]: 4, [tomorrow]: 3, [nextDay]: 3 } } },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    expect(await screen.findByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('3 problems')
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('3 problems')

    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome: 'recorded', values: { problems: 6 }, note: '' })
    await waitFor(() => expect(screen.getByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('2 problems'))
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('2 problems')
    expect(screen.getByRole('spinbutton', { name: `Saved allocation for ${tomorrow}` })).toHaveValue(3)

    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome: 'recorded', values: { problems: 2 }, note: 'edited' })
    await waitFor(() => expect(screen.getByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('4 problems'))
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('4 problems')
    expect(await db.trackers.get(tracker.id)).toMatchObject({ goalPlanning: tracker.goalPlanning })

    cleanup()
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('4 problems'))
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('4 problems')

    await localRepository.deleteTrackerEntry(tracker.id, today)
    await waitFor(() => expect(screen.getByLabelText(`Suggested allocation for ${today}`)).toHaveTextContent('4 problems'))
    expect(screen.getByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('3 problems')
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('3 problems')
    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ goalPlanning: tracker.goalPlanning })
    await expect(db.trackerEntries.where('[trackerId+date]').equals([tracker.id, today]).first()).resolves.toMatchObject({ values: { problems: 2 }, note: 'edited', deletedAt: expect.any(String) })
  })
})
