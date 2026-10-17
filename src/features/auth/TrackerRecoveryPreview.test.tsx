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
  getConfirmedMeasureRepairBlockers: vi.fn((current: { trackers: Array<{ trackerId: string; localSchemaVersion: number | null; cloudSchemaVersion: number | null }> }, id: string) => {
    const tracker = current.trackers.find((candidate) => candidate.trackerId === id)
    return tracker && tracker.localSchemaVersion !== tracker.cloudSchemaVersion ? ['Repair requires matching local and cloud schemas.'] : []
  }),
  getTrackerRecoveryBlockers: vi.fn((current: { blockers: string[]; trackers: Array<{ trackerId: string; name: string }> }, id: string) => current.blockers.filter((blocker) => blocker.includes(id) || !current.trackers.some((tracker) => tracker.trackerId !== id && blocker.startsWith(`${tracker.name}:`)))),
  TRACKER_RECOVERY_TARGETS: [{ trackerId: '8e0c514e-ad75-47e1-abed-a770023b545e' }],
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
  window.history.replaceState({}, '', '/')
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

const cpPreview = {
  generatedAt: '2026-10-17T00:00:00.000Z', ownerUserId: 'recovery-owner', cloudReadOnly: true,
  readyForReview: true, safeToExecute: false, genericScope: false, status: 'ready-for-review', blockers: [],
  trackers: [{
    trackerId: '7d9798c5-9671-4139-9e59-56bb4544a805', name: '100 Days Of CP', localSchemaVersion: 8,
    localAcknowledgedRevision: 3, cloudSchemaVersion: 8, cloudRevision: 3, cloudMetricType: 'quantity', localMetricType: 'duration', proposedMetricType: 'quantity',
    latestRuleVersion: null, historicalRuleVersions: [], milestoneSnapshots: [], diffs: [], proposedDefinition: {},
    discardDiffs: [{ path: 'description', before: 'local', after: 'cloud' }, { path: 'metrics', before: [{ valueType: 'duration' }], after: [{ valueType: 'quantity' }] }, { path: 'streakRule', before: { operator: 'any' }, after: { operator: 'all' } }],
    discardBlockers: [], localConflicts: [], permanentDeletionRequests: [], permanentDeletionLedger: [], localEntries: [], cloudEntries: [], entryConflicts: [],
    operations: [{ id: 'cp-blocked', entity: 'tracker', entityId: '7d9798c5-9671-4139-9e59-56bb4544a805', status: 'blocked', expectedRevision: 3, schemaVersion: 8, obsolete: false, payload: {}, lastError: null }],
  }],
  unrelatedPendingOperationsExcluded: true, progressionState: { localMaterializedRecords: false, note: 'XP and streaks are derived.' },
  backup: { scope: { trackerIds: ['7d9798c5-9671-4139-9e59-56bb4544a805'], requiredOperationIds: ['cp-blocked'] }, manifest: { trackerCount: 1, entryCount: 0, operationCount: 1, syncRecordCount: 1, deletionRequestCount: 0 } },
} as any

describe('tracker recovery preview controls', () => {
  it('prepares the backup first, then starts mobile sharing from a fresh user gesture and requires acknowledgement', async () => {
    mocks.createPreview.mockReset().mockResolvedValue(cpPreview)
    mocks.createWorkspaceBackup.mockReset().mockResolvedValue({ format: 'workspace-backup' })
    mocks.previewRestore.mockReset().mockResolvedValue({ conflicts: [] })
    mocks.downloadWorkspaceBackup.mockReset()
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: vi.fn(() => true) })
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" trackerId="7d9798c5-9671-4139-9e59-56bb4544a805" /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: 'Fetch latest cloud version' }))
    await screen.findByText(/fresh cloud revision 3/i)
    expect(screen.getByText(/discard 3 changed sections/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare verified backup' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/backup is ready to save/i)
    expect(share).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Save backup' }))
    await waitFor(() => expect(share).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /i verified the backup is available/i }))
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeEnabled()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }))
    await waitFor(() => expect(mocks.discard).toHaveBeenCalledOnce())
    expect(mocks.discard.mock.calls[0]?.slice(1)).toEqual(['7d9798c5-9671-4139-9e59-56bb4544a805', true])
  })

  it('focuses the inspection preview when opened through the production hash deep link', async () => {
    window.history.replaceState({}, '', '/ProgressTracker/#/settings?recoveryPreview=1#sync-data')
    mocks.createPreview.mockReset()
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" /></MemoryRouter>)
    await waitFor(() => expect(document.getElementById('account-recovery-preview')).toHaveFocus())
  })

  it('shows the read-only preview, marks the obsolete operation, and offers the scoped backup', async () => {
    mocks.createPreview.mockReset().mockResolvedValue(preview)
    mocks.downloadWorkspaceBackup.mockReset()
    mocks.createWorkspaceBackup.mockResolvedValue({ format: 'workspace-backup' })
    mocks.previewRestore.mockResolvedValue({ conflicts: [] })
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: 'Inspect recovery state' }))
    expect(await screen.findByText(/fresh cloud revision 1/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/explicitly confirm to restore it locally/i)
    expect(screen.getByText(/obsolete; never replay/)).toBeInTheDocument()
    expect(screen.getByText(/XP and streaks are derived/i)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Complete saved operation payload'))
    expect(screen.getByText(/"valueType": "duration"/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare verified backup' }))
    await screen.findByText(/Backup passed restore validation/i)
    fireEvent.click(screen.getByRole('button', { name: 'Save backup' }))
    await waitFor(() => expect(mocks.downloadWorkspaceBackup).toHaveBeenCalledOnce())
  })

  it('uses iOS Safari’s file share sheet when available so the backup can be saved to Files', async () => {
    mocks.createPreview.mockResolvedValue(preview)
    mocks.createWorkspaceBackup.mockResolvedValue({ format: 'workspace-backup' })
    mocks.previewRestore.mockResolvedValue({ conflicts: [] })
    mocks.downloadWorkspaceBackup.mockReset()
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: 'Inspect recovery state' }))
    await screen.findByText(/fresh cloud revision 1/)
    expect(screen.getByRole('button', { name: 'Repair Changes' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare verified backup' }))
    await screen.findByText(/Backup passed restore validation/i)
    fireEvent.click(screen.getByRole('button', { name: 'Save backup' }))
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('backup'), files: [expect.any(File)] })))
    expect(await screen.findByText(/browser cannot confirm the destination/i)).toBeInTheDocument()
    expect(mocks.downloadWorkspaceBackup).not.toHaveBeenCalled()
  })

  it('reports a canceled share and offers an explicit download fallback without unlocking undo', async () => {
    mocks.createPreview.mockResolvedValue(cpPreview)
    mocks.createWorkspaceBackup.mockResolvedValue({ format: 'workspace-backup' })
    mocks.previewRestore.mockResolvedValue({ conflicts: [] })
    mocks.downloadWorkspaceBackup.mockReset()
    const share = vi.fn().mockRejectedValue(new DOMException('Canceled', 'AbortError'))
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: vi.fn(() => true) })
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" trackerId="7d9798c5-9671-4139-9e59-56bb4544a805" /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: 'Fetch latest cloud version' }))
    await screen.findByText(/fresh cloud revision 3/i)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare verified backup' }))
    await screen.findByText(/Backup passed restore validation/i)
    fireEvent.click(screen.getByRole('button', { name: 'Save backup' }))
    expect(await screen.findByText(/sharing was canceled/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download backup' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Download backup' }))
    await waitFor(() => expect(mocks.downloadWorkspaceBackup).toHaveBeenCalledOnce())
    expect(await screen.findByRole('checkbox', { name: /i verified the backup is available/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled()
  })

  it('shows the exact dependent-operation blocker for CP even with no saved check-ins', async () => {
    const unsafeCpPreview = {
      ...cpPreview,
      blockers: ['100 Days Of CP: Operation cp-entry-write references a missing local check-in cp-entry.'],
      trackers: cpPreview.trackers.map((tracker: any) => ({
        ...tracker,
        discardBlockers: ['A dependent check-in operation without a local row blocks safe discard.'],
        operations: [...tracker.operations, { id: 'cp-entry-write', entity: 'tracker_entry', entityId: 'cp-entry', status: 'blocked', expectedRevision: null, schemaVersion: null, obsolete: false, payload: { trackerId: '7d9798c5-9671-4139-9e59-56bb4544a805' }, lastError: null }],
      })),
    } as never
    mocks.createPreview.mockResolvedValue(unsafeCpPreview)
    mocks.createWorkspaceBackup.mockResolvedValue({ format: 'workspace-backup' })
    mocks.previewRestore.mockResolvedValue({ conflicts: [] })
    mocks.downloadWorkspaceBackup.mockReset()
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" trackerId="7d9798c5-9671-4139-9e59-56bb4544a805" /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: 'Fetch latest cloud version' }))
    await screen.findByText(/fresh cloud revision 3/i)
    expect(screen.getByText(/No local check-ins found/i)).toBeInTheDocument()
    expect(screen.getByText(/Operation cp-entry-write references a missing local check-in cp-entry/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare verified backup' }))
    await screen.findByText(/Backup passed restore validation/i)
    fireEvent.click(screen.getByRole('button', { name: 'Save backup' }))
    await waitFor(() => expect(mocks.downloadWorkspaceBackup).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('checkbox', { name: /i verified the backup is available/i }))
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled()
    expect(screen.getByText(/A dependent check-in operation without a local row blocks safe discard/i)).toBeInTheDocument()
  })

  it('keeps the MERN repair blocked when local and cloud schema versions differ', async () => {
    mocks.createPreview.mockReset().mockResolvedValue(preview)
    mocks.repair.mockReset().mockResolvedValue(undefined)
    mocks.createWorkspaceBackup.mockResolvedValue({ format: 'workspace-backup' })
    mocks.previewRestore.mockResolvedValue({ conflicts: [] })
    mocks.downloadWorkspaceBackup.mockReset()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MemoryRouter><TrackerRecoveryPreview userId="recovery-owner" /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: 'Inspect recovery state' }))
    await screen.findByText(/fresh cloud revision 1/)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare verified backup' }))
    await screen.findByText(/Backup passed restore validation/i)
    fireEvent.click(screen.getByRole('button', { name: 'Save backup' }))
    await waitFor(() => expect(mocks.downloadWorkspaceBackup).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('checkbox', { name: /i verified the backup is available/i }))
    expect(screen.getByRole('button', { name: 'Repair Changes' })).toBeDisabled()
    expect(screen.getByText(/Repair requires matching local and cloud schemas/i)).toBeInTheDocument()
    expect(mocks.repair).not.toHaveBeenCalled()
  })
})
