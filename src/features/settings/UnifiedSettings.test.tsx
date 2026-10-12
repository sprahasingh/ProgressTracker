import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { SettingsPage } from './WorkspaceTimeZone'
import { ToastProvider } from '../../components/ui/ToastProvider'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), updateName: vi.fn(), changeEmail: vi.fn() }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: mocks.auth }))
vi.mock('../auth/authService', () => ({ updateAccountName: mocks.updateName, requestAccountEmailChange: mocks.changeEmail }))
vi.mock('../auth/AuthPage', () => ({ AuthPage: () => <div>Cloud synchronization controls</div> }))

const account = { id: 'account-1', email: 'person@example.com', user_metadata: { full_name: 'Spraha Singh' } }

describe('unified Settings authentication states', () => {
  afterEach(() => cleanup())
  beforeEach(() => {
    mocks.updateName.mockReset().mockResolvedValue({ error: null })
    mocks.changeEmail.mockReset().mockResolvedValue({ error: null, pendingEmail: 'next@example.com' })
    mocks.auth.mockReturnValue({ status: 'local-only', user: null })
  })

  it('keeps guest preferences and hides account-only controls', async () => {
    const user = userEvent.setup()
    render(<ToastProvider><MemoryRouter><SettingsPage /></MemoryRouter></ToastProvider>)
    expect(screen.getByRole('button', { name: 'Calendar & Time' })).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('settings-panel-calendar-time')).toHaveAttribute('hidden')
    await user.click(screen.getByRole('button', { name: 'Calendar & Time' }))
    expect(document.getElementById('settings-panel-calendar-time')).not.toHaveAttribute('hidden')
    expect(document.getElementById('settings-panel-appearance')).toHaveAttribute('hidden')
    await user.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(document.getElementById('settings-panel-calendar-time')).toHaveAttribute('hidden')
    expect(document.querySelector('#settings-panel-appearance select')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change email' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Personal Information' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Account Actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Account' })).not.toBeInTheDocument()
    expect(document.getElementById('settings-panel-feedback-support')).toHaveAttribute('hidden')
  })

  it('shows signed-in profile, allows name edits, and consolidates sync controls', async () => {
    mocks.auth.mockReturnValue({ status: 'signed-in', user: account })
    const user = userEvent.setup()
    render(<ToastProvider><MemoryRouter><SettingsPage /></MemoryRouter></ToastProvider>)
    expect(screen.getAllByText('Spraha Singh')).toHaveLength(2)
    expect(screen.getByText('S', { selector: '.settings-profile-avatar' })).toBeInTheDocument()
    expect(document.getElementById('settings-panel-sync-data')).toHaveAttribute('hidden')
    expect(screen.getByRole('heading', { name: 'Account Actions' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Account' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send Feedback' })).not.toBeInTheDocument()
    const sectionHeadings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(sectionHeadings.indexOf('Calendar & Time')).toBeLessThan(sectionHeadings.indexOf('Appearance'))
    expect(sectionHeadings.indexOf('Appearance')).toBeLessThan(sectionHeadings.indexOf('Notifications'))
    expect(sectionHeadings.indexOf('Notifications')).toBeLessThan(sectionHeadings.indexOf('Sync & Data'))
    await user.click(screen.getByRole('button', { name: 'Sync & Data' }))
    expect(screen.getByText('Cloud synchronization controls')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Account Actions' }))
    expect(document.getElementById('settings-panel-sync-data')).toHaveAttribute('hidden')
    expect(screen.getByRole('button', { name: 'Delete Account' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Feedback & Support' }))
    expect(screen.getByRole('button', { name: 'Send Feedback' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Personal Information' }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Full name'))
    await user.type(screen.getByLabelText('Full name'), '  Alex Rivera  ')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(mocks.updateName).toHaveBeenCalledWith('Alex Rivera')
    expect(await screen.findByRole('status', { name: /Name updated/ })).toHaveTextContent('Your profile name was saved.')
  })

  it('opens the shared feedback dialog from Settings', async () => {
    mocks.auth.mockReturnValue({ status: 'signed-in', user: account })
    const user = userEvent.setup()
    render(<ToastProvider><MemoryRouter><SettingsPage /></MemoryRouter></ToastProvider>)
    await user.click(screen.getByRole('button', { name: 'Feedback & Support' }))
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    expect(await screen.findByRole('dialog', { name: 'Send Feedback' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Share my email with support/ })).toBeChecked()
    expect(screen.getByText('Email shared with support: person@example.com')).toBeInTheDocument()
  })

  it('validates email and reports the secure confirmation state', async () => {
    mocks.auth.mockReturnValue({ status: 'signed-in', user: account })
    const user = userEvent.setup()
    render(<ToastProvider><MemoryRouter><SettingsPage /></MemoryRouter></ToastProvider>)
    await user.click(screen.getByRole('button', { name: 'Personal Information' }))
    await user.click(screen.getByRole('button', { name: 'Change email' }))
    await user.type(screen.getByLabelText('New email address'), 'invalid')
    await user.click(screen.getByRole('button', { name: 'Send confirmation' }))
    expect(await screen.findByText('Enter a valid email address.')).toHaveAttribute('role', 'alert')
    expect(mocks.changeEmail).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText('New email address'))
    await user.type(screen.getByLabelText('New email address'), 'next@example.com')
    await user.click(screen.getByRole('button', { name: 'Send confirmation' }))
    expect(mocks.changeEmail).toHaveBeenCalledWith('next@example.com', expect.stringMatching(/^http/))
    expect(await screen.findByText(/confirmation pending for next@example.com/)).toBeInTheDocument()
    expect(screen.getByRole('status', { name: /Verification requested/ })).toHaveTextContent(/current address remains active until all required confirmations are complete/i)
    expect(screen.getAllByRole('status').find((element) => element.textContent?.includes('Email change pending for'))).toHaveTextContent(/approve the change from your current inbox too/i)
  })

  it('resets the expanded section after leaving and returning to Settings', async () => {
    mocks.auth.mockReturnValue({ status: 'signed-in', user: account })
    const user = userEvent.setup()
    render(<ToastProvider><MemoryRouter initialEntries={['/settings']}><Routes>
      <Route path="/settings" element={<><SettingsPage /><Link to="/settings?support=thread-1">Open support query</Link><Link to="/today">Today</Link></>} />
      <Route path="/today" element={<Link to="/settings">Settings</Link>} />
    </Routes></MemoryRouter></ToastProvider>)
    await user.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(screen.getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'My Support Queries' }))
    expect(screen.getByRole('button', { name: 'My Support Queries' })).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('link', { name: 'Open support query' }))
    expect(screen.getByRole('button', { name: 'My Support Queries' })).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('link', { name: 'Today' }))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    expect(screen.getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('combobox', { name: /^Appearance/ })).not.toBeInTheDocument()
  })

  it('opens a Settings section targeted by a supported deep link', () => {
    mocks.auth.mockReturnValue({ status: 'signed-in', user: account })
    render(<ToastProvider><MemoryRouter initialEntries={['/settings#sync-data']}><SettingsPage /></MemoryRouter></ToastProvider>)
    expect(screen.getByRole('button', { name: 'Sync & Data' })).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('sync-data')).toBeInTheDocument()
    expect(document.getElementById('settings-panel-sync-data')).not.toHaveAttribute('hidden')
  })

  it('opens support history when a support conversation is deep-linked', () => {
    mocks.auth.mockReturnValue({ status: 'signed-in', user: account })
    render(<ToastProvider><MemoryRouter initialEntries={['/settings?support=thread-1']}><SettingsPage /></MemoryRouter></ToastProvider>)
    expect(screen.getByRole('button', { name: 'My Support Queries' })).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('settings-panel-my-support-queries')).not.toHaveAttribute('hidden')
  })
})
