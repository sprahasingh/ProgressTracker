import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotificationsSettings } from './NotificationsSettings'
import { localRepository } from '../../db/localRepository'
import { db } from '../../db/database'
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

const mocks = vi.hoisted(() => ({ auth: { status: 'signed-in', user: { id: 'notification-account' }, pushOwnershipStatus: 'ready', pushOwnershipMessage: '' }, client: null as unknown }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => mocks.auth }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => mocks.client }))

beforeEach(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() } }) })
afterEach(async () => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.client = null; mocks.auth.status = 'signed-in'; mocks.auth.user = { id: 'notification-account' }; mocks.auth.pushOwnershipStatus = 'ready'; mocks.auth.pushOwnershipMessage = ''; localStorage.removeItem('progress-tracker:push-owner'); Reflect.deleteProperty(navigator, 'serviceWorker'); Reflect.deleteProperty(navigator, 'locks'); await db.delete() })

function renderSettings() { return render(<MemoryRouter><NotificationsSettings /></MemoryRouter>) }

describe('notification settings', () => {
  it('enables preference controls without Supabase and persists edits locally', async () => {
    const user = userEvent.setup()
    renderSettings()
    expect(await screen.findByRole('button', { name: /General notifications Off/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Setup required')).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('.notification-preferences-fieldset')).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /General notifications Off/ }))
    const master = screen.getByRole('checkbox', { name: /Enable reminders in this account/ })
    fireEvent.click(screen.getByRole('button', { name: 'More about Background delivery setup' }))
    expect(screen.getByRole('dialog', { name: 'Background delivery setup' })).toHaveTextContent(/do not confirm background delivery/i)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(master)
    await waitFor(async () => expect(await localRepository.getNotificationPreferences()).toMatchObject({ enabled: true, timezone: 'UTC' }))
    expect(screen.getByText(/Saved on this device/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Daily reminders On · 2 times/ }))
    expect(document.querySelector('.notification-times input')).toBeEnabled()
  })

  it('loads cached preferences while account sync is unavailable', async () => {
    await localRepository.saveNotificationPreferences({ enabled: true, daily_enabled: true, daily_times: ['09:15'], overdue_enabled: false, overdue_times: ['10:00'], remind_partial: false, motivation_mode: 'custom', motivation_times: ['18:00'], motivation_weekdays: [1,2,3,4,5], timezone: 'UTC', quiet_start: null, quiet_end: null, allow_overdue_during_quiet: false, daily_limit: 4, motivation_daily_limit: 1, tracker_ids: ['only-this'] })
    renderSettings()
    await userEvent.click(await screen.findByRole('button', { name: /General notifications On/ }))
    const master = screen.getByRole('checkbox', { name: /Enable reminders in this account/ })
    await waitFor(() => expect(master).toBeChecked())
    await userEvent.click(screen.getByRole('button', { name: /Daily reminders On/ }))
    expect(document.querySelector('.notification-times input')).toHaveValue('09:15')
    await userEvent.click(screen.getByRole('button', { name: /Motivation/ }))
    expect(screen.getByRole('combobox', { name: 'Message type' })).toHaveValue('custom')
    expect(screen.getByText(/Account sync setup is unavailable/)).toBeInTheDocument()
  })

  it('adds, edits, and removes a specifically named reminder time', async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByRole('button', { name: /Daily reminders On · 2 times/ })
    await waitFor(() => expect(document.querySelector('.notification-preferences-fieldset')).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /Daily reminders On · 2 times/ }))
    expect(screen.getByRole('button', { name: /Daily reminders On · 2 times/ })).toHaveAttribute('aria-expanded', 'true')

    const dailyTimes = screen.getByLabelText('Daily reminder times')
    const inputs = dailyTimes.querySelectorAll('input[type="time"]')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).toHaveValue('16:00')
    expect(dailyTimes.querySelector('svg[data-icon="bin"]')).toBeInTheDocument()
    await user.click(dailyTimes.querySelector('.notification-add-time') as HTMLButtonElement)
    await waitFor(async () => expect((await localRepository.getNotificationPreferences())?.daily_times).toContain('20:00'))
    expect(screen.getByRole('button', { name: /Daily reminders On · 3 times/ })).toHaveAttribute('aria-expanded', 'true')

    const updatedInputs = dailyTimes.querySelectorAll('input[type="time"]')
    fireEvent.change(updatedInputs[0]!, { target: { value: '17:30' } })
    await waitFor(async () => expect((await localRepository.getNotificationPreferences())?.daily_times).toContain('17:30'))
    await waitFor(() => expect(dailyTimes.querySelectorAll('input[type="time"]')[0]).toHaveValue('17:30'))
    expect(dailyTimes.querySelectorAll('input[type="time"]')[0]).toHaveValue('17:30')

    const removeButton = screen.getByRole('button', { name: /Remove 5:30 PM daily reminder/ })
    expect(removeButton).toHaveTextContent('Remove')
    expect(removeButton.querySelector('[data-icon="bin"]')).toBeInTheDocument()
    await user.click(removeButton)
    await waitFor(async () => expect((await localRepository.getNotificationPreferences())?.daily_times).not.toContain('17:30'))
  })

  it('edits and removes a named custom motivational message', async () => {
    const user = userEvent.setup()
    await localRepository.saveCustomMotivationMessage({ id: 'message-a', message: 'Be kind to yourself', enabled: true, deleted: false })
    renderSettings()
    await user.click(await screen.findByRole('button', { name: /Motivation/ }))
    expect(await screen.findByText('Be kind to yourself')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit message: Be kind to yourself' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit motivation message' }), { target: { value: 'One small step' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect((await localRepository.listCustomMotivationMessages()).map((row) => row.message)).toContain('One small step'))
    await user.click(screen.getByRole('button', { name: 'Remove custom message: One small step' }))
    await waitFor(async () => expect(await localRepository.listCustomMotivationMessages()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'message-a', deleted: true })])))
  })

  it('leaves preferences editable if the hosted notification tables cannot be read', async () => {
    mocks.client = { from: () => ({ select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: null, error: { message: 'missing migration' } }), order: async () => ({ data: null, error: { message: 'missing migration' } }) }) }
    renderSettings()
    const fieldset = document.querySelector('.notification-preferences-fieldset')!
    await waitFor(() => expect(fieldset).toBeEnabled())
    expect(screen.getByText(/database setup/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /General notifications Off/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable reminders in this account/ }))
    await waitFor(async () => expect(await localRepository.getNotificationPreferences()).toMatchObject({ enabled: true }))
  })

  it('keeps account preferences editable when browser notification permission is denied', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' })
    renderSettings()
    await waitFor(() => expect(document.querySelector('.notification-preferences-fieldset')).toBeEnabled())
    expect(screen.getByText(/Permission is denied/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /General notifications Off/ }))
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

    renderSettings()

    expect(await screen.findByText('Device registered')).toBeInTheDocument()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('manage-push-subscription', {
      body: { action: 'register', subscription: expect.objectContaining({ endpoint: current.endpoint }) },
    }))
    expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty('user_id')
    expect(worker.pushManager.subscribe).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Device and push notifications/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove device registration' }))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('manage-push-subscription', { body: { action: 'revoke', subscription: { endpoint: current.endpoint } } }))
    expect(current.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not offer account subscription registration to guests', () => {
    mocks.auth.status = 'local-only'
    mocks.auth.user = null as unknown as { id: string }
    renderSettings()
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
    renderSettings()
    await userEvent.click(await screen.findByRole('button', { name: /Device and push notifications/ }))
    const retry = await screen.findByRole('button', { name: 'Retry registration' })
    fireEvent.click(retry)
    expect((await screen.findAllByText(/Sign in to the previous account/)).length).toBeGreaterThan(0)
    expect(invoke).not.toHaveBeenCalled()
    expect(worker.pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('keeps one accordion open, updates its saved summary, supports keyboard toggles, and resets after route history navigation', async () => {
    const user = userEvent.setup()
    function HistoryActions() {
      const navigate = useNavigate()
      return <div><button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button></div>
    }
    render(<MemoryRouter initialEntries={['/settings']}><Routes>
      <Route path="/settings" element={<><NotificationsSettings /><Link to="/settings#sync-data">Sync section</Link><Link to="/today">Today</Link><HistoryActions /></>} />
      <Route path="/today" element={<><p>Today page</p><Link to="/settings">Settings</Link><HistoryActions /></>} />
    </Routes></MemoryRouter>)
    const daily = await screen.findByRole('button', { name: /Daily reminders On · 2 times/ })
    await waitFor(() => expect(document.querySelector('.notification-preferences-fieldset')).toBeEnabled())
    expect(screen.getAllByRole('button', { name: /notifications|reminders|activity|motivation|quiet hours|device and push/i }).every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(true)
    daily.focus()
    await user.keyboard('{Enter}')
    expect(daily).toHaveAttribute('aria-expanded', 'true')
    const incomplete = screen.getByRole('button', { name: /Missed and incomplete activity/ })
    await user.click(incomplete)
    expect(daily).toHaveAttribute('aria-expanded', 'false')
    expect(incomplete).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: /General notifications Off/ }))
    await user.click(screen.getByRole('checkbox', { name: /Enable reminders in this account/ }))
    await waitFor(async () => expect(await localRepository.getNotificationPreferences()).toMatchObject({ enabled: true }))
    await user.click(screen.getByRole('button', { name: /General notifications On/ }))
    expect(screen.getByRole('button', { name: /General notifications On/ })).toHaveAttribute('aria-expanded', 'false')
    const dailyAgain = screen.getByRole('button', { name: /Daily reminders On · 2 times/ })
    await user.click(dailyAgain)
    expect(dailyAgain).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('link', { name: 'Sync section' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Daily reminders On · 2 times/ })).toHaveAttribute('aria-expanded', 'false'))
    await user.click(screen.getByRole('link', { name: 'Today' }))
    expect(await screen.findByText('Today page')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: /General notifications On/ })).toHaveAttribute('aria-expanded', 'false')
    expect(await localRepository.getNotificationPreferences()).toMatchObject({ enabled: true })
    await user.click(screen.getByRole('button', { name: 'Forward' }))
    expect(await screen.findByText('Today page')).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    expect(await screen.findByRole('button', { name: /General notifications On/ })).toHaveAttribute('aria-expanded', 'false')
  })
})
