import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import { publishWorkspaceDataChange } from '../../db/workspaceMutationEvents'
import type { StoredTrackerDefinition } from '../../db/models'
import { TodayPage } from './TodayPage'
import todayStyles from '../../styles.css?raw'

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'local-only', user: null }) }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete() })
const today = () => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}` as `${number}-${number}-${number}`

const tracker = (schedule: StoredTrackerDefinition['schedule'] = { kind: 'every-day' }): StoredTrackerDefinition => ({
  schemaVersion: 1, id: 'today-tracker', name: 'Daily reading', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule,
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', thresholds: { direction: 'increase', target: 5, streakQualification: 'target' } }],
  qualificationRule: { kind: 'threshold', metricId: 'pages', level: 'target' },
  customFields: [{ id: 'mood', name: 'Mood', type: 'single-select', required: true, position: 0, options: ['Focused', 'Tired'] }],
  milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
})

describe('Today check-ins', () => {
  it.each([320, 360, 390, 768, 1280])('keeps long tracker and measure summaries structured at %ipx', async (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    const measureName = 'Sessions completed during the advanced distributed systems course'
    const longTracker = {
      ...tracker(), schemaVersion: 4 as const,
      id: `long-tracker-${width}`,
      name: '850 hour course with advanced distributed systems and supplemental practice',
      customFields: [],
      metrics: [{
        id: 'pages', name: measureName, valueType: 'quantity' as const,
        unit: 'Sessions', precision: { decimalPlaces: 2 as const, increment: 0.01 },
        thresholds: { direction: 'increase' as const, target: 850.25, streakQualification: 'target' as const },
      }],
      qualificationRule: { kind: 'threshold' as const, metricId: 'pages', level: 'target' as const },
    }
    await localRepository.saveTracker(longTracker)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)

    const card = await screen.findByRole('heading', { name: longTracker.name }).then((heading) => heading.closest('.today-checkin-card')!)
    const summary = card.querySelector('.today-target-summary')!
    expect(summary).toHaveAttribute('role', 'group')
    expect(summary.querySelector('.today-target-name')).toHaveTextContent(measureName)
    expect(summary.querySelector('.today-target-value')).toHaveTextContent('0 / 850.25 Sessions')
    expect(summary.querySelector('.today-target-remaining')).toHaveTextContent('850.25 Sessions remaining')
    expect(screen.getByLabelText(`${measureName} · Sessions`)).toHaveAttribute('placeholder', 'Enter Sessions')
    expect(card).toHaveClass('status-pending')

    // JSDOM does not perform browser layout; guard the responsive CSS contract and
    // rendered hierarchy at each target viewport instead of relying on fake geometry.
    expect(todayStyles).toMatch(/\.today-target-summary\s*\{[^}]*display:\s*grid/s)
    expect(todayStyles).toMatch(/\.today-checkin-title\s*\{[^}]*overflow-wrap:\s*anywhere/s)
    expect(todayStyles).toMatch(/@media\s*\(max-width:\s*420px\)[\s\S]*?\.today-target-summary\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/)
  })

  it('validates required fields, saves locally, evaluates the rule, and edits the same daily entry', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)

    expect(await screen.findByRole('heading', { name: 'Daily reading' })).toBeInTheDocument()
    const activityCard = screen.getByRole('heading', { name: 'Daily reading' }).closest('.today-checkin-card')!
    expect(activityCard).toHaveClass('status-pending')
    expect(screen.getByRole('status', { name: 'Pending' })).toBeInTheDocument()
    expect(screen.getByLabelText('Pages')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Pages'), '5')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Please complete all required fields.')
    await user.selectOptions(screen.getByLabelText(/Mood/), 'Focused')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))

    expect(await screen.findByText('Your configured success rule is met.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Daily reading' }).closest('.today-checkin-card')).toHaveClass('status-completed'))
    const savedDate = today()
    const saved = await localRepository.getTrackerEntry('today-tracker', savedDate)
    expect(saved).toMatchObject({ outcome: 'recorded', values: { pages: 5, 'field:mood': 'Focused' } })

    await user.clear(screen.getByLabelText('Pages'))
    await user.type(screen.getByLabelText('Pages'), '2')
    await user.click(screen.getByRole('button', { name: 'Update check-in' }))
    await waitFor(async () => expect(await localRepository.getTrackerEntry('today-tracker', savedDate)).toMatchObject({ id: saved?.id, values: { pages: 2 } }))
    expect(await screen.findByText('Saved. The configured success rule is not met yet.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Daily reading' }).closest('.today-checkin-card')).toHaveClass('status-partial'))
  })

  it('keeps the week pattern collapsed until requested', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    const summary = await screen.findByText('Your last 7 days')
    const disclosure = summary.closest('details')
    expect(disclosure).not.toHaveAttribute('open')
    await user.click(summary)
    expect(disclosure).toHaveAttribute('open')
    expect(screen.getByRole('list', { name: 'Check-in pattern for the last seven days' })).toBeInTheDocument()
  })

  it('refreshes visible check-in status when another device syncs an entry', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    const card = await screen.findByRole('heading', { name: 'Daily reading' })
    expect(card.closest('.today-checkin-card')).toHaveClass('status-pending')

    await db.trackerEntries.put({
      id: 'remote-entry', trackerId: 'today-tracker', date: today(), outcome: 'recorded',
      values: { pages: 5, 'field:mood': 'Focused' }, note: '', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), deletedAt: null,
    })
    act(() => publishWorkspaceDataChange(null))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Daily reading' }).closest('.today-checkin-card')).toHaveClass('status-completed'))
    expect(screen.getByRole('status', { name: 'Completed' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Information about Daily reading daily requirements' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Completed\s*5/)
  })

  it('shows cumulative goal totals separately from today’s saved allocation and updates details after edits and deletion', async () => {
    const user = userEvent.setup()
    const current = today()
    const deadline = new Date(Date.parse(`${current}T00:00:00.000Z`) + 2 * 86_400_000).toISOString().slice(0, 10) as `${number}-${number}-${number}`
    const goal = {
      ...tracker(), schemaVersion: 4 as const, id: 'cumulative-goal', name: 'Daily DSA course', kind: 'goal' as const,
      customFields: [], startDate: current, deadline,
      metrics: [{ id: 'pages', name: 'Problems', valueType: 'quantity' as const, unit: 'sessions', precision: { decimalPlaces: 0 as const, increment: 1 }, thresholds: { direction: 'increase' as const, minimum: 2, target: 5, stretch: 8, streakQualification: 'target' as const } }],
      goalPlanning: { mode: 'cumulative-deadline' as const, progressSemantics: { pages: 'incremental' as const }, dailyTargets: {}, cumulativeTargets: { pages: 10 }, planningTimeZone: 'UTC', allocations: { pages: { [current]: 5 } } },
      qualificationRule: { kind: 'threshold' as const, metricId: 'pages', level: 'target' as const },
    }
    await localRepository.saveTracker(goal)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)

    const card = await screen.findByRole('heading', { name: 'Daily DSA course' }).then((heading) => heading.closest('.today-checkin-card')!)
    expect(card.querySelector('.today-target-summary')).toHaveTextContent('Today’s saved allocation0 / 5 sessions5 sessions remainingToday’s suggestion: 4 sessionsNext scheduled suggestion: 3 sessions')
    expect(card.querySelector('.today-target-summary')).not.toHaveTextContent('0 / 10 sessions')
    await user.type(screen.getByLabelText('Problems · sessions'), '3')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    await waitFor(() => expect(card.querySelector('.today-target-summary')).toHaveTextContent('3 / 5 sessions2 sessions remainingNext scheduled suggestion: 4 sessions'))
    const detailsButton = screen.getByRole('button', { name: 'Information about Daily DSA course daily requirements' })
    await user.click(detailsButton)
    await waitFor(() => expect(detailsButton).toHaveAttribute('aria-expanded', 'true'))
    let dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Goal total10 sessions')
    expect(dialog).toHaveTextContent('Recorded toward goal3 sessions')
    expect(dialog).toHaveTextContent('Saved allocation5 sessions')
    expect(dialog).toHaveTextContent(/Next scheduled suggestion.*4 sessions/)
    expect(dialog).toHaveTextContent('Minimum2 sessions')
    expect(dialog).toHaveTextContent('Target threshold5 sessions')
    expect(dialog).toHaveTextContent('Stretch8 sessions')

    await user.click(screen.getByRole('button', { name: 'Close daily requirements' }))
    await user.clear(screen.getByLabelText('Problems · sessions'))
    await user.type(screen.getByLabelText('Problems · sessions'), '4')
    await user.click(screen.getByRole('button', { name: 'Update check-in' }))
    await waitFor(() => expect(card.querySelector('.today-target-summary')).toHaveTextContent('4 / 5 sessions1 session remainingNext scheduled suggestion: 3 sessions'))
    await user.click(screen.getByRole('button', { name: 'Information about Daily DSA course daily requirements' }))
    dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Recorded toward goal4 sessions')

    await user.click(screen.getByRole('button', { name: 'Close daily requirements' }))
    await user.click(screen.getByRole('button', { name: 'Clear check-in' }))
    await waitFor(() => expect(card.querySelector('.today-target-summary')).toHaveTextContent('0 / 5 sessions5 sessions remainingToday’s suggestion: 4 sessionsNext scheduled suggestion: 3 sessions'))
  })

  it('keeps a daily recurring target distinct from per-check-in thresholds', async () => {
    const user = userEvent.setup()
    const dailyGoal = {
      ...tracker(), schemaVersion: 4 as const, id: 'daily-recurring-goal', kind: 'goal' as const, customFields: [],
      metrics: [
        { id: 'pages', name: 'Pages', valueType: 'quantity' as const, unit: 'pages', precision: { decimalPlaces: 0 as const, increment: 1 }, thresholds: { direction: 'increase' as const, minimum: 2, target: 5, stretch: 8, streakQualification: 'target' as const } },
        { id: 'minutes', name: 'Study time', valueType: 'duration' as const, unit: 'minutes', thresholds: { direction: 'increase' as const, target: 30, streakQualification: 'target' as const } },
      ],
      goalPlanning: { mode: 'daily-recurring' as const, progressSemantics: {}, dailyTargets: { pages: 6, minutes: 30 }, cumulativeTargets: {}, planningTimeZone: 'UTC' },
      qualificationRule: { kind: 'threshold' as const, metricId: 'pages', level: 'target' as const },
    }
    await localRepository.saveTracker(dailyGoal)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    const summary = await screen.findByRole('group', { name: 'Daily reading progress and daily expectation' })
    expect(summary).toHaveTextContent('Today’s target0 / 6 pages6 pages remaining')
    expect(summary).toHaveTextContent('Study timeToday’s target0 / 30 minutes30 minutes remaining')
    await user.click(screen.getByRole('button', { name: 'Information about Daily reading daily requirements' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Daily plan target6 pages')
    expect(dialog).toHaveTextContent('Daily plan target30 minutes')
    expect(dialog).toHaveTextContent('Minimum2 pages')
    expect(dialog).toHaveTextContent('Target threshold5 pages')
    expect(dialog).toHaveTextContent('Stretch8 pages')
  })

  it('shows a simple completion requirement for a yes/no tracker', async () => {
    const user = userEvent.setup()
    const yesNo = {
      ...tracker(), id: 'yes-no-tracker', name: 'Daily meditation', customFields: [],
      metrics: [{ id: 'done', name: 'Meditated', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
    }
    await localRepository.saveTracker(yesNo)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    const summary = await screen.findByRole('group', { name: 'Daily meditation progress and daily expectation' })
    expect(summary).toHaveTextContent('MeditatedComplete todayNot completed')
    await user.click(screen.getByRole('button', { name: 'Information about Daily meditation daily requirements' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('ExpectedComplete this check-in')
    expect(dialog).not.toHaveTextContent('Thresholds')
    expect(screen.getByRole('button', { name: 'Close daily requirements' })).toHaveFocus()
    expect(todayStyles).toContain('max-height: min(86dvh, 760px)')
    expect(todayStyles).toContain('env(safe-area-inset-bottom, 0px)')
    expect(todayStyles).toContain('overscroll-behavior: contain')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Information about Daily meditation daily requirements' })).toHaveFocus()
  })

  it('filters trackers that are not scheduled today and records a skip for scheduled trackers', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker({ kind: 'none' }))
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByText('Nothing scheduled today')).toBeInTheDocument()

    await db.trackers.put(tracker())
    cleanup()
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Skip today' }))
    await waitFor(() => expect(screen.getByText('Skipped')).toBeInTheDocument())
    expect(screen.getByText('1 of 1 scheduled activity checked in · skipped activities stay neutral.')).toBeInTheDocument()
  })

  it('shows only scheduled work in the at-a-glance progress summary', async () => {
    const scheduled = tracker()
    await localRepository.saveTracker(scheduled)
    await localRepository.saveTracker({ ...tracker({ kind: 'none' }), id: 'flexible', name: 'Flexible work' })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('region', { name: 'Today at a glance' })).toBeInTheDocument()
    expect(screen.getByText('0 of 1 scheduled activity checked in.')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '0 of 1 scheduled activities logged' })).toBeInTheDocument()
  })

  it('surfaces active goal deadlines without mixing goals into today’s scheduled check-in count', async () => {
    const dueSoon = { ...tracker({ kind: 'none' }), id: 'deadline-goal', name: 'Finish the portfolio', kind: 'goal' as const, deadline: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate() + 2).padStart(2, '0')}` as `${number}-${number}-${number}` }
    await localRepository.saveTracker(dueSoon)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Coming up soon' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Finish the portfolio.*2 days left/ })).toHaveAttribute('href', '/goals')
    expect(screen.getByText('Nothing scheduled today')).toBeInTheDocument()
  })

  it('shows a retry state rather than treating a failed local read as an empty day', async () => {
    const user = userEvent.setup()
    vi.spyOn(localRepository, 'listTrackers').mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    expect(screen.getByText('Your check-ins are still here')).toBeInTheDocument()
    expect(screen.queryByText('Nothing scheduled today')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Nothing scheduled today')).toBeInTheDocument()
  })
})
