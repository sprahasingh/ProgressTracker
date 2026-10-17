import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { canQueueConfirmedMeasureRepair, createTrackerRecoveryPreview, discardRejectedTrackerChanges, queueConfirmedMeasureRepair, type TrackerRecoveryPreview as Preview } from '../../db/trackerRecoveryPreview'
import { createWorkspaceBackup, downloadWorkspaceBackup, previewWorkspaceRestore } from '../../db/workspaceBackup'
import { isTrackerRecoveryInspectionMode } from './recoveryInspectionMode'

export function TrackerRecoveryPreview({ userId, trackerId }: { userId: string; trackerId?: string }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [backupSaved, setBackupSaved] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const navigate = useNavigate()
  const previewRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!isTrackerRecoveryInspectionMode()) return
    const timer = window.setTimeout(() => {
      const target = previewRef.current
      if (!target) return
      target.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
      target.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  async function inspect() {
    setBusy(true)
    setMessage('')
    setError(false)
    setPreview(null)
    setBackupSaved(false)
    try {
      const result = await createTrackerRecoveryPreview(userId, trackerId ? { trackerIds: [trackerId] } : {})
      setPreview(result)
      setMessage(result.status === 'ready-for-review'
        ? 'Fresh cloud state is ready for review. Save a verified backup and explicitly confirm to restore it locally; inspection itself sends no cloud writes.'
        : 'The preview found missing or changed records. Review each conflict before recovery; no local changes have been made.')
    } catch (cause) {
      setError(true)
      const detail = cause instanceof Error ? ` ${cause.message}` : ''
      setMessage(`Recovery preview could not be completed.${detail} Local records were not changed and no sync write was sent.`)
    } finally {
      setBusy(false)
    }
  }

  async function downloadBackup() {
    if (!preview) return
    try {
      const backup = await createWorkspaceBackup(userId)
      const checked = await previewWorkspaceRestore(backup, userId)
      if (checked.conflicts.length) throw new Error('The full workspace backup failed its restore preview.')
      const file = new File([JSON.stringify(backup, null, 2)], 'progress-tracker-workspace-backup.json', { type: 'application/json' })
      const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean; share?: (data: ShareData) => Promise<void> }
      if (nav.share && nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title: 'ProgressTracker blocked tracker recovery backup' })
        setBackupSaved(true)
        setMessage('The restorable workspace backup passed its restore preview. On iPhone or iPad, choose Save to Files to keep the private file.')
        return
      }
      downloadWorkspaceBackup(backup)
      setBackupSaved(true)
      setMessage('The restorable workspace backup passed its restore preview and was exported. Keep the file private; it includes your account workspace data.')
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError(true)
      setMessage('The recovery backup could not be downloaded. Local records were not changed.')
    }
  }

  async function repair(trackerId: string, name: string) {
    if (!preview || !backupSaved || !window.confirm(`Repair ${name} by restoring quantity for its existing Progress measure, preserving all other settings, and queueing a new operation at the reviewed cloud revision?`)) return
    setActionBusy(trackerId)
    setError(false)
    try {
      await queueConfirmedMeasureRepair(preview, trackerId, true)
      // The workspace now contains a new queued operation. Require a backup of
      // this updated state before another tracker can be repaired.
      setBackupSaved(false)
      setMessage(`${name}: corrected configuration is saved locally as a new sync operation. The rejected operations remain preserved and are not replayed. Sync this account to submit the corrected operation.`)
      setPreview(await createTrackerRecoveryPreview(userId, trackerId ? { trackerIds: [trackerId] } : {}))
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? cause.message : 'The repair stopped without changing tracker data.')
    } finally { setActionBusy(null) }
  }

  async function discard(trackerId: string, name: string) {
    const operationCount = preview?.trackers.find((tracker) => tracker.trackerId === trackerId)?.operations
      .filter((operation) => operation.entity === 'tracker' && (operation.status === 'blocked' || preview.genericScope && operation.status === 'pending')).length ?? 0
    const confirmation = preview?.genericScope
      ? `Discard ${operationCount} blocked or pending configuration operation${operationCount === 1 ? '' : 's'} for ${name} and restore its latest confirmed cloud configuration? The exact definition differences are listed in the preview. Valid independent check-ins and unrelated operations will be preserved. The cloud tracker and its saved check-ins will not be deleted.`
      : `Discard rejected changes for ${name} and restore the latest confirmed cloud configuration? This abandons unsynced settings for this tracker. The cloud tracker and its saved check-ins will not be deleted.`
    if (!preview || !backupSaved || !window.confirm(confirmation)) return
    setActionBusy(trackerId)
    setError(false)
    try {
      await discardRejectedTrackerChanges(preview, trackerId, true)
      setMessage(`${name}: rejected operations were retained for audit and marked discarded. Opening the latest cloud configuration in the tracker editor.`)
      navigate(`/trackers/${encodeURIComponent(trackerId)}/edit`)
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? cause.message : 'Discard stopped without changing tracker data.')
    } finally { setActionBusy(null) }
  }

  const visibleTrackers = preview?.trackers.filter((tracker) => !trackerId || tracker.trackerId === trackerId) ?? []
  const trackerName = preview?.trackers.find((tracker) => tracker.trackerId === trackerId)?.name
  const visibleBlockers = preview?.blockers.filter((blocker) => !trackerName || blocker.startsWith(`${trackerName}:`) || !blocker.includes(':')) ?? []

  return <section ref={previewRef} id="account-recovery-preview" className="sync-conflicts tracker-recovery-preview account-recovery-preview" tabIndex={-1} aria-labelledby={`tracker-recovery-preview-title-${trackerId ?? 'all'}`}>
    <h3 id={`tracker-recovery-preview-title-${trackerId ?? 'all'}`}>{trackerId ? 'Review cloud version' : 'Blocked tracker recovery preview'}</h3>
    <p>{trackerId ? 'Fetch the latest cloud definition and related records. Review every proposed change, then export a verified backup and confirm before restoring.' : 'Inspect blocked tracker changes and their latest cloud records. Inspection is read-only. Repair and discard actions require a saved backup, fresh revision checks, and separate confirmation.'}</p>
    <p className="auth-hint">The backup contains full check-in values and notes, operation payloads, and saved errors for these trackers. Keep the file private.</p>
    <Button variant="secondary" onClick={() => void inspect()} disabled={busy}>{busy ? 'Reading records…' : trackerId ? 'Fetch latest cloud version' : 'Inspect recovery state'}</Button>
    {message && <p className={error ? 'auth-error' : 'auth-success'} role={error ? 'alert' : 'status'}>{message}</p>}
    {preview && <div className="tracker-recovery-results">
      <p><strong>Preview status:</strong> {preview.status} · generated {new Date(preview.generatedAt).toLocaleString()}</p>
      <p><strong>Recovery actions:</strong> only the scoped, guarded actions shown below are available. No hosted write is sent during inspection.</p>
      {visibleBlockers.length > 0 && <div role="alert"><h4>Conflicts to review</h4><ul>{visibleBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
      {visibleTrackers.map((tracker) => <article className="sync-conflict" key={tracker.trackerId}>
        <h4>{tracker.name}</h4>
        <p>Local schema v{tracker.localSchemaVersion ?? 'unknown'} · acknowledged cloud revision {tracker.localAcknowledgedRevision ?? 'unknown'} · cloud schema v{tracker.cloudSchemaVersion ?? 'unknown'} · fresh cloud revision {tracker.cloudRevision ?? 'unavailable'}</p>
        {(tracker.metricSummary ?? []).length > 0 && <p>Measures: {(tracker.metricSummary ?? []).map((metric) => `${metric.name} (${metric.id}): local ${metric.localType ?? 'missing'}, cloud ${metric.cloudType ?? 'missing'}`).join('; ')}</p>}
        {tracker.diffs.length > 0 ? <><h5>Proposed definition changes</h5><ul>{tracker.diffs.map((diff) => <li key={diff.path}><code>{diff.path}</code>: {String(diff.before)} → {String(diff.after)}</li>)}</ul></> : <p>No measure-type change is proposed for this tracker.</p>}
        {tracker.discardDiffs.length > 0 && <details><summary>Changes discard would abandon ({tracker.discardDiffs.length})</summary><ul>{tracker.discardDiffs.map((diff) => <li key={diff.path}><code>{diff.path}</code>: <code>{JSON.stringify(diff.before)}</code> → <code>{JSON.stringify(diff.after)}</code></li>)}</ul></details>}
        {tracker.latestRuleVersion && <p>Latest rule version: revision {tracker.latestRuleVersion.revision}, {tracker.latestRuleVersion.application}, effective {tracker.latestRuleVersion.effectiveFrom}; evaluation {tracker.latestRuleVersion.matchesCurrentAfterCorrection ? 'matches after the proposed correction' : 'needs review'}.</p>}
        {tracker.historicalRuleVersions.length > 0 && <details><summary>Earlier rule-version snapshots</summary><ul>{tracker.historicalRuleVersions.map((version) => <li key={`${version.revision}-${version.effectiveFrom}`}>Revision {version.revision} · {version.application} · {version.effectiveFrom} · measure type {version.metricType ?? 'missing'}</li>)}</ul></details>}
        {tracker.milestoneSnapshots.length > 0 && <details><summary>Milestone measure snapshots</summary><ul>{tracker.milestoneSnapshots.map((milestone) => <li key={milestone.id}>{milestone.title}: {milestone.measureTypeSnapshot ?? 'no type snapshot'}</li>)}</ul></details>}
        {tracker.localConflicts.length > 0 && <details><summary>Unresolved local conflicts ({tracker.localConflicts.length})</summary><ul>{tracker.localConflicts.map((conflict) => <li key={conflict.id}>{conflict.entity} · {conflict.detectedAt} · {conflict.reason ?? 'No saved reason'} · {conflict.id}</li>)}</ul></details>}
        {(tracker.permanentDeletionRequests.length > 0 || tracker.permanentDeletionLedger.length > 0) && <details><summary>Permanent deletion state</summary><pre>{JSON.stringify({ requests: tracker.permanentDeletionRequests, ledger: tracker.permanentDeletionLedger }, null, 2)}</pre></details>}
        <details><summary>Local check-ins ({tracker.localEntries.length}) and cloud check-ins ({tracker.cloudEntries.length})</summary>
          <h5>Local records, including deleted entries</h5>
          {tracker.localEntries.length ? <ul>{tracker.localEntries.map((entry) => <li key={entry.id}>{entry.date} · {entry.outcome} · {entry.deletedAt ? 'soft-deleted' : 'active'} · {entry.syncStatus} · {entry.id}<details><summary>Full local check-in values and note</summary><pre>{JSON.stringify({ values: entry.values, note: entry.note, createdAt: entry.createdAt, updatedAt: entry.updatedAt, deletedAt: entry.deletedAt }, null, 2)}</pre></details></li>)}</ul> : <p>No local check-ins found.</p>}
          <h5>Cloud records</h5>
          {tracker.cloudEntries.length ? <ul>{tracker.cloudEntries.map((entry) => <li key={entry.id}>{entry.date} · {entry.outcome} · {entry.deletedAt ? 'soft-deleted' : 'active'} · revision {entry.serverRevision} · {entry.id}<details><summary>Full cloud check-in values and note</summary><pre>{JSON.stringify({ values: entry.values, note: entry.note, createdAt: entry.createdAt, updatedAt: entry.updatedAt, deletedAt: entry.deletedAt }, null, 2)}</pre></details></li>)}</ul> : <p>No cloud check-ins found.</p>}
          {tracker.entryConflicts.length > 0 && <ul>{tracker.entryConflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}</ul>}
        </details>
        <details><summary>Related local operations ({tracker.operations.length})</summary><ul>{tracker.operations.map((operation) => <li key={operation.id}>{operation.entity} · {operation.status} · schema v{operation.schemaVersion ?? 'entry'} · expected revision {operation.expectedRevision ?? 'unknown'} · {operation.obsolete ? 'obsolete; never replay' : 'current recovery candidate'} · {operation.id}{operation.failureCode && <p>Database code {operation.failureCode}{operation.databaseTable ? ` · ${operation.databaseTable}` : ''}{operation.databaseConstraint ? ` · ${operation.databaseConstraint}` : ''}</p>}<details><summary>Complete saved operation payload</summary><pre>{JSON.stringify(operation.payload, null, 2)}</pre></details>{operation.serverError && <details><summary>Complete saved server diagnostic</summary><pre>{JSON.stringify({ message: operation.serverError, table: operation.databaseTable, constraint: operation.databaseConstraint, sqlState: operation.failureCode }, null, 2)}</pre></details>}{operation.lastError ? <details><summary>Saved client error</summary><p>{operation.lastError}</p></details> : null}</li>)}</ul></details>
      </article>)}
      <p>{preview.progressionState.note}</p>
      <Button variant="secondary" onClick={() => void downloadBackup()}>Save verified, restorable workspace backup</Button>
      {backupSaved && <label className="auth-hint"><input type="checkbox" checked readOnly /> Backup file was exported. Keep it in a private location before proceeding.</label>}
      {preview.trackers.map((tracker) => {
        const hasRepair = tracker.diffs.length > 0 && canQueueConfirmedMeasureRepair(preview, tracker.trackerId)
        const hasTrackerBlocker = preview.blockers.some((blocker) => blocker.startsWith(`${tracker.name}:`))
        const discardBlockers = tracker.discardBlockers ?? []
        const candidateOperations = tracker.operations.filter((operation) => operation.entity === 'tracker' && ['blocked', 'pending'].includes(operation.status))
        const canDiscard = candidateOperations.length > 0 && discardBlockers.length === 0 && !hasTrackerBlocker && tracker.localSchemaVersion === tracker.cloudSchemaVersion
        return <div className="auth-actions" key={`actions-${tracker.trackerId}`}>
          {hasRepair && <Button disabled={!backupSaved || actionBusy !== null || busy} onClick={() => void repair(tracker.trackerId, tracker.name)}>{actionBusy === tracker.trackerId ? 'Repairing…' : `Repair ${tracker.name} measure`}</Button>}
          {candidateOperations.length > 0 && <Button variant="secondary" disabled={!backupSaved || !canDiscard || actionBusy !== null || busy} onClick={() => void discard(tracker.trackerId, tracker.name)}>{`Discard rejected changes for ${tracker.name}`}</Button>}
          {candidateOperations.length > 0 && !canDiscard && <p className="auth-hint">Revert to Cloud is disabled: {discardBlockers.join(' ') || 'Resolve the listed tracker blocker before restoring cloud configuration.'}</p>}
        </div>
      })}
      <p className="auth-hint">Recovery stays disabled until the full workspace backup passes the app’s restore preview and is exported. This backup includes all local account data. Restore it later through Account → Import backup.</p>
    </div>}
  </section>
}
