import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { DashboardPage } from './DashboardPage'

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false }) }))

afterEach(async () => { cleanup(); window.sessionStorage.clear(); window.localStorage.removeItem(`progress-tracker:missing-checkins-dismissed:guest`); vi.restoreAllMocks(); await db.delete() })

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
    expect(screen.getByText('personal best')).toBeInTheDocument()
  })

  it('shows streak-only progress without counting it as weekly success or consistency', async () => {
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    const independentRules = {
      ...tracker(),
      schemaVersion: 8 as const,
      startDate: yesterday,
      scheduling: { mode: 'ongoing' as const },
      qualificationRule: { kind: 'comparison' as const, metricId: 'pages', operator: 'at-least' as const, value: 5 },
      streakRuleMode: 'custom' as const,
      streakRule: { kind: 'comparison' as const, metricId: 'pages', operator: 'at-least' as const, value: 1 },
    }
    await localRepository.saveTracker(independentRules)
    await localRepository.saveTrackerEntry({ trackerId: independentRules.id, date: yesterday, outcome: 'recorded', values: { pages: 1 }, note: '' })

    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    const summary = await screen.findByRole('group', { name: 'Recent progress summary' })
    expect(within(summary).getByText('Successes · 7 days').closest('.dashboard-stat')).toHaveTextContent('0')
    expect(within(summary).getByText('Weekly consistency').closest('.dashboard-stat')).toHaveTextContent('0%')
    const card = (await screen.findByRole('heading', { name: 'Read a book' })).closest('.dashboard-tracker-card')!
    expect(card).toHaveTextContent(/1\s*current streak/)
  })

  it('separates today holiday status from the dated latest check-in and preserves mode-specific streak rules', async () => {
    const standard = { ...tracker(), startDate: shiftCalendarDate(localCalendarDate(), -3) }
    const strict = { ...standard, id: 'dashboard-strict', name: 'Strict tracker', strictMode: true }
    const empty = { ...standard, id: 'dashboard-empty', name: 'No entries' }
    await localRepository.saveTracker(standard)
    await localRepository.saveTracker(strict)
    await localRepository.saveTracker(empty)
    const twoDaysAgo = shiftCalendarDate(localCalendarDate(), -2)
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    await localRepository.saveTrackerEntry({ trackerId: standard.id, date: twoDaysAgo, outcome: 'recorded', values: { pages: 5 }, note: '' })
    await localRepository.saveTrackerEntry({ trackerId: strict.id, date: twoDaysAgo, outcome: 'recorded', values: { pages: 5 }, note: '' })
    await localRepository.saveAccountHolidays([yesterday, localCalendarDate()], 'personal')

    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    const standardCard = (await screen.findByRole('heading', { name: 'Read a book' })).closest('.dashboard-tracker-card')!
    const strictCard = screen.getByRole('heading', { name: 'Strict tracker' }).closest('.dashboard-tracker-card')!
    const emptyCard = screen.getByRole('heading', { name: 'No entries' }).closest('.dashboard-tracker-card')!
    expect(standardCard).toHaveTextContent('Today')
    expect(standardCard).not.toHaveTextContent('Snapshot')
    expect(standardCard).toHaveTextContent('Holiday')
    expect(standardCard).toHaveTextContent(calendarDateLabel(twoDaysAgo))
    expect(standardCard.querySelector('.dashboard-tracker-stats span strong')).toHaveTextContent('1')
    expect(standardCard).toHaveTextContent('personal best')
    expect(strictCard).toHaveTextContent('Today')
    expect(strictCard).toHaveTextContent('Holiday · check-in still required')
    expect(strictCard.querySelector('.dashboard-tracker-stats span strong')).toHaveTextContent('0')
    expect(strictCard).toHaveTextContent('personal best')
    expect(emptyCard).toHaveTextContent('Holiday')
    expect(emptyCard).toHaveTextContent('No check-ins yet')
    expect(emptyCard).not.toHaveTextContent('Ready when you are')
    const streakHelp = within(standardCard as HTMLElement).getByRole('button', { name: 'More about Current streak' })
    expect(streakHelp).toBeInTheDocument()
    fireEvent.click(streakHelp)
    expect(await screen.findByRole('dialog', { name: 'Current streak' })).toBeInTheDocument()
  })

  it('does not display a cleared historical check-in as the latest entry', async () => {
    const definition = { ...tracker(), startDate: shiftCalendarDate(localCalendarDate(), -3) }
    await localRepository.saveTracker(definition)
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: yesterday, outcome: 'recorded', values: { pages: 0 }, note: '' })
    await localRepository.deleteTrackerEntry(definition.id, yesterday)
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    const card = (await screen.findByRole('heading', { name: 'Read a book' })).closest('.dashboard-tracker-card')!
    expect(card).toHaveTextContent('No check-ins yet')
    expect(card).not.toHaveTextContent(calendarDateLabel(yesterday))
  })

  it('does not invent activity when no trackers exist', async () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByText('Your overview starts with a tracker')).toBeInTheDocument()
  })

  it('shows one grouped review reminder, dismisses it for today, and keeps the missing count in History navigation', async () => {
    const user = userEvent.setup()
    const definition = { ...tracker(), startDate: shiftCalendarDate(localCalendarDate(), -3) }
    await localRepository.saveTracker(definition)
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    const reminder = (await screen.findByText(/\d+ check-ins to review/)).closest('.dashboard-missing-reminder') as HTMLElement
    expect(reminder).toHaveTextContent(/\d+ check-ins to review/)
    expect(reminder).toHaveTextContent('Some required dates have no saved check-in.')
    expect(within(reminder).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/history#missing-checkins')
    await user.click(within(reminder).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/\d+ check-ins to review/)).not.toBeInTheDocument()
    expect(window.localStorage.getItem('progress-tracker:missing-checkins-dismissed:guest')).toBe(localCalendarDate())
  })

  it('filters tracker cards and heatmap by stable tracker ID and exposes tap details', async () => {
    const user = userEvent.setup()
    const first = tracker()
    const second = { ...tracker(), id: 'dashboard-water', name: 'Drink water', strictMode: true }
    await localRepository.saveTracker(first)
    await localRepository.saveTracker(second)
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    await localRepository.saveTrackerEntry({ trackerId: first.id, date: yesterday, outcome: 'recorded', values: { pages: 5 }, note: '' })
    await localRepository.saveTrackerEntry({ trackerId: second.id, date: yesterday, outcome: 'recorded', values: { pages: 5 }, note: '' })
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Activity Heatmap' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Read a book' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Drink water' })).toBeInTheDocument()
    const overview = document.querySelector('.dashboard-page')!
    const regions = [
      overview.querySelector('.insights-filter-toolbar')!,
      overview.querySelector('.dashboard-stats')!,
      overview.querySelector('.activity-heatmap-section')!,
      overview.querySelector('.dashboard-tracker-section')!,
    ]
    const childOrder = Array.from(overview.children)
    expect(regions.map((region) => childOrder.indexOf(region))).toEqual([2, 3, 4, 5])
    expect(overview.querySelector('.dashboard-stats')?.children).toHaveLength(5)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show activity for' }), first.id)
    expect(screen.getByRole('heading', { name: 'Read a book' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Drink water' })).not.toBeInTheDocument()
    expect(screen.getByText('Read a book · last 12 months')).toBeInTheDocument()
    const info = screen.getByRole('button', { name: 'More about Activity Heatmap' })
    await user.click(info)
    expect(screen.getByRole('dialog', { name: 'Activity Heatmap' })).toHaveTextContent('qualified opportunities divided by eligible opportunities')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Activity Heatmap' })).not.toBeInTheDocument()
  })

  it('uses responsive automatic defaults until a range is manually selected', async () => {
    const definition = { ...tracker(), startDate: '2024-01-01' as const, createdAt: '2024-01-01T00:00:00.000Z' }
    await localRepository.saveTracker(definition)
    const originalWidth = window.innerWidth
    window.sessionStorage.removeItem('insights-heatmap-range')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const { unmount } = render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    const range = await screen.findByRole('combobox', { name: 'Activity date range' })
    expect(range).toHaveValue('last6Months')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(range).toHaveValue('last12Months'))
    fireEvent.change(range, { target: { value: 'last3Months' } })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    fireEvent(window, new Event('resize'))
    expect(range).toHaveValue('last3Months')
    expect(screen.getByText('All Trackers · last 3 months')).toBeInTheDocument()
    fireEvent.change(range, { target: { value: 'year' } })
    const year = screen.getByRole('combobox', { name: 'Activity year' })
    expect(year).toHaveValue(String(new Date().getFullYear()))
    expect(Array.from(year.querySelectorAll('option'), (option) => Number(option.value))).toContain(2024)
    fireEvent.change(year, { target: { value: '2024' } })
    expect(year).toHaveValue('2024')
    unmount()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  })

  it('refreshes displayed weekly statistics when a check-in changes while the dashboard is mounted', async () => {
    const definition = tracker()
    await localRepository.saveTracker(definition)
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    await screen.findByText('Successes · 7 days')
    const successValue = () => screen.getByText('Successes · 7 days').closest('.dashboard-stat')?.querySelector('strong')
    await waitFor(() => expect(successValue()).toHaveTextContent('0'))

    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: localCalendarDate(), outcome: 'recorded', values: { pages: 5 }, note: '' })
    await waitFor(() => expect(successValue()).toHaveTextContent('1'))

    await localRepository.deleteTrackerEntry(definition.id, localCalendarDate())
    await waitFor(() => expect(successValue()).toHaveTextContent('0'))
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
