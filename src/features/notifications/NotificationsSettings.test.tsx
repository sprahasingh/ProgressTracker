import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NotificationsSettings } from './NotificationsSettings'
import { localRepository } from '../../db/localRepository'
import { db } from '../../db/database'

const mocks = vi.hoisted(() => ({ auth: { status: 'signed-in', user: { id: 'notification-account' }, pushOwnershipStatus: 'ready', pushOwnershipMessage: '' }, client: null as unknown }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => mocks.auth }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => mocks.client }))

beforeEach(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() } }) })
afterEach(async () => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.client = null; mocks.auth.status = 'signed-in'; mocks.auth.user = { id: 'notification-account' }; mocks.auth.pushOwnershipStatus = 'ready'; mocks.auth.pushOwnershipMessage = ''; localStorage.removeItem('progress-tracker:push-owner'); Reflect.deleteProperty(navigator, 'serviceWorker'); Reflect.deleteProperty(navigator, 'locks'); await db.delete() })

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

  it('registers an existing browser subscription through the authenticated function without sending user_id', async () => {
    const current = {
      endpoint: 'https://push.example.test/settings-device',
      expirationTime: null,
      toJSON: () => ({ endpoint: 'https://push.example.test/settings-device', expirationTime: null, keys: { p256dh: `BA${'A'.repeat(85)}`, auth: 'A'.repeat(22) } }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    }
    const worker = { scope: `${location.origin}/ProgressTracker/`, active: { postMessage: vi.fn() }, pushManager: { getSubscription: vi.fn().mockResolvedValue(current), subscribe: vi.fn() } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(worker), ready: Promise.resolve(worker), addEventListener: vi.fn(), removeEventListener: vi.fn() } })
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('PushManager', {})
    vi.stubGlobal('Notification', { permission: 'granted' })
    const query = { select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: null, error: null }), order: async () => ({ data: [], error: null }) }
    const invoke = vi.fn().mockResolvedValue({ data: { status: 'registered' }, error: null })
    mocks.client = { from: () => query, functions: { invoke } }

    render(<NotificationsSettings />)

    expect(await screen.findByText('Device registered')).toBeInTheDocument()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('manage-push-subscription', {
      body: { action: 'register', subscription: expect.objectContaining({ endpoint: current.endpoint }) },
    }))
    expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty('user_id')
    expect(worker.pushManager.subscribe).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Disable this device' }))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('manage-push-subscription', { body: { action: 'revoke', subscription: { endpoint: current.endpoint } } }))
    expect(current.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not offer account subscription registration to guests', () => {
    mocks.auth.status = 'local-only'
    mocks.auth.user = null as unknown as { id: string }
    render(<NotificationsSettings />)
    expect(screen.getByText(/Account reminder preferences require sign-in/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /register this device/i })).not.toBeInTheDocument()
  })

  it('blocks registration while previous-account cleanup is unresolved', async () => {
    mocks.auth.pushOwnershipStatus = 'cleanup-required'
    mocks.auth.pushOwnershipMessage = 'Sign in to the previous account to finish removing this device subscription.'
    const worker = { scope: `${location.origin}/ProgressTracker/`, active: { postMessage: vi.fn() }, pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe: vi.fn() } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(worker), ready: Promise.resolve(worker), addEventListener: vi.fn(), removeEventListener: vi.fn() } })
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('PushManager', {})
    vi.stubGlobal('Notification', { permission: 'granted' })
    const invoke = vi.fn().mockResolvedValue({ data: { status: 'registered' }, error: null })
    const query = { select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: null, error: null }), order: async () => ({ data: [], error: null }) }
    mocks.client = { from: () => query, functions: { invoke } }
    render(<NotificationsSettings />)
    const retry = await screen.findByRole('button', { name: 'Retry registration' })
    fireEvent.click(retry)
    expect((await screen.findAllByText(/Sign in to the previous account/)).length).toBeGreaterThan(0)
    expect(invoke).not.toHaveBeenCalled()
    expect(worker.pushManager.subscribe).not.toHaveBeenCalled()
  })
})
