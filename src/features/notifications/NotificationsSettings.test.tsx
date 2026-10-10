import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NotificationsSettings } from './NotificationsSettings'
import { localRepository } from '../../db/localRepository'
import { db } from '../../db/database'

const mocks = vi.hoisted(() => ({ auth: { status: 'signed-in', user: { id: 'notification-account' } }, client: null as unknown }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => mocks.auth }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => mocks.client }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.client = null; await db.delete() })

describe('notification settings', () => {
  it('enables preference controls without Supabase and persists edits locally', async () => {
    render(<NotificationsSettings />)
    const master = await screen.findByRole('checkbox', { name: /Enable reminders in this account/ })
    await waitFor(() => expect(master.closest('fieldset')).toBeEnabled())
    expect(screen.getByText('Setup required')).toBeInTheDocument()
    fireEvent.click(master)
    await waitFor(async () => expect(await localRepository.getNotificationPreferences()).toMatchObject({ enabled: true, timezone: 'UTC' }))
    expect(screen.getByText(/Saved on this device/)).toBeInTheDocument()
    expect(document.querySelector('.notification-times input')).toBeEnabled()
  })

  it('loads cached preferences while account sync is unavailable', async () => {
    await localRepository.saveNotificationPreferences({ enabled: true, daily_enabled: true, daily_times: ['09:15'], overdue_enabled: false, overdue_times: ['10:00'], remind_partial: false, motivation_mode: 'custom', motivation_times: ['18:00'], motivation_weekdays: [1,2,3,4,5], timezone: 'UTC', quiet_start: null, quiet_end: null, allow_overdue_during_quiet: false, daily_limit: 4, motivation_daily_limit: 1, tracker_ids: ['only-this'] })
    render(<NotificationsSettings />)
    const master = await screen.findByRole('checkbox', { name: /Enable reminders in this account/ })
    await waitFor(() => expect(master).toBeChecked())
    expect(document.querySelector('.notification-times input')).toHaveValue('09:15')
    expect(screen.getByRole('combobox', { name: 'Message type' })).toHaveValue('custom')
    expect(screen.getByText(/Account sync setup is unavailable/)).toBeInTheDocument()
  })

  it('leaves preferences editable if the hosted notification tables cannot be read', async () => {
    mocks.client = { from: () => ({ select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: null, error: { message: 'missing migration' } }), order: async () => ({ data: null, error: { message: 'missing migration' } }) }) }
    render(<NotificationsSettings />)
    const fieldset = document.querySelector('fieldset')!
    await waitFor(() => expect(fieldset).toBeEnabled())
    expect(screen.getByText(/database setup/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable reminders in this account/ }))
    await waitFor(async () => expect(await localRepository.getNotificationPreferences()).toMatchObject({ enabled: true }))
  })

  it('keeps account preferences editable when browser notification permission is denied', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' })
    render(<NotificationsSettings />)
    await waitFor(() => expect(document.querySelector('fieldset')).toBeEnabled())
    expect(screen.getByText(/Permission is denied/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Enable reminders in this account/ })).toBeEnabled()
  })
})
