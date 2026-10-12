import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
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

  it('exposes exact daily values through touch and keyboard controls without chart hover', async () => {
    const user = userEvent.setup()
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    const today = localCalendarDate()
    await localRepository.saveTracker(definition)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: yesterday, outcome: 'recorded', values: { distance: 5, minutes: 25 }, note: '' })
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: today, outcome: 'recorded', values: { distance: 2, minutes: 40 }, note: '' })

    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const distanceRegion = await screen.findByRole('region', { name: 'Distance analysis' })
    const summary = within(distanceRegion).getByText('View 2 daily values')
    const details = summary.closest('details')!
    expect(details).not.toHaveAttribute('open')
    await user.click(summary)
    const values = within(details).getAllByRole('button')
    expect(values.map((button) => button.getAttribute('aria-label'))).toEqual([
      `${calendarDateLabel(yesterday, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: 5 km`,
      `${calendarDateLabel(today, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: 2 km`,
    ])

    values[0]!.focus()
    expect(values[0]).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await within(details).findByRole('status')).toHaveTextContent(`Distance · ${calendarDateLabel(yesterday, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: 5 km`)
    await user.click(values[1]!)
    expect(within(details).getByRole('status')).toHaveTextContent(`Distance · ${calendarDateLabel(today, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: 2 km`)
    expect(values[1]).toHaveAttribute('aria-pressed', 'true')
  })

  it('limits dense chart details to the same latest fourteen values shown by the chart', async () => {
    const tracker = { ...definition, startDate: shiftCalendarDate(localCalendarDate(), -20) }
    await localRepository.saveTracker(tracker)
    for (let index = 0; index < 16; index += 1) {
      await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: shiftCalendarDate(localCalendarDate(), index - 15), outcome: 'recorded', values: { distance: index + 1, minutes: index + 20 }, note: '' })
    }

    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const distanceRegion = await screen.findByRole('region', { name: 'Distance analysis' })
    const summary = within(distanceRegion).getByText('View 14 daily values')
    await userEvent.setup().click(summary)
    const detailButtons = within(summary.closest('details')!).getAllByRole('button')
    expect(detailButtons).toHaveLength(14)
    expect(detailButtons[0]).toHaveAccessibleName(/: 3 km$/)
    expect(detailButtons.at(-1)).toHaveAccessibleName(/: 16 km$/)
    expect(detailButtons[0]).not.toHaveAccessibleName(/: 1 km$/)
  })

  it('keeps empty metric datasets free of chart detail controls', async () => {
    await localRepository.saveTracker(definition)
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    expect(await screen.findAllByText('No values recorded in this period.')).toHaveLength(2)
    expect(screen.queryByText(/View \d+ daily values?/)).not.toBeInTheDocument()
  })

  it('announces boolean metric observations as Yes and No', async () => {
    const user = userEvent.setup()
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    const tracker: StoredTrackerDefinition = {
      ...definition,
      id: 'analytics-boolean',
      metrics: [{ id: 'completed', name: 'Completed', valueType: 'boolean' }],
      qualificationRule: { kind: 'comparison', metricId: 'completed', operator: 'equals', value: true },
    }
    await localRepository.saveTracker(tracker)
    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: yesterday, outcome: 'recorded', values: { completed: true }, note: '' })
    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: localCalendarDate(), outcome: 'recorded', values: { completed: false }, note: '' })

    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const region = await screen.findByRole('region', { name: 'Completed analysis' })
    await user.click(within(region).getByText('View 2 daily values'))
    const buttons = within(region).getAllByRole('button')
    expect(buttons[0]).toHaveAccessibleName(new RegExp(`${calendarDateLabel(yesterday, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: Yes`))
    expect(buttons[1]).toHaveAccessibleName(new RegExp(`${calendarDateLabel(localCalendarDate(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: No`))
  })
})
