import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { db } from '../../db/database'
import { ToastProvider } from '../../components/ui/ToastProvider'
import { localRepository } from '../../db/localRepository'
import { publishWorkspaceDataChange } from '../../db/workspaceMutationEvents'
import type { StoredTrackerDefinition } from '../../db/models'
import { calendarDateLabel } from '../shared/localDates'
import { TodayPage } from './TodayPage'
import { TrackerSetupPage } from '../trackers/TrackerSetupPage'
import todayStyles from '../../styles.css?raw'

const todayMocks = vi.hoisted(() => ({ auth: { status: 'local-only', user: null, isOnline: true, syncStatus: 'idle' } as { status: string; user: null | { id: string }; isOnline: boolean; syncStatus?: string } }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => todayMocks.auth }))

afterEach(async () => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); todayMocks.auth = { status: 'local-only', user: null, isOnline: true, syncStatus: 'idle' }; await db.delete() })
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
  it('welcomes a first-time guest and links straight to tracker creation', async () => {
    render(<ToastProvider><MemoryRouter><TodayPage /></MemoryRouter></ToastProvider>)
    expect(await screen.findByRole('heading', { name: 'Start tracking what matters.' }, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText('Build better habits, work toward your goals, and celebrate progress one day at a time.')).toBeInTheDocument()
    expect(screen.getByText('Start with one activity. You can customize everything later.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create your first tracker' })).toHaveAttribute('href', '/trackers/new')
    expect(screen.getByText('Your progress is saved on this device.')).toBeInTheDocument()
    expect(screen.queryByText(/IndexedDB|database/i)).not.toBeInTheDocument()
  })

  it('shows account sync status without claiming signed-in progress is device-only', async () => {
    todayMocks.auth = { status: 'signed-in', user: { id: 'account-a' }, isOnline: true, syncStatus: 'complete' }
    render(<ToastProvider><MemoryRouter><TodayPage /></MemoryRouter></ToastProvider>)
    expect(await screen.findByRole('heading', { name: 'Start tracking what matters.' })).toBeInTheDocument()
    expect(screen.getByText('Account sync is up to date.')).toBeInTheDocument()
    expect(screen.queryByText('Your progress is saved on this device.')).not.toBeInTheDocument()
  })

  it('waits for initial account sync before showing a first-time welcome', async () => {
    todayMocks.auth = { status: 'signed-in', user: { id: 'account-a' }, isOnline: true, syncStatus: 'waiting' }
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByText('Checking your account for saved trackers…')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('heading', { name: 'Start tracking what matters.' })).not.toBeInTheDocument()
  })

  it('offers account recovery when signed-in account data is unavailable offline', async () => {
    todayMocks.auth = { status: 'signed-in', user: { id: 'account-a' }, isOnline: false, syncStatus: 'offline' }
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Your account is offline' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Account sync' })).toHaveAttribute('href', '/settings#sync-data')
    expect(screen.getByRole('link', { name: 'Create a tracker' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Start tracking what matters.' })).not.toBeInTheDocument()
  })

  it('shows the inactive state for archived trackers instead of treating the user as new', async () => {
    await localRepository.saveTracker({ ...tracker(), status: 'archived' })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'No active trackers' })).toBeInTheDocument()
    expect(screen.getByText('Your trackers are currently inactive. Restore an existing tracker or create a new one to get started.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View trackers' })).toHaveAttribute('href', '/trackers')
    expect(screen.queryByRole('heading', { name: 'Start tracking what matters.' })).not.toBeInTheDocument()
  })

  it('excludes archived trackers from Today even when an active tracker is also present', async () => {
    await localRepository.saveTracker({ ...tracker(), id: 'active-today', name: 'Current routine', customFields: [] })
    await localRepository.saveTracker({ ...tracker(), id: 'archived-today', name: 'Past routine', status: 'archived', archivedAt: `${today()}T00:00:00.000Z`, customFields: [] })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByText('Current routine')).toBeInTheDocument()
    expect(screen.queryByText('Past routine')).not.toBeInTheDocument()
  })

  it('offers the inactive state for paused trackers too', async () => {
    await localRepository.saveTracker({ ...tracker(), status: 'paused' })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'No active trackers' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View trackers' })).toHaveAttribute('href', '/trackers')
  })

  it('offers the Bin when deleted tracker records remain but none are active', async () => {
    await localRepository.saveTracker({ ...tracker(), customFields: [] })
    await localRepository.deleteTracker('today-tracker')
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'No active trackers' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View Bin' })).toHaveAttribute('href', '/bin')
  })

  it('shows the unscheduled state for an existing active tracker while retaining its rest-day card', async () => {
    await localRepository.saveTracker({ ...tracker({ kind: 'none' }), customFields: [] })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Nothing scheduled today' })).toBeInTheDocument()
    expect(screen.getByText('You’re all caught up for today. Check your trackers or plan what comes next.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View trackers' })).toHaveAttribute('href', '/trackers')
    expect(screen.getByRole('button', { name: 'Open Daily reading, Rest day' })).toBeInTheDocument()
  })

  it('requires a Strict Mode check-in on a rest day', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker({ ...tracker({ kind: 'none' }), customFields: [], strictMode: true })
    render(<ToastProvider><MemoryRouter initialEntries={[{ pathname: '/', state: { openActivity: { trackerId: 'today-tracker', date: today() } } }]}><TodayPage /></MemoryRouter></ToastProvider>)
    expect(await screen.findByRole('button', { name: 'Open Daily reading, Pending' })).toBeInTheDocument()
    expect(screen.queryByText(/Voluntary check-in · this stays a holiday or rest day/)).not.toBeInTheDocument()
    expect(await screen.findByRole('dialog', { name: 'Daily reading' })).toHaveTextContent('Pending')
    await user.type(screen.getByRole('spinbutton', { name: 'Pages' }), '5')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(await localRepository.getTrackerEntry('today-tracker', today())).toMatchObject({ outcome: 'recorded', values: { pages: 5 } })
  })

  it('keeps the completed-day experience for scheduled work', async () => {
    await localRepository.saveTracker({ ...tracker(), customFields: [] })
    await localRepository.saveTrackerEntry({ trackerId: 'today-tracker', date: today(), outcome: 'recorded', values: { pages: 5 }, note: '' })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'All done for today!' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Start tracking what matters.' })).not.toBeInTheDocument()
  })

  it('does not flash an empty state while the tracker records are still loading', async () => {
    let resolveTrackers!: (value: StoredTrackerDefinition[]) => void
    vi.spyOn(localRepository, 'listTrackers').mockImplementationOnce(() => new Promise((resolve) => { resolveTrackers = resolve }))
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(screen.getByRole('status')).toHaveTextContent('Loading today’s trackers')
    expect(screen.queryByRole('heading', { name: 'Start tracking what matters.' })).not.toBeInTheDocument()
    await act(async () => resolveTrackers([]))
    expect(await screen.findByRole('heading', { name: 'Start tracking what matters.' })).toBeInTheDocument()
  })

  it.each([320, 360, 390, 430, 768, 1280])('keeps the welcome state content-sized at %ipx', async (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    const welcome = await screen.findByRole('heading', { name: 'Start tracking what matters.' })
    expect(welcome.closest('.empty-state')).toHaveTextContent('Create your first tracker')
    expect(todayStyles).toMatch(/\.today-context-empty \.empty-state\s*\{\s*padding:\s*24px 20px/s)
    expect(todayStyles).toMatch(/@media\s*\(max-width:\s*360px\)[\s\S]*?\.today-context-empty \.empty-state\s*\{\s*padding:\s*22px 14px/s)
  })

  it('returns to Today with a creation toast when the first-time action opened the form', async () => {
    const user = userEvent.setup()
    render(<ToastProvider><MemoryRouter initialEntries={['/']}><Routes>
      <Route path="/" element={<TodayPage />} />
      <Route path="/trackers/new" element={<TrackerSetupPage />} />
    </Routes></MemoryRouter></ToastProvider>)
    await user.click(await screen.findByRole('link', { name: 'Create your first tracker' }))
    await user.type(await screen.findByRole('textbox', { name: 'What habit do you want to build?' }), 'Read every day')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('status', { name: /Tracker created/ })).toHaveTextContent('Your new tracker is ready.')
    expect(await screen.findByRole('button', { name: 'Open Read every day, Pending' })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toHaveLength(1)
  })

  it('keeps first-time users on the form and reports an error when tracker creation fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(localRepository, 'saveTracker').mockRejectedValueOnce(new Error('private storage detail'))
    render(<ToastProvider><MemoryRouter initialEntries={['/']}><Routes>
      <Route path="/" element={<TodayPage />} />
      <Route path="/trackers/new" element={<TrackerSetupPage />} />
    </Routes></MemoryRouter></ToastProvider>)
    await user.click(await screen.findByRole('link', { name: 'Create your first tracker' }))
    await user.type(await screen.findByRole('textbox', { name: 'What habit do you want to build?' }), 'Read every day')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    const failure = await screen.findByRole('alert', { name: 'Couldn’t create tracker' })
    expect(failure).toHaveTextContent('Your changes were not saved')
    expect(failure).not.toHaveTextContent('private storage detail')
    expect(screen.getByRole('textbox', { name: 'What habit do you want to build?' })).toHaveValue('Read every day')
    expect(screen.queryByRole('heading', { name: 'Start tracking what matters.' })).not.toBeInTheDocument()
  })

  it('labels an offline account check-in as device-saved while sync is pending', async () => {
    todayMocks.auth = { status: 'signed-in', user: { id: 'account-a' }, isOnline: false }
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<ToastProvider><MemoryRouter><TodayPage /></MemoryRouter></ToastProvider>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Pages' }), '1')
    await user.selectOptions(screen.getByLabelText(/Mood/), 'Focused')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))

    expect(await screen.findByText(/Saved on this device/)).toHaveTextContent('It will sync when your account is online.')
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled()
    expect(screen.queryByText(/Unsaved preview/)).not.toBeInTheDocument()
    expect(await localRepository.getTrackerEntry('today-tracker', today())).toMatchObject({ outcome: 'recorded', values: { pages: 1, 'field:mood': 'Focused' } })
  })

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
    render(<ToastProvider><MemoryRouter><TodayPage /></MemoryRouter></ToastProvider>)

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
    render(<ToastProvider><MemoryRouter><TodayPage /></MemoryRouter></ToastProvider>)

    expect(await screen.findByRole('heading', { name: 'Daily reading' })).toBeInTheDocument()
    const activityCard = screen.getByRole('button', { name: /Open Daily reading/ }).closest('.today-checkin-card')!
    expect(activityCard).toHaveClass('status-pending')
    expect(screen.getByRole('status', { name: 'Tracker: Pending' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open Daily reading, Pending' }))
    expect(screen.getByLabelText('Pages')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save check-in' })).toBeEnabled()
    expect(screen.queryByText(/Unsaved preview/)).not.toBeInTheDocument()
    const pagesInput = screen.getByLabelText('Pages')
    await user.click(screen.getByRole('button', { name: 'Increase Pages' }))
    expect(pagesInput).toHaveValue('1')
    expect(document.querySelector('.numeric-target-feedback')).toHaveTextContent('4 remaining · target 5')
    expect(document.querySelector('.checkin-draft-preview')).toHaveTextContent('Unsaved preview')
    await expect(localRepository.getTrackerEntry('today-tracker', today())).resolves.toBeUndefined()
    await user.clear(pagesInput)
    await user.type(pagesInput, '5')
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
    expect(await screen.findByText('The configured success rule is not met yet.')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled()
    expect(screen.queryByText(/Unsaved preview/)).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /Check-in updated/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Saved on this device/).closest('[role="status"]')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /Open Daily reading/ }).closest('.today-checkin-card')).toHaveClass('status-partial'))
  })

  it('shows Saved for unchanged values and returns to Saved when value and note edits are reverted', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    await localRepository.saveTrackerEntry({ trackerId: 'today-tracker', date: today(), outcome: 'recorded', values: { pages: 2, 'field:mood': 'Focused' }, note: 'Morning' })
    render(<ToastProvider><MemoryRouter><TodayPage /></MemoryRouter></ToastProvider>)
    await user.click(await screen.findByRole('button', { name: /Open Daily reading/ }))

    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled()
    expect(screen.queryByText(/Unsaved preview/)).not.toBeInTheDocument()
    const pages = screen.getByRole('spinbutton', { name: 'Pages' })
    await user.clear(pages)
    await user.type(pages, '3')
    expect(screen.getByRole('button', { name: 'Update check-in' })).toBeEnabled()
    expect(screen.getByText(/Unsaved preview/)).toBeInTheDocument()

    await user.clear(pages)
    await user.type(pages, '2')
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled()
    expect(screen.queryByText(/Unsaved preview/)).not.toBeInTheDocument()

    const summary = screen.getByText('Edit note')
    await user.click(summary)
    const note = screen.getByRole('textbox', { name: 'Note' })
    await user.clear(note)
    await user.type(note, 'Updated')
    expect(screen.getByRole('button', { name: 'Update check-in' })).toBeEnabled()
    await user.clear(note)
    await user.type(note, 'Morning')
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled()
  })

  it('cancels an unsaved draft without writing and keeps Cancel and Save side by side', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    const saveEntry = vi.spyOn(localRepository, 'saveTrackerEntry')
    render(<ToastProvider><MemoryRouter><TodayPage /></MemoryRouter></ToastProvider>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Pages' }), '4')

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const save = screen.getByRole('button', { name: 'Save check-in' })
    expect(cancel.parentElement).toHaveClass('today-primary-actions')
    expect(cancel.parentElement).toContainElement(save)
    expect(cancel).toHaveClass('button-secondary')
    expect(save).toHaveClass('button-primary')

    const confirm = vi.spyOn(window, 'confirm')
    await user.click(cancel)
    expect(screen.queryByRole('dialog', { name: 'Daily reading' })).not.toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
    expect(saveEntry).not.toHaveBeenCalled()
    await expect(localRepository.getTrackerEntry('today-tracker', today())).resolves.toBeUndefined()
  })

  it('blocks saving an unfinished numeric draft and leaves the stored check-in unchanged', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    const pages = screen.getByRole('spinbutton', { name: 'Pages' })
    await user.type(pages, '.')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('correct the highlighted number fields')
    await expect(localRepository.getTrackerEntry('today-tracker', today())).resolves.toBeUndefined()
    expect(pages).toHaveAttribute('aria-invalid', 'true')
  })

  it.each(['new', 'update'] as const)('keeps the %s check-in editor open with values intact when local saving fails', async (mode) => {
    const user = userEvent.setup()
    const existing = mode === 'update'
    await localRepository.saveTracker(tracker())
    if (existing) await localRepository.saveTrackerEntry({ trackerId: 'today-tracker', date: today(), outcome: 'recorded', values: { pages: 2, 'field:mood': 'Focused' }, note: '' })
    vi.spyOn(localRepository, 'saveTrackerEntry').mockRejectedValueOnce(new Error('private storage detail'))
    render(<ToastProvider><MemoryRouter><TodayPage /></MemoryRouter></ToastProvider>)

    await user.click(await screen.findByRole('button', { name: existing ? /Open Daily reading/ : 'Open Daily reading, Pending' }))
    const pages = screen.getByRole('spinbutton', { name: 'Pages' })
    if (!existing) {
      await user.type(pages, '3')
      await user.selectOptions(screen.getByLabelText(/Mood/), 'Focused')
    } else {
      await user.clear(pages)
      await user.type(pages, '4')
    }
    await user.click(screen.getByRole('button', { name: existing ? 'Update check-in' : 'Save check-in' }))

    expect(await screen.findByRole('alert', { name: existing ? 'Couldn’t update check-in' : 'Couldn’t save check-in' })).toHaveTextContent('Your changes were not saved')
    expect(screen.getByRole('dialog', { name: 'Daily reading' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Pages' })).toHaveValue(existing ? '4' : '3')
    expect(screen.queryByText('private storage detail')).not.toBeInTheDocument()
    expect(screen.getByRole('alert', { name: existing ? 'Couldn’t update check-in' : 'Couldn’t save check-in' })).toHaveTextContent('Please try again.')
    expect(screen.getByRole('button', { name: existing ? 'Update check-in' : 'Save check-in' })).toBeEnabled()
  })

  it('expands and collapses the note row without losing unsaved text', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    const noteDetails = screen.getByText('Add a note').closest('details')!
    const summary = screen.getByText('Add a note').closest('summary')!
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(noteDetails.querySelector('textarea')).toBeInTheDocument()
    await user.click(summary)
    await waitFor(() => expect(summary).toHaveAttribute('aria-expanded', 'true'))
    await user.type(screen.getByLabelText('Note'), 'Keep this draft')
    await user.click(summary)
    await waitFor(() => expect(summary).toHaveAttribute('aria-expanded', 'false'))
    await user.click(summary)
    expect(screen.getByLabelText('Note')).toHaveValue('Keep this draft')
    expect(todayStyles).toMatch(/\.today-note-details\s*>\s*summary::after[\s\S]*?display:\s*none/)
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
    const pattern = screen.getByRole('list', { name: 'Check-in pattern for the last seven days' })
    const currentDay = Array.from(pattern.querySelectorAll('[role="listitem"]')).find((item) => item.getAttribute('aria-label')?.endsWith(', today'))
    expect(currentDay).toHaveClass('today', 'today-date')
    expect(currentDay?.querySelector('[data-icon="status-pending"]')).toBeInTheDocument()
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
    expect(screen.getByRole('status', { name: 'Tracker: Completed' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Information about Daily reading daily requirements' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Completed\s*5/)
  })

  it('shows cumulative totals with a recalculated daily plan after check-in edits and deletion', async () => {
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
    expect(card.querySelector('.today-compact-metric')).toHaveTextContent('0 / 4 sessions')
    await user.click(screen.getByRole('button', { name: 'Open Daily DSA course, Pending' }))
    await user.type(screen.getByLabelText('Problems · sessions'), '3')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    await waitFor(() => expect(card.querySelector('.today-compact-metric')).toHaveTextContent('3 / 6 sessions'))
    const detailsButton = screen.getAllByRole('button', { name: 'Information about Daily DSA course daily requirements' }).at(-1)!
    await user.click(detailsButton)
    await waitFor(() => expect(detailsButton).toHaveAttribute('aria-expanded', 'true'))
    let dialog = screen.getAllByRole('dialog').at(-1)!
    expect(dialog).toHaveTextContent('Goal total10 sessions')
    expect(dialog).toHaveTextContent('Recorded toward goal3 sessions')
    expect(dialog).toHaveTextContent('Today’s planned amount6 sessions')
    expect(dialog).toHaveTextContent(/Next scheduled suggestion.*2 sessions/)
    expect(dialog).toHaveTextContent('Minimum2 sessions')
    expect(dialog).toHaveTextContent('Target threshold5 sessions')
    expect(dialog).toHaveTextContent('Stretch8 sessions')

    await user.click(screen.getByRole('button', { name: 'Close daily requirements' }))
    await user.clear(screen.getByLabelText('Problems · sessions'))
    await user.type(screen.getByLabelText('Problems · sessions'), '4')
    await user.click(screen.getByRole('button', { name: 'Update check-in' }))
    await waitFor(() => expect(card.querySelector('.today-compact-metric')).toHaveTextContent('4 / 6 sessions'))
    await user.click(screen.getAllByRole('button', { name: 'Information about Daily DSA course daily requirements' }).at(-1)!)
    dialog = screen.getAllByRole('dialog').at(-1)!
    expect(dialog).toHaveTextContent('Recorded toward goal4 sessions')

    await user.click(screen.getByRole('button', { name: 'Close daily requirements' }))
    const deleteEntry = vi.spyOn(localRepository, 'deleteTrackerEntry')
    await user.click(screen.getByRole('button', { name: 'Clear check-in' }))
    expect(screen.getByRole('alertdialog', { name: 'Clear this check-in?' })).toHaveTextContent('removes the saved check-in')
    expect(deleteEntry).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('alertdialog')).getByText('More details'))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('A deletion record is kept so account sync can apply the clear on other devices')
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(deleteEntry).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Clear check-in' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear check-in' }))
    await waitFor(() => expect(deleteEntry).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(card.querySelector('.today-compact-metric')).toHaveTextContent('0 / 4 sessions'))
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

  it('uses one contextual question for a binary tracker without a competing status panel', async () => {
    const user = userEvent.setup()
    const yesNo = {
      ...tracker(), id: 'yes-no-tracker', name: 'Daily meditation', customFields: [],
      metrics: [{ id: 'done', name: 'Meditated', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
    }
    await localRepository.saveTracker(yesNo)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily meditation, Pending' }))
    const dialog = screen.getByRole('dialog', { name: 'Daily meditation' })
    expect(dialog).toHaveTextContent('Did you complete this today?')
    expect(dialog).toHaveTextContent('Choose an option to record your progress.')
    expect(dialog).not.toHaveTextContent('Complete today')
    expect(dialog).not.toHaveTextContent('Not completed')
    expect(within(dialog).queryByRole('button', { name: /Information about .* daily requirements/ })).not.toBeInTheDocument()
    expect(todayStyles).toContain('max-height: min(760px, calc(100dvh - max(8px, env(safe-area-inset-top, 0px))')
    expect(todayStyles).toContain('env(safe-area-inset-bottom, 0px)')
    expect(todayStyles).toContain('overscroll-behavior: contain')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Daily meditation' })).not.toBeInTheDocument()
  })

  it('preserves a configured boolean label when the tracker also has nonbinary custom fields', async () => {
    const user = userEvent.setup()
    const mixed = {
      ...tracker(), id: 'mixed-input-tracker', name: 'Daily meditation',
      metrics: [{ id: 'done', name: 'Meditated', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
    }
    await localRepository.saveTracker(mixed)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily meditation, Pending' }))
    expect(screen.getByText('Meditated', { selector: 'legend' })).toBeInTheDocument()
    expect(screen.queryByText('Did you complete this today?')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Mood/)).toBeInTheDocument()
  })

  it('distinguishes an unanswered boolean measure from an explicitly false value', async () => {
    const yesNo = {
      ...tracker(), id: 'boolean-clarity-tracker', name: 'Daily meditation', customFields: [],
      metrics: [{ id: 'done', name: 'Completed', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
    }
    await localRepository.saveTracker(yesNo)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)

    expect(await screen.findByText('Unrecorded')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Tracker: Pending' })).toBeInTheDocument()
    expect(screen.queryByText('Not complete')).not.toBeInTheDocument()

    await localRepository.saveTrackerEntry({ trackerId: yesNo.id, date: today(), outcome: 'recorded', values: { done: false }, note: '' })
    act(() => publishWorkspaceDataChange(null))
    expect(await screen.findByText('Not complete')).toBeInTheDocument()
    expect(screen.queryByText('Unrecorded')).not.toBeInTheDocument()
  })

  it('uses saved binary state for contextual copy and shows a two-second success message only after saving', async () => {
    const user = userEvent.setup()
    const yesNo = {
      ...tracker(), id: 'binary-state-tracker', name: 'Daily meditation', customFields: [],
      metrics: [{ id: 'done', name: 'Meditated', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
    }
    await localRepository.saveTracker(yesNo)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily meditation, Pending' }))
    expect(screen.getByText('Did you complete this today?')).toBeInTheDocument()
    expect(screen.getByText('Choose an option to record your progress.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('Completed for today')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('Did you complete this today?')).toBeInTheDocument()
    expect(screen.queryByText('Nicely done!')).not.toBeInTheDocument()
    const timer = vi.spyOn(globalThis, 'setTimeout')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(await screen.findByText('Nicely done!')).toBeInTheDocument()
    expect(screen.getByText('Your check-in has been saved.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled()
    expect(await localRepository.getTrackerEntry(yesNo.id, today())).toMatchObject({ outcome: 'recorded', values: { done: true } })
    expect(timer.mock.calls.some(([, delay]) => delay === 2000)).toBe(true)
    await waitFor(() => expect(screen.queryByText('Nicely done!')).not.toBeInTheDocument(), { timeout: 2500 })
    expect(screen.getByText('Completed for today')).toBeInTheDocument()
    expect(screen.getByText('Your check-in is saved.')).toBeInTheDocument()
  })

  it('explains unavailable clearing without disabling the action or changing saved data', async () => {
    const user = userEvent.setup()
    const yesNo = { ...tracker(), customFields: [], metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }], qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true } }
    await localRepository.saveTracker(yesNo)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    const clear = screen.getByRole('button', { name: 'Clear check-in' })
    expect(clear).toHaveAttribute('aria-disabled', 'true')
    expect(clear).not.toBeDisabled()
    await user.click(clear)
    expect(screen.getByText('Nothing to clear')).toBeInTheDocument()
    expect(screen.getByText('No check-in has been saved for this day yet.')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('Nothing to clear')).not.toBeInTheDocument()
    await expect(localRepository.getTrackerEntry(yesNo.id, today())).resolves.toBeUndefined()
  })

  it('keeps saved Not done distinct from edits and gives intentional skips their own permanent state', async () => {
    const user = userEvent.setup()
    const yesNo = {
      ...tracker(), id: 'binary-state-tracker', customFields: [],
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
    }
    await localRepository.saveTracker(yesNo)
    await localRepository.saveTrackerEntry({ trackerId: yesNo.id, date: today(), outcome: 'recorded', values: { done: false }, note: '' })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, No progress' }))
    expect(screen.getByText('Not completed today')).toBeInTheDocument()
    expect(screen.getByText('Your check-in is saved.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Not done' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('Not completed today')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update check-in' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, No progress' }))
    await user.click(screen.getByRole('button', { name: 'Skip day' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Skip this day?' })
    expect(dialog).toHaveTextContent('On a required opportunity, it will not qualify toward your streak.')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm skip' }))
    expect(await screen.findByText('Day marked as skipped')).toBeInTheDocument()
    expect(screen.getByText('Your skip has been recorded.')).toBeInTheDocument()
    expect(screen.queryByText('Nicely done!')).not.toBeInTheDocument()
    expect(screen.queryByText(/Unsaved preview/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update check-in' })).not.toBeInTheDocument()
    expect(await localRepository.getTrackerEntry(yesNo.id, today())).toMatchObject({ outcome: 'skipped' })
  })

  it('uses neutral save feedback for a newly saved Not done answer', async () => {
    const user = userEvent.setup()
    const yesNo = {
      ...tracker(), id: 'binary-state-tracker', customFields: [],
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
    }
    await localRepository.saveTracker(yesNo)
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    await user.click(screen.getByRole('button', { name: 'Not done' }))
    expect(screen.getByText('Did you complete this today?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(await screen.findByText('Check-in saved')).toBeInTheDocument()
    expect(screen.getByText('Your progress has been recorded.')).toBeInTheDocument()
    expect(screen.queryByText('Nicely done!')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Check-in saved')).not.toBeInTheDocument(), { timeout: 2500 })
    expect(screen.getByText('Not completed today')).toBeInTheDocument()
    expect(screen.getByText('Your check-in is saved.')).toBeInTheDocument()
  })

  it('does not show binary success feedback when saving fails and lets the user retry', async () => {
    const user = userEvent.setup()
    const yesNo = {
      ...tracker(), id: 'binary-state-tracker', customFields: [],
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
    }
    await localRepository.saveTracker(yesNo)
    vi.spyOn(localRepository, 'saveTrackerEntry').mockRejectedValueOnce(new Error('storage unavailable'))
    render(<ToastProvider><MemoryRouter><TodayPage /></MemoryRouter></ToastProvider>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Pending' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(await screen.findByRole('alert', { name: 'Couldn’t save check-in' })).toBeInTheDocument()
    expect(screen.getByText('Did you complete this today?')).toBeInTheDocument()
    expect(screen.queryByText('Nicely done!')).not.toBeInTheDocument()
    expect(await localRepository.getTrackerEntry(yesNo.id, today())).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(await screen.findByText('Nicely done!')).toBeInTheDocument()
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
    expect(todayStyles).toMatch(/\.today-primary-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s)
    expect(todayStyles).toMatch(/\.today-primary-actions > \.button\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s)
    expect(todayStyles).toMatch(/\.today-requirements-content\s*\{[^}]*overflow-y:\s*auto/s)
    expect(todayStyles).toMatch(/\.today-requirements-heading\s*\{[^}]*flex:\s*0 0 auto/s)
    expect(todayStyles).toMatch(/\.today-requirements-trigger\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s)
    expect(todayStyles).toMatch(/\.today-requirements-trigger span\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/s)
    expect(todayStyles).toContain('max-height: min(850px, calc(100dvh - max(12px, env(safe-area-inset-top, 0px))')
    expect(todayStyles).toContain('env(safe-area-inset-top, 0px)')
    expect(todayStyles).toContain('-webkit-overflow-scrolling: touch')
    expect(todayStyles).toContain('overflow-wrap: anywhere')
    expect(todayStyles).toMatch(/\.today-detail-backdrop\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*1400/s)
    expect(todayStyles).toMatch(/details:not\(\.mobile-more\)\[open\] > summary::after\s*\{[^}]*rotate\(225deg\)/s)
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
    expect(backdrop).toHaveClass('modal-backdrop')
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

  it('filters unscheduled trackers and marks a scheduled commitment missed without breaking stored-outcome compatibility', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker({ ...tracker({ kind: 'none' }), customFields: [] })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Open Daily reading, Rest day' })).toBeInTheDocument()

    await db.trackers.put({ ...tracker(), customFields: [] })
    cleanup()
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await screen.findByRole('heading', { name: 'Daily reading' })
    await user.click(screen.getByRole('button', { name: 'Open Daily reading, Pending' }))
    await user.click(await screen.findByRole('button', { name: 'Skip day' }))
    const skipDialog = screen.getByRole('alertdialog', { name: 'Skip this day?' })
    expect(skipDialog).toHaveTextContent('intentional skip')
    expect(await localRepository.getTrackerEntry('today-tracker', today())).toBeUndefined()
    expect(within(skipDialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(document.querySelector('.checkin-confirm-backdrop')!)
    expect(screen.getByRole('alertdialog', { name: 'Skip this day?' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog', { name: 'Skip this day?' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip day' })).toHaveFocus()
    expect(await localRepository.getTrackerEntry('today-tracker', today())).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Skip day' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm skip' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Daily reading, Skipped' })).toBeInTheDocument())
    expect(screen.getByRole('region', { name: 'Today at a glance' })).toHaveTextContent('1 skipped')
    expect(await localRepository.getTrackerEntry('today-tracker', today())).toMatchObject({ outcome: 'skipped' })
    await user.click(screen.getByRole('button', { name: 'Open Daily reading, Skipped' }))
    expect(screen.getByText(/intentionally skipped/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Pages'), '3')
    await user.click(screen.getByRole('button', { name: 'Save check-in' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Daily reading, Partial' })).toBeInTheDocument())
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

  it('opens rest-day cards and offers a voluntary check-in without changing the rest-day status', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker({ kind: 'none' }))
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Open Daily reading, Rest day' }))
    expect(await screen.findByRole('dialog', { name: 'Daily reading' })).toBeInTheDocument()
    expect(screen.getByText(/Voluntary check-in · this stays a holiday or rest day/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save check-in' })).toBeInTheDocument()
  })

  it('shows holiday cards and allows voluntary progress while preserving Holiday status', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(tracker())
    await localRepository.saveAccountHolidays([today()], 'personal')
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByText('Today is a holiday')).toBeInTheDocument()
    const open = await screen.findByRole('button', { name: 'Open Daily reading, Holiday' })
    expect(open.closest('.today-checkin-card')).toHaveClass('status-holiday')
    await user.click(open)
    expect(await screen.findByRole('dialog', { name: 'Daily reading' })).toBeInTheDocument()
    expect(screen.getByText(/Voluntary check-in · this stays a holiday or rest day/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save check-in' })).toBeInTheDocument()
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

  it('includes unrecorded Strict Mode rest days and holidays in the recent missed list', async () => {
    const user = userEvent.setup()
    const yesterday = new Date(Date.parse(`${today()}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10) as `${number}-${number}-${number}`
    await localRepository.saveTracker({ ...tracker({ kind: 'none' }), customFields: [], strictMode: true })
    await localRepository.saveAccountHolidays([yesterday], 'personal')
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    await user.click(await screen.findByText(/Missed opportunities in the last week/))
    expect(await screen.findByRole('button', { name: `Open Daily reading, Missed, ${calendarDateLabel(yesterday)}` })).toBeInTheDocument()
  })

  it('shows only scheduled work in the at-a-glance progress summary', async () => {
    const scheduled = tracker()
    await localRepository.saveTracker(scheduled)
    await localRepository.saveTracker({ ...tracker({ kind: 'none' }), id: 'flexible', name: 'Flexible work' })
    render(<MemoryRouter><TodayPage /></MemoryRouter>)
    expect(await screen.findByRole('region', { name: 'Today at a glance' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Today at a glance' })).toHaveTextContent('0 of 1 checked in')
    expect(screen.getByRole('img', { name: '0 of 1 scheduled activities met their success rule' })).toBeInTheDocument()
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
    expect(await screen.findByRole('link', { name: 'Create your first tracker' })).toBeInTheDocument()
  })
})
