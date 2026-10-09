import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBackup } from './WorkspaceBackup'

const backupMocks = vi.hoisted(() => ({
  backup: {} as Record<string, unknown>,
  createWorkspaceBackup: vi.fn(), downloadWorkspaceBackup: vi.fn(), backupRecordCount: vi.fn(),
  previewWorkspaceRestore: vi.fn(), restoreWorkspaceBackup: vi.fn(),
}))

vi.mock('../../db/workspaceBackup', () => ({
  createWorkspaceBackup: backupMocks.createWorkspaceBackup,
  downloadWorkspaceBackup: backupMocks.downloadWorkspaceBackup,
  backupRecordCount: backupMocks.backupRecordCount,
  previewWorkspaceRestore: backupMocks.previewWorkspaceRestore,
  restoreWorkspaceBackup: backupMocks.restoreWorkspaceBackup,
}))

const preview = (conflicts: string[] = []) => ({ backup: backupMocks.backup, added: { trackers: 2 }, alreadyPresent: { trackers: 1 }, conflicts })

describe('workspace backup controls', () => {
  beforeEach(() => {
    backupMocks.createWorkspaceBackup.mockReset().mockResolvedValue(backupMocks.backup)
    backupMocks.downloadWorkspaceBackup.mockReset()
    backupMocks.backupRecordCount.mockReset().mockReturnValue(3)
    backupMocks.previewWorkspaceRestore.mockReset().mockResolvedValue(preview())
    backupMocks.restoreWorkspaceBackup.mockReset().mockResolvedValue({ ...preview(), added: { trackers: 2 } })
  })
  afterEach(() => cleanup())

  it('offers an explicit preview before restoring and reports successful completion', async () => {
    const user = userEvent.setup()
    render(<WorkspaceBackup ownerUserId="restore-account" />)
    const file = new File(['{}'], 'backup.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText(/Restore a backup/), { target: { files: [file] } })

    await screen.findByText(/Preview: 2 records can be added/)
    expect(backupMocks.previewWorkspaceRestore).toHaveBeenCalledWith({}, 'restore-account')
    expect(backupMocks.restoreWorkspaceBackup).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Restore 2 records' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Restore complete: 2 records added'))
    expect(backupMocks.restoreWorkspaceBackup).toHaveBeenCalledWith(backupMocks.backup, 'restore-account')
  })

  it('does not offer restore when preview detects conflicts', async () => {
    backupMocks.previewWorkspaceRestore.mockResolvedValueOnce(preview(['trackers.id: conflict']))
    render(<WorkspaceBackup ownerUserId={null} />)
    const file = new File(['{}'], 'backup.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText(/Restore a backup/), { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Restore is blocked by 1 conflict')
    expect(screen.queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument()
  })
})
