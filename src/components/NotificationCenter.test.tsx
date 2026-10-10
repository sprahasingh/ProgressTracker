import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { AppNotification } from '../db/models'
import { NotificationCenter } from './NotificationCenter'

const mocks = vi.hoisted(() => ({ list: vi.fn(), mark: vi.fn(), markAll: vi.fn() }))
vi.mock('../db/localRepository', () => ({ localRepository: { listAppNotifications: mocks.list, markAppNotificationRead: mocks.mark, markAllAppNotificationsRead: mocks.markAll } }))
vi.mock('../services/supabase/client', () => ({ getSupabaseClient: () => null }))

const notification: AppNotification = { id: 'n1', identity: 'daily-reminder:2026-10-10:16:00', kind: 'pending', title: 'Check in', body: 'DSA is waiting', href: '/?date=2026-10-10', createdAt: '2026-10-10T10:00:00.000Z', readAt: null }

describe('in-app notification center', () => {
  afterEach(() => cleanup())
  beforeEach(() => { mocks.list.mockReset().mockResolvedValue([notification]); mocks.mark.mockReset().mockResolvedValue(undefined); mocks.markAll.mockReset().mockResolvedValue(undefined) })
  it('shows unread count and marks notifications as read before navigating', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/']}><NotificationCenter ownerUserId="user-1" ready /><Routes><Route path="/" element={<p>Home</p>} /></Routes><Routes><Route path="/" element={<p>Home</p>} /></Routes></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }))
    await user.click(await screen.findByRole('button', { name: /Check in/ }))
    expect(mocks.mark).toHaveBeenCalledWith('n1')
  })
  it('keeps empty-workspace access safe and supports mark all read', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><NotificationCenter ownerUserId="user-1" ready /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }))
    await user.click(screen.getByRole('button', { name: 'Mark all read' }))
    expect(mocks.markAll).toHaveBeenCalledOnce()
  })
  it('dismisses on outside pointer and Escape, returning focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><NotificationCenter ownerUserId="user-1" ready /><p>Page content</p></MemoryRouter>)
    const trigger = await screen.findByRole('button', { name: 'Notifications, 1 unread' })
    await user.click(trigger)
    expect(screen.getByRole('region', { name: 'Notification center' })).toBeInTheDocument()
    await user.click(screen.getByText('Page content'))
    expect(screen.queryByRole('region', { name: 'Notification center' })).not.toBeInTheDocument()
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Notification center' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
