import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
const upcomingDate = new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)
const previousDateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${previousDate}T00:00:00.000Z`))
const tracker = {
  schemaVersion: 1, id: 'calendar-habit', name: 'Morning walk', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: previousDate, metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
  qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true }, customFields: [], milestones: [],
  createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
} as unknown as StoredTrackerDefinition
const entry = {
  id: 'calendar-entry', trackerId: tracker.id, date: today, outcome: 'recorded', values: { done: true }, note: '',
  createdAt: `${today}T09:00:00.000Z`, updatedAt: `${today}T09:00:00.000Z`, deletedAt: null,
} as StoredTrackerEntry

afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.clearAllMocks() })

describe('Calendar page', () => {
  it('keeps the status guide collapsed until requested and opens selected date details', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Morning walk', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/Completed · Done/)).toBeInTheDocument()
    const manageHolidays = screen.getByRole('link', { name: 'Manage holidays' })
    expect(manageHolidays).toHaveClass('button-secondary')
    expect(manageHolidays).toHaveAttribute('href', '/holidays')
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('href', `/calendar?date=${today}`)
    expect(screen.getByLabelText('Month')).toHaveAttribute('type', 'month')
    const guideButton = screen.getByRole('button', { name: 'Show all statuses' })
    expect(screen.getByRole('button', { name: 'Explain calendar statuses' })).toHaveAttribute('aria-haspopup', 'dialog')
    expect(guideButton).toHaveAttribute('aria-expanded', 'false')
    expect(guideButton).toHaveAttribute('aria-controls', 'calendar-status-guide-content')
    expect(screen.getByText('Status guide').parentElement).toContainElement(screen.getByRole('button', { name: 'Explain calendar statuses' }))
    expect(screen.getAllByRole('button', { name: 'Explain calendar statuses' })).toHaveLength(1)
    expect(screen.queryByLabelText('Activity status legend')).not.toBeVisible()
    const user = userEvent.setup()
    guideButton.focus()
    await user.keyboard('{Enter}')
    expect(guideButton).toHaveFocus()
    expect(guideButton).toHaveAttribute('aria-expanded', 'true')
    const legend = screen.getByLabelText('Activity status legend')
    expect(Array.from(legend.querySelectorAll(':scope > span')).map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Completed', 'Partial', 'No progress', 'Missed', 'Skipped', 'Pending', 'Upcoming', 'Holiday', 'Rest day', 'Outside period', 'Historical entry', 'Tracker inactive', 'No active trackers',
    ])
    expect(legend.querySelector('.calendar-dot.holiday [data-icon="status-holiday"]')).toBeInTheDocument()
    expect(legend.querySelector('.calendar-dot.rest-day [data-icon="status-unscheduled"]')).toBeInTheDocument()
    expect(Array.from(legend.querySelectorAll('.calendar-dot svg')).map((icon) => icon.getAttribute('data-icon'))).toEqual([
      'status-completed', 'status-partial', 'status-no-progress', 'status-missed', 'status-skipped', 'status-pending', 'status-upcoming', 'status-holiday', 'status-unscheduled', 'status-outside-period', 'status-historical', 'status-inactive', 'status-no-trackers',
    ])
    expect(legend.querySelector('.calendar-dot.partial path[fill="currentColor"]')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Explain calendar statuses' }))
    const statusInfo = await screen.findByRole('dialog', { name: 'Calendar status guide' })
    expect(statusInfo).toHaveAttribute('role', 'dialog')
    expect(within(statusInfo).getByRole('heading', { name: 'Saved activity' })).toBeInTheDocument()
    expect(within(statusInfo).getByRole('heading', { name: 'Scheduled dates' })).toBeInTheDocument()
    expect(within(statusInfo).getByRole('heading', { name: 'Tracker availability' })).toBeInTheDocument()
    expect(statusInfo).toHaveTextContent('Standard Mode treats holidays as neutral; Strict Mode still requires qualifying progress.')
    expect(statusInfo).toHaveTextContent('A saved entry meets the tracker’s completion rule; streak qualification may differ.')
    expect(statusInfo).toHaveTextContent('All Trackers shows one aggregate date status across active trackers.')
    await user.click(screen.getByRole('button', { name: 'Close explanation' }))
    await user.click(screen.getByRole('button', { name: 'Hide statuses' }))
    expect(guideButton).toHaveAttribute('aria-expanded', 'false')
    expect(legend).not.toBeVisible()
    expect(screen.getByRole('link', { name: 'Mark holiday' })).toHaveAttribute('href', `/holidays?date=${today}`)
    expect(screen.getByRole('link', { name: 'Edit check-in' })).toHaveAttribute('href', '/')
    expect(container.querySelector('.calendar-cell-status.completed')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'Daily activity calendar' }).querySelector('thead')!).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(screen.getByRole('button', { name: new RegExp(calendarDateLabel(today, { weekday: 'long', month: 'long', day: 'numeric' })) })).toHaveClass('completed')

    const previousDayButton = screen.getByRole('button', { name: new RegExp(previousDateLabel) })
    previousDayButton.focus()
    await user.keyboard('{Enter}')
    expect(previousDayButton).toHaveFocus()
    expect(previousDayButton).toHaveAttribute('aria-pressed', 'true')
    // A backdated start remains eligible even when it predates creation.
    expect(container.querySelector('.calendar-activity-list')?.textContent).toContain('Add check-in')
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

  it('changes the displayed month and keeps the selected day within that month', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)
    const current = new Date(`${today}T00:00:00.000Z`)
    const targetMonthDate = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1))
    const targetMonth = targetMonthDate.toISOString().slice(0, 7)
    const lastDay = new Date(Date.UTC(targetMonthDate.getUTCFullYear(), targetMonthDate.getUTCMonth() + 1, 0)).getUTCDate()
    const selectedDay = Math.min(Number(today.slice(8, 10)), lastDay)
    const expectedDate = `${targetMonth}-${String(selectedDay).padStart(2, '0')}`
    await screen.findByRole('table', { name: 'Daily activity calendar' })

    fireEvent.change(screen.getByLabelText('Month'), { target: { value: targetMonth } })

    expect(screen.getByLabelText('Month')).toHaveValue(targetMonth)
    expect(await screen.findByRole('heading', { name: new RegExp(calendarDateLabel(expectedDate, { weekday: 'long', month: 'long', day: 'numeric' })) })).toBeInTheDocument()
    expect(container.querySelector(`.calendar-day-selected .calendar-cell-status`)).toHaveAttribute('aria-pressed', 'true')
  })

  it('colors a holiday date tile and keeps its recorded check-in visible', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([{ id: 'holiday-today', date: today, reason: 'personal', createdAt: '', updatedAt: '', deletedAt: null }])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Morning walk', { selector: 'strong' })).toBeInTheDocument()
    expect(container.querySelector('.calendar-cell-status.holiday')).toBeInTheDocument()
    expect(screen.getByText(/Holiday · Standard Mode expectations paused · 1 saved check-in retained/)).toBeInTheDocument()
    expect(screen.getByText(/Completed · Done/)).toBeInTheDocument()
  })

  it('marks an unrecorded scheduled date as pending, rather than rest or missed', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findAllByText('Pending')).toHaveLength(1)
    expect(container.querySelector('.calendar-cell-status.pending')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add check-in' })).toHaveAttribute('href', '/')
  })

  it('labels future opportunities Upcoming and dates outside the active period Outside period', async () => {
    const oldTracker = { ...tracker, createdAt: '2026-01-01T00:00:00.000Z', startDate: today }
    mocks.listTrackers.mockResolvedValue([oldTracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${upcomingDate}`]}><CalendarPage /></MemoryRouter>)
    expect(await screen.findByText(/Upcoming/)).toBeInTheDocument()
    expect(container.querySelector('.calendar-cell-status.upcoming')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: new RegExp(calendarDateLabel(previousDate, { weekday: 'long', month: 'long', day: 'numeric' })) }))
    expect(container.querySelector('.calendar-activity-list')?.textContent).toContain('Outside period')
  })

  it('shows Strict Mode misses on holidays and labels an intentional skip separately', async () => {
    const oldTracker = { ...tracker, createdAt: '2026-01-01T00:00:00.000Z', startDate: '2026-01-01' }
    mocks.listTrackers.mockResolvedValue([{ ...oldTracker, strictMode: true, schedule: { kind: 'none' } }])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([{ id: 'past-holiday', date: previousDate, reason: 'personal', createdAt: '', updatedAt: '', deletedAt: null }])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${previousDate}`]}><CalendarPage /></MemoryRouter>)
    expect(await screen.findByText(/1 Strict Mode check-in is missed/)).toBeInTheDocument()
    expect(screen.getAllByText('Missed').length).toBeGreaterThan(0)
    expect(container.querySelector('.calendar-cell-status.holiday')).toBeInTheDocument()

    cleanup()
    const standardTracker = { ...oldTracker, strictMode: false }
    mocks.listTrackers.mockResolvedValue([standardTracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([{ ...entry, date: previousDate, outcome: 'skipped', values: {} }])
    mocks.listAccountHolidays.mockResolvedValue([])
    const skippedCalendar = render(<MemoryRouter initialEntries={[`/calendar?date=${previousDate}`]}><CalendarPage /></MemoryRouter>)
    expect(await screen.findByText(/Skipped · intentionally saved/)).toBeInTheDocument()
    expect(skippedCalendar.container.querySelector('.calendar-cell-status.skipped')).toBeInTheDocument()
  })

  it('does not count retained entries whose tracker is hidden in the Bin', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([
      entry,
      { ...entry, id: 'binned-entry', trackerId: 'binned-tracker' },
    ])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    await screen.findByText('Morning walk', { selector: 'strong' })
    const day = container.querySelector('.calendar-day-today .calendar-cell-status')
    expect(day).toHaveAttribute('aria-label', expect.not.stringContaining('2 active tracker check-ins'))
    expect(day).toHaveAttribute('aria-label', expect.stringContaining('1 active tracker check-in'))
  })

  it('uses active trackers for aggregate counts while preserving selected inactive history', async () => {
    const paused = { ...tracker, id: 'calendar-paused', name: 'Paused walk', status: 'paused' }
    const pausedEntry = { ...entry, id: 'paused-entry', trackerId: paused.id }
    mocks.listTrackers.mockResolvedValue([tracker, paused])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry, pausedEntry])
    mocks.listAccountHolidays.mockResolvedValue([])
    render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)
    expect(await screen.findByText(/1 completed · 0 partial/)).toBeInTheDocument()
    expect(screen.getByText(/1 active tracker check-in/)).toBeInTheDocument()
    expect(screen.getByText('Paused walk', { selector: 'strong' })).toBeInTheDocument()
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Tracker' }), paused.id)
    expect(await screen.findByText(/1 completed · 0 partial/)).toBeInTheDocument()
    expect(screen.getByText(/1 saved tracker check-in/)).toBeInTheDocument()
  })

  it('uses a neutral no-trackers tile when the workspace has no active trackers', async () => {
    mocks.listTrackers.mockResolvedValue([])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)
    await screen.findByText(/No active trackers/)
    expect(container.querySelector('.calendar-cell-status.no-trackers')).toBeInTheDocument()
  })

  it('keeps a mixed completed and pending date identifiable as an aggregate', async () => {
    const secondTracker = { ...tracker, id: 'calendar-habit-two', name: 'Read a book' }
    mocks.listTrackers.mockResolvedValue([tracker, secondTracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    await screen.findByText('Morning walk', { selector: 'strong' })
    const cell = container.querySelector('.calendar-day-today .calendar-cell-status')
    expect(cell).toHaveClass('pending')
    expect(cell).toHaveClass('mixed')
    expect(cell).toHaveAttribute('aria-label', expect.stringContaining('mixed statuses across active trackers'))
    expect(cell).not.toHaveClass('partial')
  })

  it('marks completed dates mixed when other active trackers are resting or outside their period', async () => {
    const restTracker = { ...tracker, id: 'calendar-rest', name: 'Resting tracker', schedule: { kind: 'none' } }
    const outsideTracker = { ...tracker, id: 'calendar-outside', name: 'Expired tracker', deadline: previousDate }
    mocks.listTrackers.mockResolvedValue([tracker, restTracker, outsideTracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    await screen.findByText('Morning walk', { selector: 'strong' })
    const cell = container.querySelector('.calendar-day-today .calendar-cell-status')
    expect(cell).toHaveClass('completed', 'mixed')
    expect(cell).toHaveAttribute('aria-label', expect.stringContaining('mixed statuses across active trackers'))
    expect(cell).toHaveAttribute('aria-label', expect.stringContaining('1 rest day, 0 historical entries, 1 tracker outside period'))
    expect(screen.getByText('Mixed statuses across active trackers; see each tracker below.')).toBeInTheDocument()
    expect(screen.getByText('Resting tracker', { selector: 'strong' }).parentElement).toHaveTextContent('Rest day')
    expect(screen.getByText('Expired tracker', { selector: 'strong' }).parentElement).toHaveTextContent('Outside period')
  })
})
