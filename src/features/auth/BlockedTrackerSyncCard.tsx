import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { SyncOperation } from '../../db/models'
import { isRetryableTransientSyncFailure, retryBlockedSyncOperation, type RetryBlockedResult } from '../../db/syncRecoveryRepository'
import { TRACKER_RECOVERY_TARGETS } from '../../db/trackerRecoveryPreview'
import { TrackerRecoveryPreview } from './TrackerRecoveryPreview'

export function BlockedTrackerSyncCard({ userId, trackerId, operations, syncNow, onOperationsChanged }: { userId: string; trackerId: string; operations: SyncOperation[]; syncNow?: () => Promise<unknown>; onOperationsChanged: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [copiedPayloadId, setCopiedPayloadId] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const [retryBusy, setRetryBusy] = useState(false)
  const [retryMessage, setRetryMessage] = useState('')
  const [retryError, setRetryError] = useState(false)
  const trackerOperation = [...operations].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]
  const retryCandidate = trackerOperation && isRetryableTransientSyncFailure(trackerOperation.failureCode, trackerOperation.lastError) ? trackerOperation : undefined
  const payload = trackerOperation?.payload as { name?: unknown } | undefined
  const trackerName = typeof payload?.name === 'string' ? payload.name : 'Tracker'
  const supported = Boolean(trackerId)
  const repairSupported = operations.some((operation) => operation.failureCode === '23514')
    && TRACKER_RECOVERY_TARGETS.some((target) => target.trackerId === trackerId)
  const retryExplanation = !retryCandidate && operations.some((operation) => operation.failureCode === '23514')
    ? 'This saved configuration was rejected. Retry is disabled until it is corrected.'
    : retryCandidate
      ? 'Retry checks the latest cloud revision first. It will stop and show a conflict if the cloud has changed.'
      : 'This saved change cannot be retried unchanged. Review its recovery options below.'

  async function retry() {
    if (!retryCandidate || retryBusy) return
    setRetryBusy(true)
    setRetryError(false)
    setRetryMessage('')
    try {
      const result: RetryBlockedResult = await retryBlockedSyncOperation(userId, retryCandidate.id)
      if (result === 'conflict') {
        setRetryMessage('The cloud revision changed. This operation was not replayed; review the conflicting versions above.')
        return
      }
      setRetryMessage('Cloud revision verified. Retrying this saved tracker change…')
      await syncNow?.()
      setRetryMessage('Retry requested. The operation will remain saved until the cloud confirms it; check the account status for the result.')
    } catch (cause) {
      setRetryError(true)
      setRetryMessage(cause instanceof Error ? cause.message : 'Retry stopped safely. The saved operation remains available for review.')
    } finally {
      setRetryBusy(false)
      onOperationsChanged()
    }
  }

  async function copyPayload(operation: SyncOperation) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(operation.payload, null, 2))
      setCopiedPayloadId(operation.id)
      setCopyError(false)
    } catch {
      setCopyError(true)
    }
  }

  return <article className="sync-conflict blocked-sync-operation">
    <h4>{trackerName}</h4>
    <p>The server rejected this saved change. Your local tracker and entries remain saved on this device{operations.length > 1 ? `; ${operations.length} rejected changes are grouped here` : ''}.</p>
    <div className="blocked-sync-card-actions">
      <Button variant="secondary" className={!retryCandidate ? 'blocked-sync-retry-disabled' : undefined} disabled={!retryCandidate || retryBusy} aria-describedby={`retry-blocked-help-${trackerId}`} onClick={() => void retry()}>{retryBusy ? 'Checking cloud…' : 'Try again'}</Button>
      <Button variant="secondary" disabled={!supported} aria-expanded={supported ? previewOpen : undefined} aria-controls={supported ? `revert-preview-${trackerId}` : undefined} onClick={() => setPreviewOpen((open) => !open)}>
        {previewOpen ? 'Close undo preview' : 'Undo unsynced changes'}
      </Button>
    </div>
    <p className="blocked-sync-action-help" id={`retry-blocked-help-${trackerId}`}>{retryExplanation}</p>
    {retryMessage && <p className={retryError ? 'auth-error' : 'auth-hint'} role={retryError ? 'alert' : 'status'}>{retryMessage}</p>}
    {repairSupported && <details className="blocked-sync-other-recovery"><summary>Other recovery options</summary><p>Use the guarded measure repair only when the preview confirms the cloud revision and the saved backup is ready.</p><Button variant="secondary" onClick={() => setPreviewOpen(true)}>Repair Changes</Button></details>}
    {previewOpen && supported && <div className="blocked-sync-revert-preview" id={`revert-preview-${trackerId}`}><TrackerRecoveryPreview userId={userId} trackerId={trackerId} /></div>}
    <details><summary>Technical details and saved payload</summary>{operations.map((operation) => <div key={operation.id}><p className="sync-operation-id">Operation {operation.id} · record {operation.entityId}</p><p>{operation.lastError ?? 'The server rejected this saved change.'}</p>{operation.failureDiagnostic && <p className="sync-server-diagnostic">{operation.failureDiagnostic.message}{operation.failureDiagnostic.table && ` · ${operation.failureDiagnostic.table}`}{operation.failureDiagnostic.constraint && ` · ${operation.failureDiagnostic.constraint}`}</p>}<pre aria-label={`Rejected payload for ${trackerName}`}>{JSON.stringify(operation.payload, null, 2)}</pre><Button variant="secondary" size="small" onClick={() => void copyPayload(operation)}>{copiedPayloadId === operation.id ? 'Payload copied' : 'Copy saved payload'}</Button></div>)}{copyError && <p className="auth-error" role="alert">The payload could not be copied. Expand it to review the saved diagnostic.</p>}</details>
  </article>
}
