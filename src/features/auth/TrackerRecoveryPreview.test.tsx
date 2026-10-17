import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TrackerRecoveryPreview } from './TrackerRecoveryPreview'

const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share')
const originalCanShare = Object.getOwnPropertyDescriptor(navigator, 'canShare')

const mocks = vi.hoisted(() => ({
  createPreview: vi.fn(), canRepair: vi.fn(() => true), discard: vi.fn(), repair: vi.fn(),
  createWorkspaceBackup: vi.fn(), downloadWorkspaceBackup: vi.fn(), previewRestore: vi.fn(),
}))
vi.mock('../../db/trackerRecoveryPreview', () => ({
  createTrackerRecoveryPreview: mocks.createPreview,
  canQueueConfirmedMeasureRepair: mocks.canRepair,
  discardRejectedTrackerChanges: mocks.discard,
  queueConfirmedMeasureRepair: mocks.repair,
}))
vi.mock('../../db/workspaceBackup', () => ({
  createWorkspaceBackup: mocks.createWorkspaceBackup,
  downloadWorkspaceBackup: mocks.downloadWorkspaceBackup,
  previewWorkspaceRestore: mocks.previewRestore,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalShare) Object.defineProperty(navigator, 'share', originalShare)
  else Reflect.deleteProperty(navigator, 'share')
  if (originalCanShare) Object.defineProperty(navigator, 'canShare', originalCanShare)
  else Reflect.deleteProperty(navigator, 'canShare')
})

const preview = {
  generatedAt: '2026-10-17T00:00:00.000Z', ownerUserId: 'recovery-owner', cloudReadOnly: true,
  readyForReview: true, safeToExecute: false, status: 'ready-for-review', blockers: [],
  trackers: [{
    trackerId: '8e0c514e-ad75-47e1-abed-a770023b545e', name: '100 Days Of MERN', localSchemaVersion: 10,
    localAcknowledgedRevision: 1, cloudSchemaVersion: 6, cloudRevision: 1, cloudMetricType: 'quantity', localMetricType: 'duration', proposedMetricType: 'quantity',
    latestRuleVersion: { revision: 2, application: 'recalculate-all-history', effectiveFrom: '2026-10-16', metricType: 'quantity', matchesCurrentAfterCorrection: true },
    historicalRuleVersions: [], milestoneSnapshots: [], diffs: [{ path: 'metrics[progress].valueType', before: 'duration', after: 'quantity' }], discardDiffs: [], discardBlockers: [], proposedDefinition: {}, localConflicts: [], permanentDeletionRequests: [], permanentDeletionLedger: [],
    localEntries: [], cloudEntries: [], entryConflicts: [], operations: [{ id: 'blocked-mern-v8', entity: 'tracker', entityId: '8e0c514e-ad75-47e1-abed-a770023b545e', status: 'blocked', expectedRevision: 1, schemaVersion: 8, obsolete: true, payload: { metrics: [{ id: 'progress', valueType: 'duration' }] }, lastError: null }],
  }],
  unrelatedPendingOperationsExcluded: true, progressionState: { localMaterializedRecords: false, note: 'XP and streaks are derived.' },
  backup: { version: 1, manifest: { trackerCount: 2, entryCount: 3, operationCount: 4, syncRecordCount: 5, deletionRequestCount: 0 } },
} as never

describe('tracker recovery preview controls', () => {
  it('shows the read-only preview, marks the obsolete operation, and offers the scoped backup', async () => {
    mocks.createPreview.mockReset().mockResolvedValue(preview)
    mocks.downloadWorkspaceBackup.mockReset()
    mocks.createWorkspaceBackup.mockResolvedValue({ format: 'workspace-backup' })
    mocks.previewRestore.mockResolvedValue({ conflicts: [] })
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: 'Inspect recovery state' }))
    expect(await screen.findByText(/fresh cloud revision 1/)).toBeInTheDocument()
    expect(screen.getByText(/obsolete; never replay/)).toBeInTheDocument()
    expect(screen.getByText(/XP and streaks are derived/i)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Complete saved operation payload'))
    expect(screen.getByText(/"valueType": "duration"/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save verified, restorable workspace backup' }))
    await waitFor(() => expect(mocks.downloadWorkspaceBackup).toHaveBeenCalledOnce())
  })

  it('uses iOS Safari’s file share sheet when available so the backup can be saved to Files', async () => {
    mocks.createPreview.mockResolvedValue(preview)
    mocks.createWorkspaceBackup.mockResolvedValue({ format: 'workspace-backup' })
    mocks.previewRestore.mockResolvedValue({ conflicts: [] })
    mocks.downloadWorkspaceBackup.mockReset()
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: vi.fn(() => true) })
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: 'Inspect recovery state' }))
    await screen.findByText(/fresh cloud revision 1/)
    expect(screen.getByRole('button', { name: 'Repair 100 Days Of MERN measure' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save verified, restorable workspace backup' }))
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('backup'), files: [expect.any(File)] })))
    expect(await screen.findByText(/choose Save to Files/i)).toBeInTheDocument()
    expect(mocks.downloadWorkspaceBackup).not.toHaveBeenCalled()
  })

  it('requires a fresh exported backup after repairing one tracker', async () => {
    mocks.createPreview.mockReset().mockResolvedValue(preview)
    mocks.repair.mockReset().mockResolvedValue(undefined)
    mocks.createWorkspaceBackup.mockResolvedValue({ format: 'workspace-backup' })
    mocks.previewRestore.mockResolvedValue({ conflicts: [] })
    mocks.downloadWorkspaceBackup.mockReset()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: 'Inspect recovery state' }))
    await screen.findByText(/fresh cloud revision 1/)
    fireEvent.click(screen.getByRole('button', { name: 'Save verified, restorable workspace backup' }))
    await waitFor(() => expect(mocks.downloadWorkspaceBackup).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Repair 100 Days Of MERN measure' }))

    await waitFor(() => expect(mocks.repair).toHaveBeenCalledOnce())
    expect(screen.queryByText(/Backup file was exported/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Repair 100 Days Of MERN measure' })).toBeDisabled()
  })
})
