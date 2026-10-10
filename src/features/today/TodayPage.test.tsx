import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import { publishWorkspaceDataChange } from '../../db/workspaceMutationEvents'
import type { StoredTrackerDefinition } from '../../db/models'
import { calendarDateLabel } from '../shared/localDates'
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
  it.each([320, 360, 390, 430, 768, 1280])('keeps long tracker and measure summaries structured at %ipx', async (width) => {
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
    expect(card.querySelector('.today-compact-metric')).toHaveTextContent(measureName)
    expect(card.querySelector('.today-compact-metric')).toHaveTextContent('0 / 850.25 Sessions')
    expect(card.querySelector('.today-compact-metric')).toHaveTextContent('850.25 Sessions remaining')
    expect(screen.queryByLabelText(`${measureName} · Sessions`)).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: `Open ${longTracker.name}, Pending` }))
    expect(screen.getByLabelText(`${measureName} · Sessions`)).toHaveAttribute('placeholder', 'Enter Sessions')
    expect(card).toHaveClass('status-pending')

    // JSDOM does not perform browser layout; guard the responsive CSS contract and
    // rendered hierarchy at each target viewport instead of relying on fake geometry.
    expect(todayStyles).toMatch(/\.today-compact-metrics\s*\{[^}]*display:\s*flex/s)
    expect(todayStyles).toMatch(/\.today-card-title\s*\{[^}]*overflow-wrap:\s*anywhere/s)
    expect(todayStyles).toMatch(/@media\s*\(max-width:\s*380px\)/)
  })

  it('validates required fields, saves locally, evaluates the rule, and edits the same daily entry', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)

    expect(await screen.findByRole('heading', { name: 'Daily reading' })).toBeInTheDocument()
    const activityCard = screen.getByRole('button', { name: /Open Daily reading/ }).closest('.today-checkin-card')!
    expect(activityCard).toHaveClass('status-pending')
    expect(screen.getByRole('status', { name: 'Pending' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open Daily reading, Pending' }))
    expect(screen.getByLabelText('Pages')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Pages'), '5')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Please complete all required fields.')
    await user.selectOptions(screen.getByLabelText(/Mood/), 'Focused')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))

    expect(await screen.findByText('Your configured success rule is met.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /Open Daily reading/ }).closest('.today-checkin-card')).toHaveClass('status-completed'))
    const savedDate = today()
    const saved = await localRepository.getTrackerEntry('today-tracker', savedDate)
    expect(saved).toMatchObject({ outcome: 'recorded', values: { pages: 5, 'field:mood': 'Focused' } })

    await user.clear(screen.getByLabelText('Pages'))
    await user.type(screen.getByLabelText('Pages'), '2')
    await user.click(screen.getByRole('button', { name: 'Update check-in' }))
    await waitFor(async () => expect(await localRepository.getTrackerEntry('today-tracker', savedDate)).toMatchObject({ id: saved?.id, values: { pages: 2 } }))
    expect(await screen.findByText('Saved. The configured success rule is not met yet.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /Open Daily reading/ }).closest('.today-checkin-card')).toHaveClass('status-partial'))
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

    await waitFor(() => expect(screen.getByRole('button', { name: /Open Daily reading/ }).closest('.today-checkin-card')).toHaveClass('status-completed'))
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
    expect(card.querySelector('.today-compact-metric')).toHaveTextContent('0 / 5 sessions')
    await user.click(screen.getByRole('button', { name: 'Open Daily DSA course, Pending' }))
    await user.type(screen.getByLabelText('Problems · sessions'), '3')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    await waitFor(() => expect(card.querySelector('.today-compact-metric')).toHaveTextContent('3 / 5 sessions'))
    const detailsButton = screen.getAllByRole('button', { name: 'Information about Daily DSA course daily requirements' }).at(-1)!
    await user.click(detailsButton)
    await waitFor(() => expect(detailsButton).toHaveAttribute('aria-expanded', 'true'))
    let dialog = screen.getAllByRole('dialog').at(-1)!
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
    await waitFor(() => expect(card.querySelector('.today-compact-metric')).toHaveTextContent('4 / 5 sessions'))
    await user.click(screen.getAllByRole('button', { name: 'Information about Daily DSA course daily requirements' }).at(-1)!)
    dialog = screen.getAllByRole('dialog').at(-1)!
    expect(dialog).toHaveTextContent('Recorded toward goal4 sessions')

    await user.click(screen.getByRole('button', { name: 'Close daily requirements' }))
    await user.click(screen.getByRole('button', { name: 'Clear check-in' }))
    await waitFor(() => expect(card.querySelector('.today-compact-metric')).toHaveTextContent('0 / 5 sessions'))
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
    await screen.findByRole('heading', { name: 'Daily reading' })
    await user.click(screen.getByRole('button', { name: 'Open Daily reading, Pending' }))
    await user.click(screen.getAllByRole('button', { name: 'Information about Daily reading daily requirements' }).at(-1)!)
    const dialog = (await screen.findAllByRole('dialog')).at(-1)!
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
    await screen.findByRole('heading', { name: 'Daily meditation' })
    await user.click(screen.getByRole('button', { name: 'Information about Daily meditation daily requirements' }))
    const dialog = (await screen.findAllByRole('dialog')).at(-1)!
    expect(dialog).toHaveTextContent('ExpectedComplete this check-in')
    expect(dialog).not.toHaveTextContent('Thresholds')
    expect(screen.getByRole('button', { name: 'Close daily requirements' })).toHaveFocus()
    expect(todayStyles).toContain('max-height: min(760px, calc(100dvh - max(8px, env(safe-area-inset-top, 0px))')
    expect(todayStyles).toContain('env(safe-area-inset-bottom, 0px)')
    expect(todayStyles).toContain('overscroll-behavior: contain')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Information about Daily meditation daily requirements' })).toHaveFocus()
  })

  it('keeps nested requirements scrollable, closes the top overlay first, and restores body scrolling', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker({
      ...tracker(),
      description: 'A long description with a URL-like value that stays readable: ' + 'details/'.repeat(40),
      customFields: [],
      metrics: [
        { id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', target: 5, streakQualification: 'target' } },
        { id: 'minutes', name: 'Minutes practiced', valueType: 'quantity', unit: 'minutes' },
        { id: 'complete', name: 'Session complete', valueType: 'boolean' },
      ],
    })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    const cardTrigger = await screen.findByRole('button', { name: 'Open Daily reading, Pending' })
    const cardInfo = screen.getByRole('button', { name: 'Information about Daily reading daily requirements' })
    expect(cardInfo).toHaveClass('today-requirements-trigger')
    await user.click(cardInfo)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Save check-in' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close daily requirements' }))
    expect(cardInfo).toHaveFocus()

    await user.click(cardTrigger)
    const checkin = screen.getByRole('dialog', { name: 'Daily reading' })
    expect(checkin.querySelector('.today-description-details')).toHaveTextContent('details/'.repeat(40))
    expect(screen.getByLabelText(/Pages · pages/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Minutes practiced · minutes/)).toBeInTheDocument()
    expect(screen.getByLabelText('Session complete')).toBeInTheDocument()
    expect(checkin.querySelector('footer')).toHaveTextContent('Save check-in')
    expect(document.body.style.overflow).toBe('hidden')

    const infoButtons = screen.getAllByRole('button', { name: 'Information about Daily reading daily requirements' })
    await user.click(infoButtons.at(-1)!)
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2)
    expect(checkin).toHaveAttribute('aria-hidden', 'true')
    expect(checkin).toHaveProperty('inert', true)
    await user.keyboard('{Escape}')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(checkin).not.toHaveAttribute('aria-hidden')
    expect(checkin).toHaveProperty('inert', false)
    expect(document.body.style.overflow).toBe('hidden')
    expect(infoButtons.at(-1)).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Close check-in details' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(document.body.style.overflow).toBe(''))
    expect(cardTrigger).toHaveFocus()

    // Repeated open and close cycles must not retain the lock.
    await user.click(cardTrigger)
    await user.click(screen.getByRole('button', { name: 'Close check-in details' }))
    await waitFor(() => expect(document.body.style.overflow).toBe(''))
  })

  it('keeps dialog headers, close buttons, scroll regions, and check-in actions in viewport-aware layout', () => {
    expect(todayStyles).toMatch(/\.today-detail-content\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s)
    expect(todayStyles).toMatch(/\.today-detail-actions\s*\{[^}]*flex:\s*0 0 auto/s)
    expect(todayStyles).toMatch(/\.today-requirements-content\s*\{[^}]*overflow-y:\s*auto/s)
    expect(todayStyles).toMatch(/\.today-requirements-heading\s*\{[^}]*flex:\s*0 0 auto/s)
    expect(todayStyles).toMatch(/\.today-requirements-trigger\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s)
    expect(todayStyles).toContain('max-height: min(850px, calc(100dvh - max(12px, env(safe-area-inset-top, 0px))')
    expect(todayStyles).toContain('env(safe-area-inset-top, 0px)')
    expect(todayStyles).toContain('-webkit-overflow-scrolling: touch')
    expect(todayStyles).toContain('overflow-wrap: anywhere')
    expect(todayStyles).toMatch(/\.today-detail-backdrop\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*1400/s)
    expect(todayStyles).toMatch(/details:not\(\.mobile-more\)\[open\] > summary::after\s*\{[^}]*rotate\(180deg\)/s)
  })

  it('renders the check-in sheet in the viewport-level portal above application navigation', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    const dialog = await screen.findByRole('dialog', { name: 'Daily reading' })
    expect(dialog.closest('.tracker-page')).toBeNull()
    const backdrop = dialog.closest('.today-detail-backdrop') as HTMLElement
    expect(backdrop.parentElement).toBe(document.body)
    expect(backdrop.style.height).toBe(`${window.innerHeight}px`)
    expect(screen.getByRole('button', { name: 'Close check-in details' })).toHaveAttribute('type', 'button')
  })

  it('closes the top Today overlay first when browser back is used', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    const info = screen.getAllByRole('button', { name: 'Information about Daily reading daily requirements' }).at(-1)!
    await user.click(info)
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2)

    window.history.back()
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
    expect(document.body.style.overflow).toBe('hidden')
    window.history.back()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(document.body.style.overflow).toBe(''))
  })

  it('keeps an unsaved check-in open when browser back discard is canceled', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    await user.type(screen.getByLabelText('Pages'), '4')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    window.history.back()
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(screen.getByRole('dialog', { name: 'Daily reading' })).toBeInTheDocument()
    await waitFor(() => expect((window.history.state as Record<string, unknown>).__progressTrackerModalLayer).toBeTruthy())

    confirm.mockReturnValue(true)
    window.history.back()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Daily reading' })).not.toBeInTheDocument())
    await waitFor(() => expect(document.body.style.overflow).toBe(''))
    expect(await localRepository.getTrackerEntry('today-tracker', today())).toBeUndefined()
  })

  it('filters trackers that are not scheduled today and records a skip for scheduled trackers', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker({ ...tracker({ kind: 'none' }), customFields: [] })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Open Daily reading, Rest day' })).toBeInTheDocument()

    await db.trackers.put({ ...tracker(), customFields: [] })
    cleanup()
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await screen.findByRole('heading', { name: 'Daily reading' })
    await user.click(screen.getByRole('button', { name: 'Open Daily reading, Pending' }))
    await user.click(await screen.findByRole('button', { name: 'Skip today' }))
    await waitFor(() => expect(screen.getByText('Skipped')).toBeInTheDocument())
    expect(screen.getByRole('region', { name: 'Today at a glance' })).toHaveTextContent('1 skipped')
    await user.click(screen.getByRole('button', { name: 'Open Daily reading, Skipped' }))
    expect(screen.getByText(/This activity was skipped/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Pages'), '3')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Daily reading, Partially completed' })).toBeInTheDocument())
    expect(await localRepository.getTrackerEntry('today-tracker', today())).toMatchObject({ outcome: 'recorded', values: { pages: 3 } })
  })

  it('protects unsaved check-in edits and restores focus to the activity card', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    const trigger = await screen.findByRole('button', { name: 'Open Daily reading, Pending' })
    await user.click(trigger)
    await user.type(screen.getByLabelText('Pages'), '3')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Daily reading' })).toBeInTheDocument()
    expect(window.confirm).toHaveBeenCalled()
    vi.mocked(window.confirm).mockReturnValue(true)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Daily reading' })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    expect(await localRepository.getTrackerEntry('today-tracker', today())).toBeUndefined()
  })

  it('opens rest-day cards for details without offering an invalid check-in', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker({ kind: 'none' }))
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Rest day' }))
    expect(await screen.findByRole('dialog', { name: 'Daily reading' })).toBeInTheDocument()
    expect(screen.getByText(/Today is not a scheduled day/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save check-in' })).not.toBeInTheDocument()
  })

  it('shows holiday cards as inspectable while keeping holiday check-in actions unavailable', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    await localRepository.saveAccountHolidays([today()], 'personal')
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByText('Today is a holiday')).toBeInTheDocument()
    const open = await screen.findByRole('button', { name: 'Open Daily reading, Holiday' })
    expect(open.closest('.today-checkin-card')).toHaveClass('status-holiday')
    await user.click(open)
    expect(await screen.findByRole('dialog', { name: 'Daily reading' })).toBeInTheDocument()
    expect(screen.getByText(/marked as a holiday|holiday, so this activity cannot/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save check-in' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage holidays' })).toHaveAttribute('href', `/holidays?date=${today()}`)
  })

  it('allows a missed scheduled opportunity to receive a historical check-in', async () => {
    const user = userEvent.setup()
    const yesterday = new Date(Date.parse(`${today()}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10) as `${number}-${number}-${number}`
    await localRepository.saveTracker({ ...tracker(), customFields: [] })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByText(/Missed opportunities in the last week/))
    const missed = await screen.findByRole('button', { name: `Open Daily reading, Missed, ${calendarDateLabel(yesterday)}` })
    await user.click(missed)
    expect(await screen.findByRole('dialog', { name: 'Daily reading' })).toHaveTextContent('Missed')
    await user.type(screen.getByLabelText('Pages'), '5')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(await localRepository.getTrackerEntry('today-tracker', yesterday)).toMatchObject({ outcome: 'recorded', values: { pages: 5 } })
    await waitFor(() => expect(screen.queryByRole('button', { name: `Open Daily reading, Missed, ${calendarDateLabel(yesterday)}` })).not.toBeInTheDocument())
  })

  it('shows only scheduled work in the at-a-glance progress summary', async () => {
    const scheduled = tracker()
    await localRepository.saveTracker(scheduled)
    await localRepository.saveTracker({ ...tracker({ kind: 'none' }), id: 'flexible', name: 'Flexible work' })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('region', { name: 'Today at a glance' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Today at a glance' })).toHaveTextContent('0 of 1 checked in')
    expect(screen.getByRole('img', { name: '0 of 1 scheduled activities completed' })).toBeInTheDocument()
  })

  it('surfaces active goal deadlines without mixing goals into today’s scheduled check-in count', async () => {
    const dueSoon = { ...tracker({ kind: 'none' }), id: 'deadline-goal', name: 'Finish the portfolio', kind: 'goal' as const, deadline: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate() + 2).padStart(2, '0')}` as `${number}-${number}-${number}` }
    await localRepository.saveTracker(dueSoon)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Coming up soon' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Finish the portfolio.*2 days left/ })).toHaveAttribute('href', '/goals')
    expect(screen.getByRole('button', { name: 'Open Finish the portfolio, Rest day' })).toBeInTheDocument()
  })

  it('shows a retry state rather than treating a failed local read as an empty day', async () => {
    const user = userEvent.setup()
    vi.spyOn(localRepository, 'listTrackers').mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    expect(screen.getByText('Your check-ins are still here')).toBeInTheDocument()
    expect(screen.queryByText('Nothing scheduled today')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Create a tracker' })).toBeInTheDocument()
  })
})
