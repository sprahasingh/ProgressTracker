import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { ToastProvider } from '../../components/ui/ToastProvider'
import { activateWorkspace, db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { HolidaysPage } from './HolidaysPage'
import { TodayPage } from '../today/TodayPage'
import { TrackerLibraryPage } from '../trackers/TrackerLibraryPage'
import { CalendarPage } from '../calendar/CalendarPage'

const auth = vi.hoisted(() => ({
  ownerId: 'holiday-scheduling-account-a',
  syncNow: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    status: 'signed-in', user: { id: auth.ownerId }, workspaceStatus: 'ready',
    workspaceUserId: auth.ownerId, sessionTransitionPending: false,
    isOnline: true, syncStatus: 'complete', syncNow: auth.syncNow,
    enterCloudRecovery: vi.fn(),
  }),
}))

vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))

const DAY_MS = 86_400_000
function shift(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}
function today() { return new Date().toISOString().slice(0, 10) }
function deadlineTracker(ownerId: string): StoredTrackerDefinition {
  const date = today()
  const startDate = shift(date, -8)
  const deadline = shift(startDate, 91)
  const scheduling = { mode: 'effective' as const, effectiveDays: 92, effectiveDayCounting: 'planned-activity-days' as const, planningTimeZone: 'UTC' }
  return {
    schemaVersion: 10, id: `${ownerId}-92-day`, name: '92 Day DSA', description: '', kind: 'challenge',
    status: 'active', categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' },
    startDate, deadline, scheduling,
    metrics: [], customFields: [], milestones: [], createdAt: `${startDate}T00:00:00.000Z`,
    updatedAt: `${startDate}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    ruleVersions: [{ id: `${ownerId}-baseline`, effectiveFrom: startDate, revision: 1, application: 'baseline', recordedAt: `${startDate}T00:00:00.000Z`, evaluation: {
      schedule: { kind: 'every-day' }, startDate, deadline, scheduling, metrics: [], strictMode: false,
    } }],
  }
}

function RoutedPages({ date }: { date: string }) {
  return <>
    <nav><Link to="/">Today test route</Link><Link to="/trackers">Trackers test route</Link><Link to="/calendar">Calendar test route</Link><Link to={`/holidays?date=${date}`}>Manage holidays</Link></nav>
    <Routes>
      <Route path="/" element={<TodayPage />} />
      <Route path="/trackers" element={<TrackerLibraryPage />} />
      <Route path="/calendar" element={<CalendarPage />} />
      <Route path="/holidays" element={<HolidaysPage />} />
    </Routes>
  </>
}

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  db.close()
  await db.delete()
  auth.ownerId = 'holiday-scheduling-account-a'
  auth.syncNow = vi.fn().mockResolvedValue(undefined)
})

describe('effective scheduling through the holiday UI', () => {
  it.each([
    ['holiday-scheduling-account-a', 'global'],
    ['holiday-scheduling-account-b', 'selected'],
  ] as const)('keeps holiday scope isolated for %s (%s)', async (ownerId, scope) => {
    vi.stubEnv('PROD', true)
    auth.ownerId = ownerId!
    await activateWorkspace(ownerId!)
    await localRepository.setTimeZone('UTC', ownerId!)
    const tracker = deadlineTracker(ownerId!)
    await db.trackers.put(tracker)
    const listTrackers = vi.spyOn(localRepository, 'listTrackers')

    const user = userEvent.setup()
    const route = () => render(<ToastProvider><MemoryRouter initialEntries={['/']}><RoutedPages date={today()} /></MemoryRouter></ToastProvider>)
    const firstLoad = route()
    expect(await screen.findByText('Day 9 of 92')).toBeInTheDocument()
    expect(screen.queryByText(/saved schedule could not be used to calculate a deadline/i)).not.toBeInTheDocument()
    await expect(localRepository.listTrackers()).resolves.toMatchObject([{ id: tracker.id, deadline: shift(tracker.startDate!, 91) }])

    await user.click(screen.getByRole('link', { name: 'Manage holidays' }))
    await screen.findByRole('heading', { name: /Holidays & Breaks/ })
    if (scope === 'selected') {
      await user.click(screen.getByRole('radio', { name: 'Selected trackers' }))
      await user.click(screen.getByLabelText(tracker.name))
    }
    const trackerReadsBeforeMark = listTrackers.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Mark holiday' }))
    if (scope === 'global') {
      await waitFor(async () => {
        await expect(localRepository.listAccountHolidays()).resolves.toMatchObject([{ date: today(), deletedAt: null }])
      })
      await expect(localRepository.listTrackerHolidays()).resolves.toEqual([])
      await expect(localRepository.listTrackers()).resolves.toMatchObject([{ id: tracker.id, deadline: shift(tracker.startDate!, 92) }])
    } else {
      await waitFor(async () => {
        await expect(localRepository.listTrackerHolidays()).resolves.toMatchObject([{ trackerId: tracker.id, date: today(), deletedAt: null }])
      })
      await expect(localRepository.listAccountHolidays()).resolves.toEqual([])
      await expect(localRepository.listTrackers()).resolves.toMatchObject([{ id: tracker.id, deadline: shift(tracker.startDate!, 92) }])
    }
    await waitFor(() => expect(listTrackers.mock.calls.length).toBeGreaterThan(trackerReadsBeforeMark))
    // One page refresh plus the explicit repository assertion below.
    expect(listTrackers).toHaveBeenCalledTimes(trackerReadsBeforeMark + 2)
    expect(auth.syncNow).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('link', { name: 'Trackers test route' }))
    await screen.findByRole('heading', { name: /Trackers & Goals/ })
    expect(await screen.findByText('Holiday · next is Day 9')).toBeInTheDocument()
    expect(screen.queryByText(/saved schedule could not be used to calculate a deadline/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Calendar test route' }))
    await screen.findByRole('heading', { name: /^Calendar/ })
    expect(await screen.findByText(/Holiday · next is Day 9/)).toBeInTheDocument()
    expect(screen.queryByText(/saved schedule could not be calculated/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Today test route' }))
    expect(await screen.findByText('Holiday · next is Day 9')).toBeInTheDocument()
    expect(screen.queryByText(/saved schedule could not be used to calculate a deadline/i)).not.toBeInTheDocument()

    firstLoad.unmount()
    const reloaded = route()
    expect(await screen.findByText('Holiday · next is Day 9')).toBeInTheDocument()
    expect(screen.queryByText(/saved schedule could not be used to calculate a deadline/i)).not.toBeInTheDocument()
    await expect(localRepository.listTrackers()).resolves.toMatchObject([{ id: tracker.id, deadline: shift(tracker.startDate!, 92) }])
    reloaded.unmount()
  })
})
