import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthPage } from './AuthPage'
import accountStyles from '../../styles.css?raw'

const authMocks = vi.hoisted(() => ({
  sendSignInLink: vi.fn(), signInWithPassword: vi.fn(), signUpWithPassword: vi.fn(),
  sendPasswordReset: vi.fn(), updateAccountPassword: vi.fn(), useAuth: vi.fn(),
  listSyncConflicts: vi.fn(), resolveSyncConflict: vi.fn(),
  listBlockedSyncOperations: vi.fn(), listSyncRecoveryOperations: vi.fn(), retryBlockedSyncOperation: vi.fn(),
  pendingOperationCount: vi.fn(),
}))

vi.mock('./authService', () => ({
  sendSignInLink: authMocks.sendSignInLink, signInWithPassword: authMocks.signInWithPassword,
  signUpWithPassword: authMocks.signUpWithPassword, sendPasswordReset: authMocks.sendPasswordReset,
  updateAccountPassword: authMocks.updateAccountPassword,
}))
vi.mock('./AuthProvider', () => ({ useAuth: authMocks.useAuth }))
vi.mock('../../services/supabase/client', () => ({ supabaseConfiguration: { status: 'ready' } }))
vi.mock('../../db/database', () => ({ countPendingWorkspaceSyncOperations: authMocks.pendingOperationCount }))
vi.mock('../../db/syncConflictRepository', () => ({ listSyncConflicts: authMocks.listSyncConflicts, resolveSyncConflict: authMocks.resolveSyncConflict }))
vi.mock('../../db/syncRecoveryRepository', () => ({ listBlockedSyncOperations: authMocks.listBlockedSyncOperations, listSyncRecoveryOperations: authMocks.listSyncRecoveryOperations, retryBlockedSyncOperation: authMocks.retryBlockedSyncOperation, isRetryableTransientSyncFailure: (code: string | undefined, message?: string | null) => Boolean(code && (/^5\d\d$/.test(code) || ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'FETCH_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(code)) || !code && message && /\b(network|connection|timed? ?out|timeout|temporarily unavailable|service unavailable|gateway timeout)\b/i.test(message)) }))
vi.mock('./WorkspaceBackup', () => ({ WorkspaceBackup: ({ ownerUserId }: { ownerUserId: string | null }) => <div data-testid="backup-workspace">{ownerUserId ?? 'guest'}</div> }))
vi.mock('./TrackerRecoveryPreview', () => ({ TrackerRecoveryPreview: ({ trackerId }: { trackerId?: string }) => <div data-testid="recovery-preview" data-tracker-id={trackerId ?? 'all'}>Recovery Preview</div> }))

describe('AuthPage', () => {
  afterEach(() => { cleanup(); window.history.replaceState({}, '', '/') })
  beforeEach(() => {
    Object.values(authMocks).forEach((mock) => mock.mockReset())
    authMocks.listSyncConflicts.mockResolvedValue([])
    authMocks.listBlockedSyncOperations.mockResolvedValue([])
    authMocks.listSyncRecoveryOperations.mockResolvedValue([])
    authMocks.pendingOperationCount.mockResolvedValue(0)
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
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(syncNow).toHaveBeenCalledOnce()
  })

  it.each([
    ['offline', { isOnline: false, syncStatus: 'idle' }, 'Offline'],
    ['syncing', { isOnline: true, syncStatus: 'syncing' }, 'Syncing'],
    ['pending', { isOnline: true, syncStatus: 'idle' }, 'Changes waiting to sync'],
    ['synced', { isOnline: true, syncStatus: 'complete', syncSummary: { uploaded: 0, downloaded: 0, conflicts: 0, failed: 0 } }, 'Synced'],
  ])('shows the truthful %s account status', async (_caseName, authState, label) => {
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, ...authState })
    authMocks.pendingOperationCount.mockResolvedValue(label === 'Changes waiting to sync' ? 3 : 0)
    render(<AuthPage embedded />)
    expect(await screen.findByText(label, { selector: '.account-sync-badge' })).toBeInTheDocument()
    if (label === 'Changes waiting to sync') expect(screen.getByText('3 changes waiting')).toBeInTheDocument()
  })

  it('shows blocked operations as action needed and opens inline generic recovery preview', async () => {
    const user = userEvent.setup()
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, syncStatus: 'complete', syncSummary: { uploaded: 0, downloaded: 0, conflicts: 0, failed: 0 } })
    authMocks.listSyncRecoveryOperations.mockResolvedValue([{ id: 'blocked-1', ownerUserId: 'account-1', entity: 'tracker', entityId: 'tracker-1', operation: 'upsert', expectedRevision: 1, payload: { id: 'tracker-1', name: 'Reading' }, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked', lastError: 'Rejected', failureCode: '23514' }])
    render(<AuthPage embedded />)
    expect(await screen.findByText('Action needed', { selector: '.account-sync-badge' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sync issues' })).toBeInTheDocument()
    expect(screen.queryByText('Synced', { selector: '.account-sync-badge' })).not.toBeInTheDocument()
    const advanced = screen.getByText('Advanced tools', { selector: 'summary' })
    expect(advanced.parentElement).not.toHaveAttribute('open')
    await user.click(screen.getByRole('button', { name: 'Revert to Cloud' }))
    expect(screen.getAllByTestId('recovery-preview')[0]).toHaveAttribute('data-tracker-id', 'tracker-1')
    await user.click(screen.getByRole('link', { name: 'Review recovery tools' }))
    expect(advanced.parentElement).toHaveAttribute('open')
  })

  it('offers a transient retry only after the recovery repository verifies it', async () => {
    const user = userEvent.setup()
    const syncNow = vi.fn().mockResolvedValue(undefined)
    const trackerId = '8e0c514e-ad75-47e1-abed-a770023b545e'
    const operation = { id: 'transient-1', ownerUserId: 'account-1', entity: 'tracker', entityId: trackerId, operation: 'upsert', expectedRevision: 1, payload: { id: trackerId, name: '100 Days Of MERN' }, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked', lastError: 'Gateway timeout', failureCode: '504' }
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, syncNow, syncStatus: 'idle' })
    authMocks.retryBlockedSyncOperation.mockResolvedValue('queued')
    authMocks.listSyncRecoveryOperations.mockResolvedValue([operation])
    render(<AuthPage embedded />)
    const retry = await screen.findByRole('button', { name: 'Retry Sync' })
    expect(retry).toBeEnabled()
    await user.click(retry)
    expect(authMocks.retryBlockedSyncOperation).toHaveBeenCalledWith('account-1', 'transient-1')
    expect(syncNow).toHaveBeenCalledOnce()
    expect(await screen.findByText(/Retry requested.*remain saved until the cloud confirms/i)).toBeInTheDocument()
  })

  it('keeps the recovery inspection route read-only and skips legacy conflict migration', () => {
    window.history.replaceState({}, '', '/ProgressTracker/#/settings?recoveryPreview=1#sync-data')
    const syncNow = vi.fn()
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, syncNow, syncStatus: 'idle' })
    render(<AuthPage embedded />)

    expect(screen.getByText(/automatic and manual sync are paused on this page/i)).toBeInTheDocument()
    expect(screen.getByText('Recovery Preview')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument()
    expect(authMocks.listSyncConflicts).not.toHaveBeenCalled()
    expect(authMocks.listSyncRecoveryOperations).not.toHaveBeenCalled()
    expect(syncNow).not.toHaveBeenCalled()
    expect(screen.getByText('Advanced tools', { selector: 'summary' }).parentElement).toHaveAttribute('open')
  })

  it('offers guest backup only after the guest workspace is ready', () => {
    authMocks.useAuth.mockReturnValue({ status: 'signed-out', user: null, workspaceStatus: 'loading', workspaceUserId: null })
    const view = render(<AuthPage />)
    expect(screen.queryByTestId('backup-workspace')).not.toBeInTheDocument()

    authMocks.useAuth.mockReturnValue({ status: 'signed-out', user: null, workspaceStatus: 'ready', workspaceUserId: null })
    view.rerender(<AuthPage />)
    expect(screen.getByTestId('backup-workspace')).toHaveTextContent('guest')
  })

  it('offers backup only for the workspace matching the signed-in account', async () => {
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-a', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-b' })
    const view = render(<AuthPage />)
    expect(screen.queryByTestId('backup-workspace')).not.toBeInTheDocument()

    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-a', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-a' })
    view.rerender(<AuthPage />)
    // The signed-in workspace backup stays collapsed until requested.
    const backupDisclosure = screen.getByText('Backup & Restore', { selector: 'summary' })
    expect(backupDisclosure.parentElement).not.toHaveAttribute('open')
    await userEvent.setup().click(backupDisclosure)
    expect(screen.getByTestId('backup-workspace')).toHaveTextContent('account-a')
  })

  it('keeps backup and advanced tools collapsed until keyboard or pointer activation', async () => {
    const user = userEvent.setup()
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-a', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-a', syncStatus: 'idle' })
    render(<AuthPage embedded />)
    const backupSummary = screen.getByText('Backup & Restore', { selector: 'summary' })
    const advancedSummary = screen.getByText('Advanced tools', { selector: 'summary' })
    expect(backupSummary.parentElement).not.toHaveAttribute('open')
    expect(advancedSummary.parentElement).not.toHaveAttribute('open')
    backupSummary.focus()
    expect(backupSummary).toHaveFocus()
    expect(backupSummary.tabIndex).toBe(0)
    await user.click(backupSummary)
    expect(backupSummary.parentElement).toHaveAttribute('open')
    await user.click(advancedSummary)
    expect(advancedSummary.parentElement).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: 'Export Sync Diagnostics' })).toBeInTheDocument()
    expect(screen.getByText('Recovery Preview')).toBeInTheDocument()
  })

  it.each([320, 360, 390, 430])('keeps account controls responsive at %ipx in light and dark themes', (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-a', email: 'person-with-a-long-address@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-a' })
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme
      const { unmount } = render(<AuthPage embedded />)
      expect(screen.getByText('person-with-a-long-address@example.com')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
      expect(accountStyles).toMatch(/@media \(max-width:\s*430px\)[\s\S]*?\.account-sync-issues/)
      expect(accountStyles).toMatch(/\.account-sync-identity \.auth-account-email[^}]*overflow-wrap:\s*anywhere/s)
      expect(accountStyles).toMatch(/\.account-sync-badge[^}]*background:\s*var\(--surface-muted\)/s)
      unmount()
    }
    delete document.documentElement.dataset.theme
  })

  it('shows owner-scoped conflict choices and requires an explicit selection', async () => {
    const user = userEvent.setup()
    const conflict = { id: 'conflict-1', ownerUserId: 'account-1', entity: 'tracker', entityId: 'tracker-1', localPayload: { id: 'tracker-1', name: 'Local version' }, remoteRecord: { user_id: 'account-1', server_revision: 2, definition: { id: 'tracker-1', name: 'Cloud version' } }, detectedAt: '2026-01-01T00:00:00.000Z' }
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn(), syncStatus: 'idle' })
    authMocks.listSyncConflicts.mockResolvedValue([conflict])
    authMocks.resolveSyncConflict.mockResolvedValue(undefined)
    render(<AuthPage />)

    expect(await screen.findByRole('heading', { name: 'Conflicting versions' })).toBeInTheDocument()
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

    expect(await screen.findByRole('heading', { name: 'Conflicting versions' })).toBeInTheDocument()
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

  it('shows the tracker name and validation details while retaining blocked payload access without offering unchanged retries', async () => {
    const user = userEvent.setup()
    const trackerId = '8e0c514e-ad75-47e1-abed-a770023b545e'
    const blocked = { id: 'f4d5f15b-b890-437b-9fe2-bb9d8d23b1c6', ownerUserId: 'account-1', entity: 'tracker', entityId: trackerId, operation: 'upsert', expectedRevision: 1, payload: { id: trackerId, schemaVersion: 8, name: '100 Days Of MERN', nested: { longValue: 'x'.repeat(600) } }, createdAt: '2026-01-01T00:00:00.000Z', attempts: 1, status: 'blocked', lastError: 'The server rejected this saved change (23514).', failureCode: '23514', failureDiagnostic: { code: '23514', message: 'schema v8 custom streak rule validation failed', table: 'trackers', constraint: 'trackers_streak_rule_v8_check' } }
    const blockedV10 = { ...blocked, id: '28bf5f83-9c6b-4ab4-b61f-acfee4e74d2e', payload: { ...blocked.payload, schemaVersion: 10 }, createdAt: '2026-01-02T00:00:00.000Z' }
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'person@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn(), syncStatus: 'idle' })
    authMocks.listSyncRecoveryOperations.mockResolvedValue([blocked, blockedV10, { ...blocked, id: 'older-blocked', status: 'superseded', supersededByRevision: 4 }])
    render(<AuthPage />)
    const card = await screen.findByRole('heading', { name: '100 Days Of MERN' })
    const issueCard = card.closest('article')!
    expect(issueCard).toHaveTextContent('2 rejected changes are grouped here')
    expect(within(issueCard).getByRole('button', { name: 'Retry Sync' })).toBeDisabled()
    expect(within(issueCard).getByText(/permanently rejected.*23514/i)).toBeInTheDocument()
    await user.click(within(issueCard).getByRole('button', { name: 'Revert to Cloud' }))
    expect(within(issueCard).getByTestId('recovery-preview')).toHaveAttribute('data-tracker-id', trackerId)
    await user.click(within(card.closest('article')!).getByText('Technical details and saved payload'))
    expect(issueCard).toHaveTextContent('23514')
    expect(issueCard).toHaveTextContent('trackers_streak_rule_v8_check')
    const payload = within(issueCard).getAllByLabelText('Rejected payload for 100 Days Of MERN')
    expect(payload).toHaveLength(2)
    expect(payload[0]).toHaveTextContent('100 Days Of MERN')
    expect(payload[0]).toHaveTextContent('x'.repeat(600))
    expect(issueCard).toHaveClass('blocked-sync-operation')
    await user.click(screen.getByText('Advanced tools', { selector: 'summary' }))
    expect(screen.getByText(/Historical rejection · superseded by successful revision 4/)).toBeInTheDocument()
  })

  it('hides prior account conflict details immediately when the signed-in account changes', async () => {
    const privateConflict = { id: 'private-conflict', ownerUserId: 'account-1', entity: 'tracker', entityId: 'private-tracker', localPayload: { id: 'private-tracker', name: 'Account one secret' }, remoteRecord: null, detectedAt: '2026-01-01T00:00:00.000Z' }
    authMocks.listSyncConflicts.mockResolvedValueOnce([privateConflict]).mockResolvedValueOnce([])
    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-1', email: 'one@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn() })
    const view = render(<AuthPage />)
    const localVersion = await screen.findByText('This device’s version', { selector: 'summary' })
    await userEvent.setup().click(localVersion)
    expect(await screen.findByText(/Account one secret/)).toBeInTheDocument()

    authMocks.useAuth.mockReturnValue({ status: 'signed-in', user: { id: 'account-2', email: 'two@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'account-2', signOut: vi.fn(), passwordRecovery: false, completePasswordRecovery: vi.fn() })
    view.rerender(<AuthPage />)

    expect(screen.queryByText(/Account one secret/)).not.toBeInTheDocument()
  })
})
