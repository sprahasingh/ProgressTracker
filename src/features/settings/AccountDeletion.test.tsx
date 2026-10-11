import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountDeletion } from './AccountDeletion'

const mocks = vi.hoisted(() => ({
  auth: { status: 'signed-in' as string, user: { id: 'user-1', email: 'user@example.com' }, prepareAccountDeletion: vi.fn(), resumeAccountSyncAfterDeletionFailure: vi.fn(), finishAccountDeletion: vi.fn() },
  invoke: vi.fn(), countPending: vi.fn(), createBackup: vi.fn(), downloadBackup: vi.fn(), notify: vi.fn(),
}))

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => ({ functions: { invoke: mocks.invoke } }) }))
vi.mock('../../db/database', () => ({ countPendingWorkspaceSyncOperations: mocks.countPending }))
vi.mock('../../db/workspaceBackup', () => ({ backupRecordCount: () => 2, createWorkspaceBackup: mocks.createBackup, downloadWorkspaceBackup: mocks.downloadBackup }))
vi.mock('../../components/ui/ToastProvider', () => ({ useToast: () => ({ notify: mocks.notify }) }))

afterEach(() => { cleanup(); document.body.style.overflow = '' })

describe('AccountDeletion', () => {
  beforeEach(() => {
    mocks.auth.status = 'signed-in'
    mocks.auth.user = { id: 'user-1', email: 'user@example.com' }
    mocks.auth.prepareAccountDeletion.mockReset().mockResolvedValue(0)
    mocks.auth.resumeAccountSyncAfterDeletionFailure.mockReset()
    mocks.auth.finishAccountDeletion.mockReset().mockResolvedValue(null)
    mocks.invoke.mockReset().mockImplementation(async (_name: string, { body }: { body: { action: string } }) => body.action === 'verify-password'
      ? { data: { authorized: true, authorization: 'a'.repeat(64) }, error: null }
      : { data: { deleted: true }, error: null })
    mocks.countPending.mockReset().mockResolvedValue(0)
    mocks.createBackup.mockReset().mockResolvedValue({ stores: {} })
    mocks.downloadBackup.mockReset()
    mocks.notify.mockReset()
  })

  it('does not render for guests', () => {
    mocks.auth.status = 'signed-out'
    mocks.auth.user = null as never
    const { container } = render(<AccountDeletion />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows one dialog with password and DELETE inputs and does not submit an incorrect confirmation', async () => {
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    expect(await screen.findByRole('dialog', { name: 'Delete your account?' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Current account password/)).toBeInTheDocument()
    expect(screen.getByText(/set a password first under Settings/)).toBeInTheDocument()
    const confirmation = screen.getByLabelText(/Type DELETE to confirm/)
    fireEvent.change(screen.getByLabelText(/Current account password/), { target: { value: 'secret' } })
    fireEvent.change(confirmation, { target: { value: 'delete' } })
    expect(screen.getByRole('button', { name: 'Permanently Delete Account' })).toBeDisabled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('requires a verified password and exact DELETE before cleanup', async () => {
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    await screen.findByText('No pending offline changes were found.')
    fireEvent.change(screen.getByLabelText(/Current account password/), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }))
    await waitFor(() => expect(mocks.auth.finishAccountDeletion).toHaveBeenCalledWith('user-1'))
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'delete-account', { body: { action: 'verify-password', password: 'secret' } })
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'delete-account', { body: { action: 'delete', confirmation: 'DELETE', authorization: 'a'.repeat(64) } })
    expect(mocks.auth.prepareAccountDeletion).toHaveBeenCalledWith('user-1')
  })

  it('guards against duplicate submission before the button rerenders', async () => {
    let release!: (result: { data: { authorized: boolean; authorization: string }; error: null }) => void
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    await screen.findByText('No pending offline changes were found.')
    fireEvent.change(screen.getByLabelText(/Current account password/), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/), { target: { value: 'DELETE' } })
    const button = screen.getByRole('button', { name: 'Permanently Delete Account' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce())
    release({ data: { authorized: true, authorization: 'a'.repeat(64) }, error: null })
    await waitFor(() => expect(mocks.auth.finishAccountDeletion).toHaveBeenCalledOnce())
  })

  it('reports incorrect passwords and resumes synchronization', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('unauthorized'), { context: new Response(JSON.stringify({ error: 'The password could not be verified.' }), { status: 401 }) }) })
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    await screen.findByText('No pending offline changes were found.')
    fireEvent.change(screen.getByLabelText(/Current account password/), { target: { value: 'wrong' } })
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The password could not be verified.')
    expect(mocks.invoke).toHaveBeenCalledOnce()
    expect(mocks.auth.finishAccountDeletion).not.toHaveBeenCalled()
    expect(mocks.auth.resumeAccountSyncAfterDeletionFailure).toHaveBeenCalledWith('user-1')
  })

  it('explains expired one-use authorization and leaves the account available', async () => {
    mocks.invoke.mockImplementationOnce(async () => ({ data: { authorized: true, authorization: 'a'.repeat(64) }, error: null }))
      .mockImplementationOnce(async () => ({ data: null, error: Object.assign(new Error('unauthorized'), { context: new Response(JSON.stringify({ error: 'Password verification expired or was already used. Verify your password again.' }), { status: 401 }) }) }))
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    await screen.findByText('No pending offline changes were found.')
    fireEvent.change(screen.getByLabelText(/Current account password/), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Verify your password again/)
    expect(mocks.auth.finishAccountDeletion).not.toHaveBeenCalled()
    expect(mocks.auth.resumeAccountSyncAfterDeletionFailure).toHaveBeenCalledWith('user-1')
  })

  it('keeps deletion disabled until pending local changes have been checked', async () => {
    let resolveCount!: (count: number) => void
    mocks.countPending.mockReturnValueOnce(new Promise<number>((resolve) => { resolveCount = resolve }))
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    fireEvent.change(screen.getByLabelText(/Current account password/), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/), { target: { value: 'DELETE' } })
    expect(screen.getByRole('button', { name: 'Permanently Delete Account' })).toBeDisabled()
    resolveCount(2)
    await screen.findByText(/2 local changes have not synchronized/i)
    expect(screen.getByRole('button', { name: 'Permanently Delete Account' })).toBeEnabled()
  })

  it('keeps local data and offers status retry when the deletion response is lost', async () => {
    mocks.invoke.mockImplementationOnce(async () => ({ data: { authorized: true, authorization: 'a'.repeat(64) }, error: null }))
      .mockImplementationOnce(async () => ({ data: null, error: Object.assign(new Error('network'), { name: 'FunctionsFetchError' }) }))
      .mockImplementationOnce(async () => ({ data: { deleted: false }, error: null }))
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    await screen.findByText('No pending offline changes were found.')
    fireEvent.change(screen.getByLabelText(/Current account password/), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }))
    const retry = await screen.findByRole('button', { name: 'Retry deletion status' })
    expect(retry).toBeEnabled()
    fireEvent.click(retry)
    expect(await screen.findByRole('alert')).toHaveTextContent(/account is still active/i)
    expect(mocks.auth.finishAccountDeletion).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'delete-account', { body: { action: 'status' } })
  })

  it('supports exporting the local workspace before deletion', async () => {
    render(<AccountDeletion />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export My Data' }))
    await waitFor(() => expect(mocks.downloadBackup).toHaveBeenCalled())
    expect(await screen.findByText(/Workspace export downloaded/)).toBeInTheDocument()
  })
})
