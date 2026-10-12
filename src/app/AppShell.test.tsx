import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { db } from '../db/database'
import { localRepository } from '../db/localRepository'
import appStyles from '../styles.css?raw'
import { TodayPage } from '../features/today/TodayPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { HistoryPage } from '../features/history/HistoryPage'
import { AppShell, getAvatarInitial } from './AppShell'

const guestReadyState = { status: 'local-only' as string, workspaceStatus: 'ready', workspaceUserId: null }
const authState = vi.hoisted(() => ({ value: { status: 'local-only' as string, workspaceStatus: 'ready', workspaceUserId: null } }))
const maintainerState = vi.hoisted(() => ({ value: 'denied' as string }))
let injectedStylesheet: HTMLStyleElement | null = null
vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => authState.value }))
vi.mock('../features/ai-knowledge/useMaintainerAccess', () => ({ useMaintainerAccess: () => ({ status: maintainerState.value }) }))

afterEach(async () => { cleanup(); injectedStylesheet?.remove(); injectedStylesheet = null; vi.restoreAllMocks(); authState.value = guestReadyState; maintainerState.value = 'denied'; await db.delete() })

function injectApplicationStyles() {
  injectedStylesheet = document.createElement('style')
  injectedStylesheet.textContent = appStyles
  document.head.append(injectedStylesheet)
}

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
    expect(avatar.previousElementSibling?.previousElementSibling).toHaveClass('ai-help-trigger')
    expect(avatar.previousElementSibling?.previousElementSibling?.previousElementSibling).toHaveClass('topbar-sync-state')
    expect(avatar).toHaveAttribute('href', '/settings#personal-information')
    expect(avatar.tabIndex).toBe(0)
    avatar.focus()
    expect(avatar).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Settings')).toBeInTheDocument()
    authState.value = guestReadyState
  })

  it('uses neutral inactive primary navigation and matching orange active icon and label colors', () => {
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route></Routes></MemoryRouter>)
    injectApplicationStyles()
    const iconByDestination = { Today: 'today', Trackers: 'trackers', Calendar: 'calendar', Insights: 'insights' } as const
    for (const name of ['Primary navigation', 'Mobile navigation']) {
      const nav = name === 'Mobile navigation' ? document.querySelector('nav.mobile-nav') as HTMLElement : screen.getByRole('navigation', { name })
      for (const [label, icon] of Object.entries(iconByDestination)) {
        const link = within(nav).getByRole('link', { name: new RegExp(label), hidden: true })
        const svg = link.querySelector('svg')!
        expect(svg).toHaveAttribute('viewBox', '0 0 24 24')
        expect(svg).toHaveAttribute('data-icon', icon)
        expect(svg).toHaveAttribute('aria-hidden', 'true')
        expect(svg.getAttribute('style')).toBeNull()
        expect(window.getComputedStyle(svg).color).toBe(window.getComputedStyle(link).color)
        expect(window.getComputedStyle(svg).stroke.toLowerCase()).toBe('currentcolor')
        if (label === 'Today') {
          expect(link).toHaveAttribute('aria-current', 'page')
          expect(window.getComputedStyle(link).color).toBe('var(--accent-strong)')
        } else {
          expect(window.getComputedStyle(link).color).not.toBe('var(--accent-strong)')
        }
      }
    }
    const desktop = screen.getByRole('navigation', { name: 'Primary navigation' })
    const mobile = document.querySelector('nav.mobile-nav') as HTMLElement
    const previousTheme = document.documentElement.getAttribute('data-theme')
    for (const theme of ['light', 'dark']) {
      document.documentElement.setAttribute('data-theme', theme)
      for (const label of Object.keys(iconByDestination)) {
        const desktopLink = within(desktop).getByRole('link', { name: new RegExp(label), hidden: true })
        const mobileLink = within(mobile).getByRole('link', { name: new RegExp(label), hidden: true })
        expect(window.getComputedStyle(desktopLink).color).toBe(window.getComputedStyle(mobileLink).color)
        expect(window.getComputedStyle(desktopLink.querySelector('svg')!).color).toBe(window.getComputedStyle(desktopLink).color)
        expect(window.getComputedStyle(mobileLink.querySelector('svg')!).color).toBe(window.getComputedStyle(mobileLink).color)
      }
    }
    if (previousTheme) document.documentElement.setAttribute('data-theme', previousTheme)
    else document.documentElement.removeAttribute('data-theme')
  })

  it('shares the required More destination order, icons, and selected route state across navigation layouts', async () => {
    injectApplicationStyles()
    authState.value = { ...guestReadyState, status: 'signed-in', user: { id: 'user-a', email: 'a@example.com' } } as never
    maintainerState.value = 'authorized'
    render(<MemoryRouter initialEntries={['/settings/privacy']}><Routes><Route path="/" element={<AppShell />}><Route path="settings/*" element={<p>Settings workspace</p>} /></Route></Routes></MemoryRouter>)

    const desktopMore = screen.getByRole('navigation', { name: 'More destinations' })
    expect(within(desktopMore).getAllByRole('link').map((link) => link.textContent)).toEqual(['Holidays & breaks', 'Settings', 'Bin', 'AI Knowledge'])
    expect(within(desktopMore).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')

    const mobileNav = document.querySelector('nav.mobile-nav') as HTMLElement
    const moreTrigger = within(mobileNav).getByRole('button', { name: 'More destinations', hidden: true })
    expect(moreTrigger).toHaveAttribute('aria-current', 'page')
    fireEvent.click(moreTrigger)
    const items = within(mobileNav).getAllByRole('menuitem', { hidden: true })
    expect(items.map((item) => item.textContent)).toEqual(['Holidays & breaks', 'Settings', 'Bin', 'AI Knowledge'])
    expect(within(mobileNav).getByRole('menuitem', { name: 'Settings', hidden: true })).toHaveAttribute('aria-current', 'page')
    for (const [label, icon] of [['Holidays & breaks', 'holiday'], ['Settings', 'settings'], ['Bin', 'bin'], ['AI Knowledge', 'spark']] as const) {
      expect(within(mobileNav).getByRole('menuitem', { name: label, hidden: true }).querySelector('svg')).toHaveAttribute('data-icon', icon)
    }
    for (const label of ['Holidays & breaks', 'Settings', 'Bin', 'AI Knowledge']) {
      const desktopIcon = within(desktopMore).getByRole('link', { name: label }).querySelector('svg')
      const mobileIcon = within(mobileNav).getByRole('menuitem', { name: label, hidden: true }).querySelector('svg')
      const desktopLink = within(desktopMore).getByRole('link', { name: label })
      const mobileItem = within(mobileNav).getByRole('menuitem', { name: label, hidden: true })
      expect(desktopIcon?.getAttribute('style')).toBeNull()
      expect(mobileIcon?.getAttribute('style')).toBeNull()
      expect(window.getComputedStyle(desktopIcon!).color).toBe(window.getComputedStyle(desktopLink).color)
      expect(window.getComputedStyle(mobileIcon!).color).toBe(window.getComputedStyle(mobileItem).color)
      expect(window.getComputedStyle(desktopIcon!).color).toBe(window.getComputedStyle(mobileIcon!).color)
      if (label === 'Settings') {
        expect(desktopLink).toHaveAttribute('aria-current', 'page')
        expect(mobileItem).toHaveAttribute('aria-current', 'page')
        expect(window.getComputedStyle(desktopLink).color).toBe('var(--accent-strong)')
      } else {
        expect(window.getComputedStyle(desktopLink).color).not.toBe('var(--accent-strong)')
      }
    }
    expect(window.getComputedStyle(moreTrigger).color).toBe('var(--accent-strong)')
  })

  it('applies the selected orange state to each of the eight destinations in both navigation layouts', () => {
    injectApplicationStyles()
    authState.value = { ...guestReadyState, status: 'signed-in', user: { id: 'user-a', email: 'a@example.com' } } as never
    maintainerState.value = 'authorized'
    const destinations = [
      ['Today', '/', 'today'], ['Trackers', '/trackers', 'trackers'], ['Calendar', '/calendar', 'calendar'], ['Insights', '/dashboard', 'insights'],
      ['Holidays & breaks', '/holidays', 'holiday'], ['Settings', '/settings', 'settings'], ['Bin', '/bin', 'bin'], ['AI Knowledge', '/ai-knowledge', 'spark'],
    ] as const

    for (const [label, path, icon] of destinations) {
      const view = render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/" element={<AppShell />}><Route path="*" element={<p>Destination</p>} /></Route></Routes></MemoryRouter>)
      const desktopSidebar = screen.getByLabelText('Main navigation')
      const mobileNav = document.querySelector('nav.mobile-nav') as HTMLElement
      let desktopItem: HTMLElement
      let mobileItem: HTMLElement
      if (['Today', 'Trackers', 'Calendar', 'Insights'].includes(label)) {
        desktopItem = within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('link', { name: new RegExp(label), hidden: true })
        mobileItem = within(mobileNav).getByRole('link', { name: new RegExp(label), hidden: true })
      } else {
        desktopItem = within(desktopSidebar).getByRole('link', { name: label })
        const moreTrigger = within(mobileNav).getByRole('button', { name: 'More destinations', hidden: true })
        expect(moreTrigger).toHaveAttribute('aria-current', 'page')
        expect(window.getComputedStyle(moreTrigger).color).toBe('var(--accent-strong)')
        fireEvent.click(moreTrigger)
        mobileItem = within(mobileNav).getByRole('menuitem', { name: label, hidden: true })
      }
      for (const item of [desktopItem, mobileItem]) {
        expect(item).toHaveAttribute('aria-current', 'page')
        expect(item.querySelector('svg')).toHaveAttribute('data-icon', icon)
        expect(window.getComputedStyle(item).color).toBe('var(--accent-strong)')
        expect(window.getComputedStyle(item.querySelector('svg')!).color).toBe(window.getComputedStyle(item).color)
      }
      expect(window.getComputedStyle(desktopItem).color).toBe(window.getComputedStyle(mobileItem).color)
      view.unmount()
    }
  })

  it('keeps unknown access non-navigable and gives desktop and mobile the same pending decision', async () => {
    injectApplicationStyles()
    authState.value = { ...guestReadyState, status: 'signed-in', user: { id: 'user-a', email: 'a@example.com' } } as never
    maintainerState.value = 'checking'
    const view = render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route></Routes></MemoryRouter>)
    const desktopMore = screen.getByRole('navigation', { name: 'More destinations' })
    expect(within(desktopMore).queryByRole('link', { name: 'AI Knowledge' })).not.toBeInTheDocument()
    const desktopPending = within(desktopMore).getByRole('status', { name: 'Checking AI Knowledge access' })
    expect(desktopPending).toHaveAttribute('aria-disabled', 'true')
    expect(desktopPending).toHaveTextContent('AI Knowledge')
    expect(desktopPending.querySelector('svg')).toHaveAttribute('data-icon', 'spark')
    expect(desktopPending.querySelector('svg')).toHaveStyle({ color: 'var(--ink-muted)' })
    const desktopPendingHeight = window.getComputedStyle(desktopPending).minHeight

    const mobileNav = document.querySelector('nav.mobile-nav') as HTMLElement
    fireEvent.click(within(mobileNav).getByRole('button', { name: 'More destinations', hidden: true }))
    expect(within(mobileNav).queryByRole('menuitem', { name: 'AI Knowledge', hidden: true })).not.toBeInTheDocument()
    const mobilePending = within(mobileNav).getByRole('menuitem', { name: 'Checking AI Knowledge access', hidden: true })
    expect(mobilePending).toHaveAttribute('aria-disabled', 'true')
    expect(mobilePending).toHaveTextContent('AI Knowledge')
    expect(mobilePending.querySelector('svg')).toHaveAttribute('data-icon', 'spark')
    expect(mobilePending.querySelector('svg')).toHaveStyle({ color: 'var(--ink-muted)' })
    const mobilePendingHeight = window.getComputedStyle(mobilePending).minHeight

    maintainerState.value = 'authorized'
    view.rerender(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route></Routes></MemoryRouter>)
    const desktopAuthorized = within(desktopMore).getByRole('link', { name: 'AI Knowledge' })
    expect(window.getComputedStyle(desktopAuthorized).minHeight).toBe(desktopPendingHeight)
    const mobileAuthorized = within(mobileNav).getByRole('menuitem', { name: 'AI Knowledge', hidden: true })
    expect(window.getComputedStyle(mobileAuthorized).minHeight).toBe(mobilePendingHeight)

    maintainerState.value = 'error'
    view.rerender(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route></Routes></MemoryRouter>)
    expect(within(desktopMore).getByRole('status', { name: 'Checking AI Knowledge access' })).toBeInTheDocument()
    expect(within(mobileNav).getByRole('menuitem', { name: 'Checking AI Knowledge access', hidden: true })).toBeInTheDocument()

    maintainerState.value = 'denied'
    view.rerender(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Today</p>} /></Route></Routes></MemoryRouter>)
    expect(within(desktopMore).queryByRole('link', { name: 'AI Knowledge' })).not.toBeInTheDocument()
    expect(within(desktopMore).queryByRole('status', { name: 'Checking AI Knowledge access' })).not.toBeInTheDocument()
    expect(within(mobileNav).queryByRole('menuitem', { name: 'AI Knowledge', hidden: true })).not.toBeInTheDocument()
  })

  it('does not render route content until the signed-in account workspace is active', () => {
    authState.value = { status: 'signed-in', user: { id: 'user-b', email: 'b@example.com' }, passwordRecovery: false, workspaceStatus: 'loading', workspaceUserId: 'user-a' } as never
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Account private content</p>} /></Route></Routes></MemoryRouter>)
    expect(screen.getByRole('status', { name: 'Preparing your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Account private content')).not.toBeInTheDocument()
    expect(document.querySelector('nav.mobile-nav') as HTMLElement).toBeInTheDocument()
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

    const mobileNav = document.querySelector('nav.mobile-nav') as HTMLElement
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
    const nav = document.querySelector('nav.mobile-nav') as HTMLElement
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
