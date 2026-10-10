import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountDeletion } from './AccountDeletion'
import { requestAccountDeletionReauthentication } from '../auth/authService'

const mocks = vi.hoisted(() => ({
  auth: { status: 'signed-in' as string, user: { id: 'user-1', email: 'user@example.com' }, prepareAccountDeletion: vi.fn(), resumeAccountSyncAfterDeletionFailure: vi.fn(), finishAccountDeletion: vi.fn() },
  invoke: vi.fn(), countPending: vi.fn(), createBackup: vi.fn(), downloadBackup: vi.fn(), sessionToken: '',
}))

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => ({ functions: { invoke: mocks.invoke }, auth: { getSession: vi.fn().mockImplementation(async () => ({ data: { session: { access_token: mocks.sessionToken } } })) } }) }))
vi.mock('../../db/database', () => ({ countPendingWorkspaceSyncOperations: mocks.countPending }))
vi.mock('../../db/workspaceBackup', () => ({ backupRecordCount: () => 2, createWorkspaceBackup: mocks.createBackup, downloadWorkspaceBackup: mocks.downloadBackup }))
vi.mock('../auth/authService', () => ({ requestAccountDeletionReauthentication: vi.fn().mockResolvedValue({ error: null }) }))

afterEach(() => { cleanup(); document.body.style.overflow = '' })

function recentToken() {
  const payload = btoa(JSON.stringify({ amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }] })).replace(/=/g, '')
  return `header.${payload}.signature`
}

describe('AccountDeletion', () => {
  beforeEach(() => {
    mocks.auth.status = 'signed-in'
    mocks.auth.user = { id: 'user-1', email: 'user@example.com' }
    mocks.auth.prepareAccountDeletion.mockReset().mockResolvedValue(0)
    mocks.auth.resumeAccountSyncAfterDeletionFailure.mockReset()
    mocks.auth.finishAccountDeletion.mockReset().mockResolvedValue(null)
    mocks.invoke.mockReset().mockResolvedValue({ data: { deleted: true }, error: null })
    mocks.countPending.mockReset().mockResolvedValue(0)
    mocks.createBackup.mockReset().mockResolvedValue({ stores: {} })
    mocks.downloadBackup.mockReset()
    mocks.sessionToken = recentToken()
    sessionStorage.clear()
  })

  it('does not render for guests', () => {
    mocks.auth.status = 'signed-out'
    mocks.auth.user = null as never
    const { container } = render(<AccountDeletion />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an information dialog and the first confirmation does not delete', async () => {
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'More about Deleting your account' }))
    expect(await screen.findByText(/external copies or backups/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close explanation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to verification' }))
    await screen.findByRole('heading', { name: 'Verify and confirm deletion' })
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.auth.finishAccountDeletion).not.toHaveBeenCalled()
  })

  it('requires the typed confirmation and completes cleanup only after server confirmation', async () => {
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to verification' }))
    await screen.findByLabelText('Type DELETE to confirm')
    const finalButton = screen.getByRole('button', { name: 'Permanently Delete Account' })
    await screen.findByText(/Recent sign-in verified/)
    expect(finalButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'delete' } })
    expect(finalButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    expect(finalButton).toBeEnabled()
    fireEvent.click(finalButton)
    await waitFor(() => expect(mocks.auth.finishAccountDeletion).toHaveBeenCalledWith('user-1'))
    expect(mocks.auth.prepareAccountDeletion).toHaveBeenCalledWith('user-1')
    expect(mocks.invoke).toHaveBeenCalledWith('delete-account', { body: { confirmation: 'DELETE' } })
  })

  it('keeps final deletion disabled when recent identity verification is missing', async () => {
    const payload = btoa(JSON.stringify({ amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) - 10 * 60 }] })).replace(/=/g, '')
    mocks.sessionToken = `header.${payload}.signature`
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to verification' }))
    await screen.findByLabelText('Type DELETE to confirm')
    await screen.findByText(/Verify your identity with a fresh email sign-in/)
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    expect(screen.getByRole('button', { name: 'Permanently Delete Account' })).toBeDisabled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('requests an existing-account sign-in link and enables confirmation only after a fresh session returns', async () => {
    const stale = btoa(JSON.stringify({ amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) - 10 * 60 }] })).replace(/=/g, '')
    mocks.sessionToken = `header.${stale}.signature`
    const view = render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to verification' }))
    await screen.findByLabelText('Type DELETE to confirm')
    await screen.findByText(/Verify your identity with a fresh email sign-in/)
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send fresh sign-in link' }))
    expect(await screen.findByText(/secure sign-in link was sent/i)).toBeInTheDocument()
    expect(requestAccountDeletionReauthentication).toHaveBeenCalledWith('user@example.com', expect.stringContaining('#/settings'))
    expect(screen.getByRole('button', { name: 'Permanently Delete Account' })).toBeDisabled()
    mocks.sessionToken = recentToken()
    mocks.auth.user = { id: 'user-1', email: 'user@example.com', freshSession: true } as never
    view.rerender(<AccountDeletion />)
    await screen.findByText(/Recent sign-in verified/)
    expect(screen.getByRole('button', { name: 'Permanently Delete Account' })).toBeEnabled()
  })

  it('preserves the workspace and reopens sync after the server does not confirm deletion', async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: Object.assign(new Error('server unavailable'), { context: new Response('', { status: 422 }) }) })
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to verification' }))
    await screen.findByLabelText('Type DELETE to confirm')
    await screen.findByText(/Recent sign-in verified/)
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/server unavailable/i)
    expect(mocks.auth.finishAccountDeletion).not.toHaveBeenCalled()
    expect(mocks.auth.resumeAccountSyncAfterDeletionFailure).toHaveBeenCalledWith('user-1')
  })

  it('surfaces offline changes and requires a reviewed confirmation before deleting them', async () => {
    mocks.countPending.mockResolvedValue(1)
    mocks.auth.prepareAccountDeletion.mockResolvedValue(1)
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to verification' }))
    await screen.findByLabelText('Type DELETE to confirm')
    await screen.findByText(/Recent sign-in verified/)
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    expect(screen.getByText(/1 local change has not synchronized/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }))
    await waitFor(() => expect(mocks.auth.finishAccountDeletion).toHaveBeenCalledWith('user-1'))
    expect(mocks.invoke).toHaveBeenCalledOnce()
  })
})
