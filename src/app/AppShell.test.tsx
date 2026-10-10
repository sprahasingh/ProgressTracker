import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { db } from '../db/database'
import { localRepository } from '../db/localRepository'
import { TodayPage } from '../features/today/TodayPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { HistoryPage } from '../features/history/HistoryPage'
import { AppShell, getAvatarInitial } from './AppShell'

const guestReadyState = { status: 'local-only' as string, workspaceStatus: 'ready', workspaceUserId: null }
const authState = vi.hoisted(() => ({ value: { status: 'local-only' as string, workspaceStatus: 'ready', workspaceUserId: null } }))
vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => authState.value }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); authState.value = guestReadyState; await db.delete() })

describe('app navigation quality', () => {
  it('selects a normalized initial from display name, then email, then no initial', () => {
    expect(getAvatarInitial({ user_metadata: { full_name: '  Spraha Singh ' }, email: 'other@example.com' })).toBe('S')
    expect(getAvatarInitial({ user_metadata: { name: ' alex ' } })).toBe('A')
    expect(getAvatarInitial({ email: ' example@gmail.com ' })).toBe('E')
    expect(getAvatarInitial({ user_metadata: { display_name: '   ' }, email: ' ' })).toBeNull()
    expect(getAvatarInitial(null)).toBeNull()
  })

  it('renders the current account initial or an accessible generic icon', () => {
    authState.value = { ...guestReadyState, status: 'signed-in', user: { id: 'user-a', email: 'a@example.com', user_metadata: { display_name: ' Alex ' } } } as never
    const view = render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route><Route path="/auth" element={<p>Account</p>} /></Routes></MemoryRouter>)
    const avatar = screen.getByRole('link', { name: 'Open profile settings' })
    expect(avatar).toHaveTextContent('A')
    expect(avatar.querySelector('svg')).toBeNull()

    authState.value = { ...guestReadyState, status: 'signed-in', user: { id: 'user-b', email: ' b@example.com ' } } as never
    view.rerender(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route><Route path="/auth" element={<p>Account</p>} /></Routes></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Open profile settings' })).toHaveTextContent('B')

    authState.value = guestReadyState
    view.rerender(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route><Route path="/auth" element={<p>Account</p>} /></Routes></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Open account and sign-in' }).querySelector('svg')).toBeInTheDocument()
    authState.value = guestReadyState
  })

  it('keeps sync, notifications, and the keyboard-accessible avatar in the specified header order', async () => {
    authState.value = { ...guestReadyState, status: 'signed-in', user: { id: 'user-a', email: 'a@example.com' }, syncStatus: 'complete' } as never
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route><Route path="/settings" element={<p>Settings</p>} /></Routes></MemoryRouter>)
    const avatar = screen.getByRole('link', { name: 'Open profile settings' })
    expect(avatar.previousElementSibling).toHaveClass('notification-center')
    expect(avatar.previousElementSibling?.previousElementSibling).toHaveClass('topbar-sync-state')
    expect(avatar).toHaveAttribute('href', '/settings#personal-information')
    expect(avatar.tabIndex).toBe(0)
    avatar.focus()
    expect(avatar).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Settings')).toBeInTheDocument()
    authState.value = guestReadyState
  })

  it('uses vector icons for primary navigation consistently in desktop and mobile navigation', () => {
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route></Routes></MemoryRouter>)
    const iconByDestination = { Today: 'today', Trackers: 'trackers', Calendar: 'calendar', Insights: 'insights' }
    for (const name of ['Primary navigation', 'Mobile navigation']) {
      const nav = screen.getByRole('navigation', { name })
      for (const [label, icon] of Object.entries(iconByDestination)) {
        const link = within(nav).getByRole('link', { name: new RegExp(label) })
        expect(link.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 24')
        expect(link.querySelector('svg')).toHaveAttribute('data-icon', icon)
        expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      }
    }
  })

  it('does not render route content until the signed-in account workspace is active', () => {
    authState.value = { status: 'signed-in', user: { id: 'user-b', email: 'b@example.com' }, passwordRecovery: false, workspaceStatus: 'loading', workspaceUserId: 'user-a' } as never
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Account private content</p>} /></Route></Routes></MemoryRouter>)
    expect(screen.getByRole('status', { name: 'Preparing your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Account private content')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Mobile navigation' })).toBeInTheDocument()
    expect(screen.queryByText('Opening your workspace')).not.toBeInTheDocument()
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
    for (const link of syncLinks) expect(link).toHaveAttribute('href', '/settings#sync-data')
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
    expect(await screen.findByRole('heading', { name: 'Start tracking what matters.' })).toBeInTheDocument()

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
    expect(within(mobileNav).getByRole('menuitem', { name: 'Holidays & breaks' })).toHaveAttribute('href', '/holidays')
    expect(within(mobileNav).getByRole('menuitem', { name: 'Bin' })).toHaveAttribute('href', '/bin')
    expect(within(mobileNav).getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings')
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

  it('dismisses the More menu on outside pointer, toggle, Escape, and route selection', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today screen</p>} /></Route><Route path="/settings" element={<p>Settings screen</p>} /></Routes></MemoryRouter>)
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' })
    const trigger = within(nav).getByRole('button', { name: 'More destinations' })
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowDown}')
    expect(within(nav).getByRole('menuitem', { name: 'Holidays & breaks' })).toHaveFocus()
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    await user.click(screen.getByRole('navigation', { name: 'Primary navigation' }))
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    await user.click(within(nav).getByRole('menuitem', { name: 'Settings' }))
    expect(await screen.findByText('Settings screen')).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })
})
