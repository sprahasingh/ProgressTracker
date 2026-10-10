import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('keeps guest preferences and hides account-only controls', () => {
    render(<ToastProvider><SettingsPage /></ToastProvider>)
    expect(screen.getByLabelText(/Calendar time zone/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Appearance/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change email' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Personal Information' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Account Actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Account' })).not.toBeInTheDocument()
  })

  it('shows signed-in profile, allows name edits, and consolidates sync controls', async () => {
    mocks.auth.mockReturnValue({ status: 'signed-in', user: account })
    const user = userEvent.setup()
    render(<ToastProvider><SettingsPage /></ToastProvider>)
    expect(screen.getAllByText('Spraha Singh')).toHaveLength(2)
    expect(screen.getByText('S', { selector: '.settings-profile-avatar' })).toBeInTheDocument()
    expect(screen.getByText('Cloud synchronization controls')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Account Actions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Account' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Full name'))
    await user.type(screen.getByLabelText('Full name'), '  Alex Rivera  ')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(mocks.updateName).toHaveBeenCalledWith('Alex Rivera')
    expect(await screen.findByRole('status', { name: /Name updated/ })).toHaveTextContent('Your profile name was saved.')
  })

  it('validates email and reports the secure confirmation state', async () => {
    mocks.auth.mockReturnValue({ status: 'signed-in', user: account })
    const user = userEvent.setup()
    render(<ToastProvider><SettingsPage /></ToastProvider>)
    await user.click(screen.getByRole('button', { name: 'Change email' }))
    await user.type(screen.getByLabelText('New email address'), 'invalid')
    await user.click(screen.getByRole('button', { name: 'Send confirmation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address.')
    expect(mocks.changeEmail).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText('New email address'))
    await user.type(screen.getByLabelText('New email address'), 'next@example.com')
    await user.click(screen.getByRole('button', { name: 'Send confirmation' }))
    expect(mocks.changeEmail).toHaveBeenCalledWith('next@example.com', expect.stringMatching(/^http/))
    expect(await screen.findByText(/confirmation pending for next@example.com/)).toBeInTheDocument()
    expect(screen.getByRole('status', { name: /Verification requested/ })).toHaveTextContent(/current address remains active until you confirm/i)
  })
})
