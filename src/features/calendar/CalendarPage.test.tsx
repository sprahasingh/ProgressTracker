import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { CalendarPage } from './CalendarPage'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calendarDateLabel } from '../shared/localDates'

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

afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.clearAllMocks() })

describe('Calendar page', () => {
  it('shows an accessible status legend and opens selected date details', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Morning walk', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/Completed · Done/)).toBeInTheDocument()
    const manageHolidays = screen.getByRole('link', { name: 'Manage holidays' })
    expect(manageHolidays).toHaveClass('button-primary')
    expect(manageHolidays).toHaveAttribute('href', '/holidays')
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('href', `/calendar?date=${today}`)
    expect(screen.getByLabelText('Month')).toHaveAttribute('type', 'month')
    const legend = screen.getByLabelText('Activity status legend')
    expect(Array.from(legend.querySelectorAll(':scope > span')).map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Pending', 'Completed', 'Partially completed', 'Missed', 'Holiday', 'Rest day',
    ])
    expect(legend.querySelector('.calendar-dot.holiday [data-icon="status-holiday"]')).toBeInTheDocument()
    expect(legend.querySelector('.calendar-dot.unscheduled [data-icon="status-unscheduled"]')).toBeInTheDocument()
    expect(Array.from(legend.querySelectorAll('.calendar-dot svg')).map((icon) => icon.getAttribute('data-icon'))).toEqual([
      'status-pending', 'status-completed', 'status-partial', 'status-missed', 'status-holiday', 'status-unscheduled',
    ])
    expect(legend.querySelector('.calendar-dot.partial path[fill="currentColor"]')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Mark holiday' })).toHaveAttribute('href', `/holidays?date=${today}`)
    expect(container.querySelector('.calendar-cell-status.completed')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'Daily activity calendar' }).querySelector('thead')!).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(screen.getByRole('button', { name: new RegExp(calendarDateLabel(today, { weekday: 'long', month: 'long', day: 'numeric' })) })).toHaveClass('completed')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: new RegExp(previousDateLabel) }))
    expect(await screen.findAllByText('Missed')).toHaveLength(2)
  })

  it('filters date status counts and tracker details to the selected tracker', async () => {
    const user = userEvent.setup()
    const second = { ...tracker, id: 'calendar-second', name: 'Evening walk' }
    const secondEntry = { ...entry, id: 'calendar-entry-second', trackerId: second.id }
    mocks.listTrackers.mockResolvedValue([tracker, second])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry, secondEntry])
    mocks.listAccountHolidays.mockResolvedValue([])
    render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)
    expect(await screen.findByText(/2 completed · 0 partial/)).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tracker' }), second.id)
    expect(await screen.findAllByText('Evening walk', { selector: 'strong' })).toHaveLength(2)
    expect(screen.queryByText('Morning walk', { selector: 'strong' })).not.toBeInTheDocument()
    expect(screen.getByText(/1 completed · 0 partial/)).toBeInTheDocument()
  })

  it('colors a holiday date tile and keeps its recorded check-in visible', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([{ id: 'holiday-today', date: today, reason: 'personal', createdAt: '', updatedAt: '', deletedAt: null }])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Morning walk', { selector: 'strong' })).toBeInTheDocument()
    expect(container.querySelector('.calendar-cell-status.holiday')).toBeInTheDocument()
    expect(screen.getByText(/Holiday · scheduled expectations paused · 1 saved check-in retained/)).toBeInTheDocument()
    expect(screen.getByText(/Holiday · Progress recorded: Done/)).toBeInTheDocument()
  })

  it('marks an unrecorded scheduled date as pending, rather than rest or missed', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Pending')).toBeInTheDocument()
    expect(container.querySelector('.calendar-cell-status.pending')).toBeInTheDocument()
  })

  it('keeps a mixed completed and pending date pending instead of calling it partially completed', async () => {
    const secondTracker = { ...tracker, id: 'calendar-habit-two', name: 'Read a book' }
    mocks.listTrackers.mockResolvedValue([tracker, secondTracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    await screen.findByText('Morning walk', { selector: 'strong' })
    const cell = container.querySelector('.calendar-day-today .calendar-cell-status')
    expect(cell).toHaveClass('pending')
    expect(cell).not.toHaveClass('partial')
  })
})
