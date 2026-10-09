import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { db } from '../db/database'
import { localRepository } from '../db/localRepository'
import { TodayPage } from '../features/today/TodayPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { HistoryPage } from '../features/history/HistoryPage'
import { AppShell } from './AppShell'

const guestReadyState = { status: 'local-only' as string, workspaceStatus: 'ready', workspaceUserId: null }
const authState = vi.hoisted(() => ({ value: { status: 'local-only' as string, workspaceStatus: 'ready', workspaceUserId: null } }))
vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => authState.value }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); authState.value = guestReadyState; await db.delete() })

describe('app navigation quality', () => {
  it('does not render route content until the signed-in account workspace is active', () => {
    authState.value = { status: 'signed-in', user: { id: 'user-b', email: 'b@example.com' }, passwordRecovery: false, workspaceStatus: 'loading', workspaceUserId: 'user-a' } as never
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Account private content</p>} /></Route></Routes></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Opening your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Account private content')).not.toBeInTheDocument()
    authState.value = guestReadyState
  })

  it('asks before copying guest progress into an authenticated workspace', async () => {
    const chooseGuestData = vi.fn()
    authState.value = { status: 'signed-in', user: { id: 'user-a', email: 'a@example.com' }, passwordRecovery: false, workspaceStatus: 'needs-guest-choice', workspaceUserId: 'user-a', guestSummary: { hasData: true, counts: { trackers: 2 } }, chooseGuestData } as never
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Private records</p>} /></Route></Routes></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'You have progress saved as a guest' })).toBeInTheDocument()
    expect(screen.queryByText('Private records')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep guest progress separate' }))
    expect(chooseGuestData).toHaveBeenCalledWith('kept-separate')
    authState.value = guestReadyState
  })

  it('makes account sync health visible and links it to account recovery controls', () => {
    authState.value = { status: 'signed-in', user: { id: 'user-a', email: 'a@example.com' }, passwordRecovery: false, workspaceStatus: 'ready', workspaceUserId: 'user-a', syncStatus: 'error', isOnline: true } as never
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today workspace</p>} /></Route></Routes></MemoryRouter>)

    const syncLinks = screen.getAllByRole('link', { name: /Sync needs attention/ })
    expect(syncLinks).toHaveLength(2)
    for (const link of syncLinks) expect(link).toHaveAttribute('href', '/auth')
    authState.value = guestReadyState
  })

  it('offers a collision-safe guest copy choice', async () => {
    const chooseGuestData = vi.fn()
    authState.value = { status: 'signed-in', user: { id: 'user-a', email: 'a@example.com' }, passwordRecovery: false, workspaceStatus: 'needs-guest-choice', workspaceUserId: 'user-a', guestSummary: { hasData: true, counts: { trackers: 1 } }, chooseGuestData } as never
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Private records</p>} /></Route></Routes></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: 'Copy and keep both if IDs overlap' }))
    expect(chooseGuestData).toHaveBeenCalledWith('imported-as-copies')
    authState.value = guestReadyState
  })

  it('supports keyboard skip-to-content and moves between the real Today, Overview, and History routes', async () => {
    vi.spyOn(localRepository, 'getAppSettings').mockResolvedValue({
      id: 'general', timezone: 'UTC', appearance: 'system', backupReminderDays: null,
      updatedAt: '2026-10-09T00:00:00.000Z',
    })
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}>
      <Route index element={<TodayPage />} />
      <Route path="dashboard" element={<DashboardPage />} />
      <Route path="history" element={<HistoryPage />} />
    </Route></Routes></MemoryRouter>)

    expect(await screen.findByText('Loading today’s trackers…')).toBeInTheDocument()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(document.activeElement).toHaveAttribute('id', 'main-content')
    expect(await screen.findByText('Nothing scheduled today')).toBeInTheDocument()

    const desktopNav = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(within(desktopNav).getAllByRole('link')).toHaveLength(4)
    expect(within(desktopNav).getByRole('link', { name: 'Trackers' })).toHaveAttribute('href', '/trackers')
    expect(within(desktopNav).getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar')
    const moreNav = screen.getByLabelText('Main navigation')
    await user.click(within(moreNav).getByRole('link', { name: 'Insights' }))
    expect(await screen.findByText('Your overview starts with a tracker')).toBeInTheDocument()

    const mobileNav = screen.getByRole('navigation', { name: 'Mobile navigation' })
    expect(within(mobileNav).getByRole('link', { name: /Insights/ })).toHaveAttribute('href', '/dashboard')
    expect(within(mobileNav).getByRole('link', { name: /Trackers/ })).toHaveAttribute('href', '/trackers')
    expect(screen.getByRole('navigation', { name: 'Insights sections' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Insights sections' })).getByRole('link', { name: 'History' })).toHaveAttribute('href', '/history')
    await user.click(within(mobileNav).getByLabelText('More destinations'))
    expect(within(mobileNav).getByRole('link', { name: 'Holidays & breaks' })).toHaveAttribute('href', '/holidays')
    expect(within(mobileNav).getByRole('link', { name: 'Bin' })).toHaveAttribute('href', '/bin')
    expect(within(mobileNav).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    await user.click(within(screen.getByRole('navigation', { name: 'Insights sections' })).getByRole('link', { name: 'History' }))
    expect(await screen.findByText('No check-ins in this range')).toBeInTheDocument()
  })

  it('keeps the desktop sidebar scroll region and bottom actions inside the viewport layout', () => {
    render(<MemoryRouter initialEntries={['/calendar']}><Routes><Route path="/" element={<AppShell />}><Route path="calendar" element={<p>Calendar workspace</p>} /></Route></Routes></MemoryRouter>)
    const sidebar = screen.getByLabelText('Main navigation')
    const scrollRegion = sidebar.querySelector('.sidebar-scroll')
    expect(scrollRegion).not.toBeNull()
    expect(scrollRegion?.contains(sidebar.querySelector('.brand'))).toBe(false)
    expect(scrollRegion?.querySelector('.sync-state')).not.toBeNull()
    expect(within(sidebar).getByRole('link', { name: 'Holidays & breaks' })).toHaveAttribute('href', '/holidays')
    expect(within(sidebar).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    expect(within(sidebar).getByRole('link', { name: 'Bin' })).toHaveAttribute('href', '/bin')
    expect(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getAllByRole('link')).toHaveLength(4)
    expect(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('link', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('navigation', { name: 'Primary navigation' }).querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })
})
