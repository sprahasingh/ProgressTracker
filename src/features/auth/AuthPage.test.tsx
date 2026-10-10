import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthPage } from './AuthPage'

const authMocks = vi.hoisted(() => ({
  sendSignInLink: vi.fn(), signInWithPassword: vi.fn(), signUpWithPassword: vi.fn(),
  sendPasswordReset: vi.fn(), updateAccountPassword: vi.fn(), useAuth: vi.fn(),
  listSyncConflicts: vi.fn(), resolveSyncConflict: vi.fn(),
}))

vi.mock('./authService', () => ({
  sendSignInLink: authMocks.sendSignInLink, signInWithPassword: authMocks.signInWithPassword,
  signUpWithPassword: authMocks.signUpWithPassword, sendPasswordReset: authMocks.sendPasswordReset,
  updateAccountPassword: authMocks.updateAccountPassword,
}))
vi.mock('./AuthProvider', () => ({ useAuth: authMocks.useAuth }))
vi.mock('../../services/supabase/client', () => ({ supabaseConfiguration: { status: 'ready' } }))
vi.mock('../../db/syncConflictRepository', () => ({ listSyncConflicts: authMocks.listSyncConflicts, resolveSyncConflict: authMocks.resolveSyncConflict }))
vi.mock('./WorkspaceBackup', () => ({ WorkspaceBackup: ({ ownerUserId }: { ownerUserId: string | null }) => <div data-testid="backup-workspace">{ownerUserId ?? 'guest'}</div> }))

describe('AuthPage', () => {
  afterEach(() => cleanup())
  beforeEach(() => {
    Object.values(authMocks).forEach((mock) => mock.mockReset())
    authMocks.listSyncConflicts.mockResolvedValue([])
    authMocks.useAuth.mockReturnValue({ status: 'signed-out', user: null, signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn() })
  })

  it('validates email before requesting a magic link', async () => {
    const user = userEvent.setup()
    render(<AuthPage />)
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address.')
    expect(authMocks.sendSignInLink).not.toHaveBeenCalled()
  })

  it('preserves the magic-link sign-in flow', async () => {
    const user = userEvent.setup()
    authMocks.sendSignInLink.mockResolvedValue({ error: null })
    render(<AuthPage />)
    await user.type(screen.getByLabelText('Email address'), '  PERSON@example.com  ')
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    expect(await screen.findByRole('status')).toHaveTextContent('We sent a sign-in link to person@example.com')
    expect(authMocks.sendSignInLink).toHaveBeenCalledWith('person@example.com', expect.any(String))
  })

  it('signs in with a valid email and password', async () => {
    const user = userEvent.setup()
    authMocks.signInWithPassword.mockResolvedValue({ error: null })
    render(<AuthPage />)
    await user.click(screen.getByRole('button', { name: 'Use password' }))
    await user.type(screen.getByLabelText('Email address'), 'person@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(authMocks.signInWithPassword).toHaveBeenCalledWith('person@example.com', 'correct-horse')
  })

  it('rejects too-short passwords before creating an account', async () => {
    const user = userEvent.setup()
    render(<AuthPage />)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await user.type(screen.getByLabelText('Email address'), 'person@example.com')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 8 characters.')
    expect(authMocks.signUpWithPassword).not.toHaveBeenCalled()
  })

  it('shows confirmation guidance after sign-up when email confirmation is required', async () => {
    const user = userEvent.setup()
    authMocks.signUpWithPassword.mockResolvedValue({ error: null, requiresEmailConfirmation: true })
    render(<AuthPage />)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await user.type(screen.getByLabelText('Email address'), 'person@example.com')
    await user.type(screen.getByLabelText('Password'), 'long-enough-password')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('status')).toHaveTextContent('check your inbox to confirm')
  })

  it('uses neutral copy after requesting a password reset', async () => {
    const user = userEvent.setup()
    authMocks.sendPasswordReset.mockResolvedValue({ error: null })
    render(<AuthPage />)
    await user.click(screen.getByRole('button', { name: 'Use password' }))
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }))
    await user.type(screen.getByLabelText('Email address'), 'person@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByRole('status')).toHaveTextContent('If an account can receive a password reset')
    expect(authMocks.sendPasswordReset).toHaveBeenCalledWith('person@example.com', expect.any(String))
  })

  it('allows a signed-in magic-link user to set a password after confirmation', async () => {
    const user = userEvent.setup()
    const completePasswordRecovery = vi.fn()
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { email: 'person@example.com' }, signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery })
    authMocks.updateAccountPassword.mockResolvedValue({ error: null })
    render(<AuthPage />)
    await user.click(screen.getByRole('button', { name: 'Set or change password' }))
    await user.type(screen.getByLabelText('New password'), 'long-enough-password')
    await user.type(screen.getByLabelText('Confirm password'), 'long-enough-password')
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    expect(authMocks.updateAccountPassword).toHaveBeenCalledWith('long-enough-password')
    expect(completePasswordRecovery).toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('Your password has been updated.')
  })

  it('requires confirmation to match before setting a password', async () => {
    const user = userEvent.setup()
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { email: 'person@example.com' }, signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn() })
    render(<AuthPage />)
    await user.click(screen.getByRole('button', { name: 'Set or change password' }))
    await user.type(screen.getByLabelText('New password'), 'long-enough-password')
    await user.type(screen.getByLabelText('Confirm password'), 'different-password')
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match.')
    expect(authMocks.updateAccountPassword).not.toHaveBeenCalled()
  })

  it('renders password setup for a verified recovery session', () => {
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { email: 'person@example.com' }, signOut: vi.fn(), passwordRecovery: true, completePasswordRecovery: vi.fn() })
    render(<AuthPage />)
    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
  })

  it('starts cloud sync only after the signed-in user explicitly requests it', async () => {
    const user = userEvent.setup()
    const syncNow = vi.fn()
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { email: 'person@example.com' }, signOut: vi.fn(), passwordRecovery: false, syncNow, syncStatus: 'idle' })
    render(<AuthPage />)
    expect(syncNow).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Sync this account' }))
    expect(syncNow).toHaveBeenCalledOnce()
  })

  it('offers guest backup only after the guest workspace is ready', () => {
    authMocks.useAuth.mockReturnValue({ status: 'signed-out', user: null, workspaceStatus: 'loading', workspaceUserId: null })
    const view = render(<AuthPage />)
    expect(screen.queryByTestId('backup-workspace')).not.toBeInTheDocument()

    authMocks.useAuth.mockReturnValue({ status: 'signed-out', user: null, workspaceStatus: 'ready', workspaceUserId: null })
    view.rerender(<AuthPage />)
    expect(screen.getByTestId('backup-workspace')).toHaveTextContent('guest')
  })

  it('offers backup only for the workspace matching the signed-in account', () => {
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-a', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-b' })
    const view = render(<AuthPage />)
    expect(screen.queryByTestId('backup-workspace')).not.toBeInTheDocument()

    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-a', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-a' })
    view.rerender(<AuthPage />)
    expect(screen.getByTestId('backup-workspace')).toHaveTextContent('account-a')
  })

  it('shows owner-scoped conflict choices and requires an explicit selection', async () => {
    const user = userEvent.setup()
    const conflict = { id: 'conflict-1', ownerUserId: 'account-1', entity: 'tracker', entityId: 'tracker-1', localPayload: { id: 'tracker-1', name: 'Local version' }, remoteRecord: { user_id: 'account-1', server_revision: 2, definition: { id: 'tracker-1', name: 'Cloud version' } }, detectedAt: '2026-01-01T00:00:00.000Z' }
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn(), syncStatus: 'idle' })
    authMocks.listSyncConflicts.mockResolvedValue([conflict])
    authMocks.resolveSyncConflict.mockResolvedValue(undefined)
    render(<AuthPage />)

    expect(await screen.findByRole('heading', { name: 'Sync conflicts' })).toBeInTheDocument()
    expect(screen.getByText(/Local version/)).toBeInTheDocument()
    expect(screen.getByText('Cloud version', { selector: 'summary' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use cloud version' }))
    expect(authMocks.resolveSyncConflict).toHaveBeenCalledWith('account-1', 'conflict-1', 'use-cloud')
  })

  it('labels tracker, daily-entry, and holiday conflicts and preserves their resolution actions', async () => {
    const user = userEvent.setup()
    const common = { ownerUserId: 'account-1', detectedAt: '2026-01-01T00:00:00.000Z' }
    const cloud = { user_id: 'account-1', server_revision: 2 }
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn(), syncStatus: 'idle' })
    authMocks.listSyncConflicts.mockResolvedValue([
      { ...common, id: 'tracker-conflict', entity: 'tracker', entityId: 'tracker-1', localPayload: { id: 'tracker-1', name: 'Local' }, remoteRecord: { ...cloud, definition: { id: 'tracker-1', name: 'Cloud' } } },
      { ...common, id: 'entry-conflict', entity: 'tracker_entry', entityId: 'entry-1', localPayload: { id: 'entry-1', date: '2026-01-02' }, remoteRecord: { ...cloud, date: '2026-01-02' } },
      { ...common, id: 'holiday-conflict', entity: 'account_holiday', entityId: 'holiday-1', localPayload: { id: 'holiday-1', date: '2026-01-03', reason: 'exam' }, remoteRecord: { ...cloud, holiday_date: '2026-01-03', reason: 'travel' } },
    ])
    authMocks.resolveSyncConflict.mockResolvedValue(undefined)
    render(<AuthPage />)

    expect(await screen.findByRole('heading', { name: 'Sync conflicts' })).toBeInTheDocument()
    expect(screen.getByText('Tracker conflict · tracker-1')).toBeInTheDocument()
    expect(screen.getByText('Daily entry conflict · entry-1')).toBeInTheDocument()
    expect(screen.getByText('Holiday conflict · holiday-1')).toBeInTheDocument()
    expect(screen.getByText(/This device: 2026-01-03 · Exam\. Cloud: 2026-01-03 · Travel\./)).toBeInTheDocument()
    const trackerCard = screen.getByText('Tracker conflict · tracker-1').closest('article')!
    const entryCard = screen.getByText('Daily entry conflict · entry-1').closest('article')!
    const holidayCard = screen.getByText('Holiday conflict · holiday-1').closest('article')!
    await user.click(within(trackerCard).getByRole('button', { name: 'Keep this device’s version' }))
    await user.click(within(entryCard).getByRole('button', { name: 'Use cloud version' }))
    await user.click(within(holidayCard).getByRole('button', { name: 'Use cloud version' }))
    expect(authMocks.resolveSyncConflict).toHaveBeenCalledWith('account-1', 'tracker-conflict', 'keep-local')
    expect(authMocks.resolveSyncConflict).toHaveBeenCalledWith('account-1', 'entry-conflict', 'use-cloud')
    expect(authMocks.resolveSyncConflict).toHaveBeenCalledWith('account-1', 'holiday-conflict', 'use-cloud')
  })

  it('does not offer the entry-only fork action for an unavailable holiday conflict', async () => {
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn(), syncStatus: 'idle' })
    authMocks.listSyncConflicts.mockResolvedValue([{ id: 'holiday-conflict', ownerUserId: 'account-1', entity: 'account_holiday', entityId: 'holiday-1', localPayload: { id: 'holiday-1', date: '2026-01-03', reason: 'exam' }, remoteRecord: null, detectedAt: '2026-01-01T00:00:00.000Z' }])
    render(<AuthPage />)
    const holidayCard = await screen.findByText('Holiday conflict · holiday-1')
    expect(holidayCard.closest('article')).toHaveTextContent('The cloud holiday is unavailable to review.')
    expect(within(holidayCard.closest('article')!).queryByRole('button', { name: 'Save local copy as new' })).not.toBeInTheDocument()
  })

  it('hides prior account conflict details immediately when the signed-in account changes', async () => {
    const privateConflict = { id: 'private-conflict', ownerUserId: 'account-1', entity: 'tracker', entityId: 'private-tracker', localPayload: { id: 'private-tracker', name: 'Account one secret' }, remoteRecord: null, detectedAt: '2026-01-01T00:00:00.000Z' }
    authMocks.listSyncConflicts.mockResolvedValueOnce([privateConflict]).mockResolvedValueOnce([])
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'one@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn() })
    const view = render(<AuthPage />)
    expect(await screen.findByText(/Account one secret/)).toBeInTheDocument()

    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-2', email: 'two@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-2', signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn() })
    view.rerender(<AuthPage />)

    expect(screen.queryByText(/Account one secret/)).not.toBeInTheDocument()
  })
})
