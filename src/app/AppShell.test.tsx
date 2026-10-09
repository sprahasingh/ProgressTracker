import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { db } from '../db/database'
import { TodayPage } from '../features/today/TodayPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { HistoryPage } from '../features/history/HistoryPage'
import { AppShell } from './AppShell'

vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => ({ status: 'local-only' }) }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete() })

describe('app navigation quality', () => {
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
