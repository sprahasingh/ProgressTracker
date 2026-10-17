import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncDiagnosticsExport } from './SyncDiagnosticsExport'

const diagnostics = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../db/syncDiagnosticsExport', () => ({ createSyncDiagnosticsExport: diagnostics.create }))

describe('SyncDiagnosticsExport', () => {
  beforeEach(() => {
    diagnostics.create.mockReset()
    diagnostics.create.mockResolvedValue('{"format":"progress-tracker-sync-diagnostics-v1"}')
  })

  it('offers an accessible, direct download action after preparing a report', async () => {
    const user = userEvent.setup()
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diagnostics')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { unmount } = render(<SyncDiagnosticsExport userId="account-uuid" />)
    await user.click(screen.getByRole('button', { name: 'Export Sync Diagnostics' }))
    expect(diagnostics.create).toHaveBeenCalledWith('account-uuid')
    expect(await screen.findByRole('link', { name: 'Download diagnostics' })).toHaveAttribute('download', 'progress-tracker-sync-diagnostics.json')
    expect(screen.getByRole('status')).toHaveTextContent(/review it before sharing/i)
    unmount()
    expect(revokeUrl).toHaveBeenCalledWith('blob:diagnostics')
    createUrl.mockRestore()
    revokeUrl.mockRestore()
  })

  it('announces read failures without exposing internals', async () => {
    diagnostics.create.mockRejectedValue(new Error('IndexedDB private failure'))
    const user = userEvent.setup()
    render(<SyncDiagnosticsExport userId="account-uuid" />)
    await user.click(screen.getByRole('button', { name: 'Export Sync Diagnostics' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be read or exported/i)
    expect(screen.getByRole('alert')).not.toHaveTextContent('IndexedDB private failure')
  })
})
