import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { CalendarPage } from './CalendarPage'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'

const mocks = vi.hoisted(() => ({ listTrackers: vi.fn(), listTrackerEntriesBetween: vi.fn(), listAccountHolidays: vi.fn() }))
const auth = vi.hoisted(() => ({ value: { status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false } }))
vi.mock('../../db/localRepository', () => ({ localRepository: mocks }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => auth.value }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))

const today = new Date().toISOString().slice(0, 10)
const previousDate = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)
const previousDateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${previousDate}T00:00:00.000Z`))
const tracker = {
  schemaVersion: 1, id: 'calendar-habit', name: 'Morning walk', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
  qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true }, customFields: [], milestones: [],
  createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
} as unknown as StoredTrackerDefinition
const entry = {
  id: 'calendar-entry', trackerId: tracker.id, date: today, outcome: 'recorded', values: { done: true }, note: '',
  createdAt: `${today}T09:00:00.000Z`, updatedAt: `${today}T09:00:00.000Z`, deletedAt: null,
} as StoredTrackerEntry

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Calendar page', () => {
  it('shows an accessible status legend and opens selected date details', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Morning walk')).toBeInTheDocument()
    expect(screen.getByText(/Completed · Done/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Mark holiday' })).toHaveAttribute('href', `/holidays?date=${today}`)
    expect(container.querySelector('.calendar-cell-status.completed')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: new RegExp(previousDateLabel) }))
    expect(await screen.findAllByText('Missed')).toHaveLength(2)
  })

  it('colors a holiday date tile and keeps its recorded check-in visible', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([{ id: 'holiday-today', date: today, reason: 'personal', createdAt: '', updatedAt: '', deletedAt: null }])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Morning walk')).toBeInTheDocument()
    expect(container.querySelector('.calendar-cell-status.holiday')).toBeInTheDocument()
    expect(screen.getByText(/Holiday · scheduled expectations paused · 1 saved check-in retained/)).toBeInTheDocument()
    expect(screen.getByText(/Holiday · Done/)).toBeInTheDocument()
  })

  it('marks an unrecorded scheduled date as pending, rather than rest or missed', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Pending')).toBeInTheDocument()
    expect(container.querySelector('.calendar-cell-status.pending')).toBeInTheDocument()
  })
})
