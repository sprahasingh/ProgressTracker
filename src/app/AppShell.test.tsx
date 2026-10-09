import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { db } from '../db/database'
import { TodayPage } from '../features/today/TodayPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { HistoryPage } from '../features/history/HistoryPage'
import { AppShell } from './AppShell'

const authState = vi.hoisted(() => ({ value: { status: 'local-only' as string } }))
vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => authState.value }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); authState.value = { status: 'local-only' }; await db.delete() })

describe('app navigation quality', () => {
  it('does not render route content until the signed-in account workspace is active', () => {
    authState.value = { status: 'signed-in', user: { id: 'user-b', email: 'b@example.com' }, passwordRecovery: false, workspaceStatus: 'loading', workspaceUserId: 'user-a' } as never
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<p>Account private content</p>} /></Route></Routes></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Opening your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Account private content')).not.toBeInTheDocument()
    authState.value = { status: 'local-only' }
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
    authState.value = { status: 'local-only' }
  })

  it('supports keyboard skip-to-content and moves between the real Today, Overview, and History routes', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}>
      <Route index element={<TodayPage />} />
      <Route path="dashboard" element={<DashboardPage />} />
      <Route path="history" element={<HistoryPage />} />
    </Route></Routes></MemoryRouter>)

    expect(screen.getByRole('status')).toHaveTextContent('Loading today’s trackers')
    await user.tab()
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(document.activeElement).toHaveAttribute('id', 'main-content')
    expect(await screen.findByText('Nothing scheduled today')).toBeInTheDocument()

    const desktopNav = screen.getByRole('navigation', { name: 'Primary navigation' })
    await user.click(within(desktopNav).getByRole('link', { name: /Overview/ }))
    expect(await screen.findByText('Your overview starts with a tracker')).toBeInTheDocument()

    const mobileNav = screen.getByRole('navigation', { name: 'Mobile navigation' })
    await user.click(within(mobileNav).getByRole('link', { name: /History/ }))
    expect(await screen.findByText('No check-ins in this range')).toBeInTheDocument()
  })
})
