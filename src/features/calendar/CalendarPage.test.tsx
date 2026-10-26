import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { CalendarPage } from './CalendarPage'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calendarDateLabel } from '../shared/localDates'
import appStyles from '../../styles.css?raw'

const mocks = vi.hoisted(() => ({ listTrackers: vi.fn(), listTrackerEntriesBetween: vi.fn(), listAccountHolidays: vi.fn(), listTrackerHolidays: vi.fn().mockResolvedValue([]) }))
const auth = vi.hoisted(() => ({ value: { status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false } }))
vi.mock('../../db/localRepository', () => ({ localRepository: mocks }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => auth.value }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))

const today = new Date().toISOString().slice(0, 10)
const previousDate = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)
const lastSaturday = (() => {
  const date = new Date(`${today}T00:00:00.000Z`)
  const offset = (date.getUTCDay() + 1) % 7
  return new Date(date.getTime() - (offset || 7) * 86_400_000).toISOString().slice(0, 10)
})()
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

afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.clearAllMocks(); mocks.listTrackerHolidays.mockResolvedValue([]) })

describe('Calendar page', () => {
  it('uses the shared page-header hierarchy with visible schedule copy and the holidays action after it', async () => {
    mocks.listTrackers.mockResolvedValue([])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter><CalendarPage /></MemoryRouter>)
    const header = container.querySelector<HTMLElement>('.calendar-page > .page-header')!
    expect(within(header).getByText('YOUR SCHEDULE')).toBeInTheDocument()
    expect(within(header).getByRole('heading', { name: 'Calendar.' })).toBeInTheDocument()
    expect(within(header).getByText('Review your daily progress, check-ins, and holidays in one place.')).toBeInTheDocument()
    expect(within(header).getByRole('link', { name: 'Manage holidays' })).toHaveAttribute('href', '/holidays')
    expect(header.children[1]).toHaveClass('page-header-action')
    expect(appStyles).toContain('.calendar-page .page-header { display: block;')
    expect(appStyles).not.toMatch(/\.calendar-page \.page-header-copy > \.eyebrow, \.calendar-page \.page-description\s*\{\s*display:\s*none/)
  })

  it('shows Effective Challenge numbering on an unscheduled weekend without calling it missed', async () => {
    const challenge = {
      ...tracker, id: 'calendar-challenge', name: 'Weekend Challenge', kind: 'challenge', schemaVersion: 6,
      schedule: { kind: 'weekdays' }, startDate: new Date(Date.parse(`${lastSaturday}T00:00:00.000Z`) - 6 * 86_400_000).toISOString().slice(0, 10),
      deadline: new Date(Date.parse(`${lastSaturday}T00:00:00.000Z`) + 30 * 86_400_000).toISOString().slice(0, 10),
      scheduling: { mode: 'effective', effectiveDays: 30, planningTimeZone: 'UTC' },
    } as unknown as StoredTrackerDefinition
    mocks.listTrackers.mockResolvedValue([challenge])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([])
    render(<MemoryRouter initialEntries={[`/calendar?date=${lastSaturday}`]}><CalendarPage /></MemoryRouter>)
    expect(await screen.findByText(/Rest day · Day 7 of 30/)).toBeInTheDocument()
    expect(screen.queryByText(/Missed · Day 7 of 30/)).not.toBeInTheDocument()
  })

  it('keeps the status guide collapsed until requested and opens selected date details', async () => {
    mocks.listTrackers.mockResolvedValue([tracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Morning walk', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/Completed · Done: Done/)).toBeInTheDocument()
    const manageHolidays = screen.getByRole('link', { name: 'Manage holidays' })
    expect(manageHolidays).toHaveClass('button-primary', 'button-medium')
    expect(manageHolidays).toHaveAttribute('href', '/holidays')
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('href', `/calendar?date=${today}`)
    expect(screen.getByRole('link', { name: 'Today' }).parentElement).toHaveClass('calendar-month-controls')
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

  it('shows Partial when a completed tracker shares a day with a recorded zero', async () => {
    const zeroTracker = { ...tracker, id: 'calendar-zero', name: 'Water' }
    const zeroEntry = { ...entry, id: 'calendar-zero-entry', trackerId: zeroTracker.id, values: { done: false } }
    mocks.listTrackers.mockResolvedValue([tracker, zeroTracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry, zeroEntry])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText(/1 completed · 0 partial · 1 no progress/)).toBeInTheDocument()
    expect(container.querySelector('.calendar-cell-status.partial')).toBeInTheDocument()
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
    expect(container.querySelector('.calendar-cell-status.completed')).toBeInTheDocument()
    expect(container.querySelector('.calendar-holiday-note')).toHaveTextContent('Account-wide holiday')
    expect(screen.getByText(/Completed · Account-wide holiday · Done/)).toBeInTheDocument()
  })

  it('labels a past global holiday using the tracker mode effective on that date', async () => {
    const historicalStandard = {
      ...tracker,
      strictMode: true,
      schemaVersion: 10,
      ruleVersions: [{
        id: 'standard-baseline', effectiveFrom: previousDate, revision: 1, application: 'baseline', recordedAt: `${previousDate}T00:00:00.000Z`,
        evaluation: { schedule: tracker.schedule, startDate: previousDate, deadline: null, scheduling: null, metrics: tracker.metrics, qualificationRule: tracker.qualificationRule, streakRuleMode: null, streakRule: null, strictMode: false },
      }],
    } as unknown as StoredTrackerDefinition
    mocks.listTrackers.mockResolvedValue([historicalStandard])
    mocks.listTrackerEntriesBetween.mockResolvedValue([])
    mocks.listAccountHolidays.mockResolvedValue([{ id: 'holiday-past', date: previousDate, reason: 'personal', createdAt: '', updatedAt: '', deletedAt: null }])
    render(<MemoryRouter initialEntries={[`/calendar?date=${previousDate}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Morning walk', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/Holiday · Account-wide holiday/)).toBeInTheDocument()
  })

  it('aggregates a selected holiday with other trackers’ actual statuses and keeps its details visible', async () => {
    const secondTracker = { ...tracker, id: 'second-tracker', name: 'Stretching' }
    mocks.listTrackers.mockResolvedValue([tracker, secondTracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([{ ...entry, trackerId: secondTracker.id }])
    mocks.listAccountHolidays.mockResolvedValue([])
    mocks.listTrackerHolidays.mockResolvedValue([{ id: 'selected-holiday', trackerId: tracker.id, date: today, createdAt: '', updatedAt: '', deletedAt: null }])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    expect(await screen.findByText('Morning walk', { selector: 'strong' })).toBeInTheDocument()
    expect(container.querySelector('.calendar-cell-status.completed')).toBeInTheDocument()
    expect(container.querySelector('.calendar-cell-status.holiday')).not.toBeInTheDocument()
    expect(screen.getByText(/Holiday · Tracker-specific holiday/)).toBeInTheDocument()
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
    expect(container.querySelector('.calendar-cell-status.missed')).toBeInTheDocument()

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

  it('keeps completed, no-progress, and pending trackers separately identifiable in aggregation', async () => {
    const secondTracker = { ...tracker, id: 'calendar-habit-two', name: 'Read a book' }
    const noProgressTracker = { ...tracker, id: 'calendar-no-progress', name: 'Not done today', metrics: [{ id: 'done', name: 'Status', valueType: 'boolean' }] } as unknown as StoredTrackerDefinition
    const noProgressEntry = { ...entry, id: 'calendar-no-progress-entry', trackerId: noProgressTracker.id, values: { done: false } } as StoredTrackerEntry
    mocks.listTrackers.mockResolvedValue([tracker, secondTracker, noProgressTracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([entry, noProgressEntry])
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    await screen.findByText('Morning walk', { selector: 'strong' })
    const cell = container.querySelector('.calendar-day-today .calendar-cell-status')
    expect(cell).toHaveClass('partial')
    expect(cell).toHaveClass('mixed')
    expect(cell).toHaveAttribute('aria-label', expect.stringContaining('mixed statuses across active trackers'))
    expect(cell).toHaveAttribute('aria-label', expect.stringContaining('1 completed, 0 partial, 1 no progress, 1 pending'))
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

  it('shows false Boolean values by saved measure name and keeps an unrecorded tracker distinct', async () => {
    const falseTracker = {
      ...tracker, id: 'calendar-false', name: 'Evening routine',
      metrics: [{ id: 'done', name: 'Completed', valueType: 'boolean' }, { id: 'water', name: 'Water', valueType: 'boolean' }],
    } as unknown as StoredTrackerDefinition
    const falseEntry = { ...entry, id: 'calendar-false-entry', trackerId: falseTracker.id, values: { done: false, water: false } } as StoredTrackerEntry
    mocks.listTrackers.mockResolvedValue([falseTracker, { ...tracker, id: 'calendar-unrecorded', name: 'Unrecorded routine' }])
    mocks.listTrackerEntriesBetween.mockResolvedValue([falseEntry])
    mocks.listAccountHolidays.mockResolvedValue([])
    render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    const recorded = await screen.findByText('Evening routine', { selector: 'strong' })
    expect(recorded.parentElement).toHaveTextContent('No progress · Completed: Not Done · Water: Not Done')
    const unrecorded = screen.getByText('Unrecorded routine', { selector: 'strong' })
    expect(unrecorded.parentElement).toHaveTextContent('Pending')
    expect(unrecorded.parentElement).not.toHaveTextContent('Done')
    expect(unrecorded.parentElement).not.toHaveTextContent('Progress recorded')
  })

  it('uses date-effective checklist names and totals when historical item definitions differ', async () => {
    const oldMetric = { id: 'steps', name: 'Old items', valueType: 'checklist' as const, checklistItems: [{ id: 'a', label: 'A', position: 0 }, { id: 'b', label: 'B', position: 1 }] }
    const currentMetric = { ...oldMetric, name: 'Items', checklistItems: [...oldMetric.checklistItems, { id: 'c', label: 'C', position: 2 }, { id: 'd', label: 'D', position: 3 }] }
    const historicalTracker = {
      ...tracker, id: 'calendar-historical-checklist', name: 'Historical checklist', schemaVersion: 10,
      metrics: [currentMetric], qualificationRule: { kind: 'comparison', metricId: 'steps', operator: 'at-least', value: 1 },
      ruleVersions: [{ id: 'checklist-v1', effectiveFrom: '2026-01-01', revision: 1, application: 'baseline', recordedAt: `${today}T00:00:00.000Z`, evaluation: { schedule: { kind: 'every-day' }, metrics: [oldMetric], qualificationRule: { kind: 'comparison', metricId: 'steps', operator: 'at-least', value: 1 } } }],
    } as unknown as StoredTrackerDefinition
    const historicalEntry = { ...entry, id: 'calendar-historical-checklist-entry', trackerId: historicalTracker.id, values: { steps: { a: true, b: false } } } as StoredTrackerEntry
    mocks.listTrackers.mockResolvedValue([historicalTracker])
    mocks.listTrackerEntriesBetween.mockResolvedValue([historicalEntry])
    mocks.listAccountHolidays.mockResolvedValue([])
    render(<MemoryRouter initialEntries={[`/calendar?date=${today}`]}><CalendarPage /></MemoryRouter>)

    const card = await screen.findByText('Historical checklist', { selector: 'strong' })
    expect(card.parentElement).toHaveTextContent('Old items: 1 of 2 checked')
    expect(card.parentElement).not.toHaveTextContent('1 of 4 checked')
  })
})
