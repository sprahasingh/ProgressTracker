import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { createTrackerRecoveryPreview, discardRejectedTrackerChanges, getConfirmedMeasureRepairBlockers, getTrackerRecoveryBlockers, queueConfirmedMeasureRepair, TRACKER_RECOVERY_TARGETS, type TrackerRecoveryPreview as Preview } from '../../db/trackerRecoveryPreview'
import { createWorkspaceBackup, downloadWorkspaceBackup, previewWorkspaceRestore, type WorkspaceBackup } from '../../db/workspaceBackup'
import { isTrackerRecoveryInspectionMode } from './recoveryInspectionMode'

const recoveryFieldNames: Record<string, string> = {
  name: 'Name', description: 'Description', kind: 'Tracker kind', status: 'Status', categoryId: 'Category', tags: 'Tags',
  icon: 'Icon', accent: 'Color', schedule: 'Schedule', startDate: 'Start date', deadline: 'Deadline', scheduling: 'Scheduling',
  metrics: 'Measures', qualificationRule: 'Success rule', streakRuleMode: 'Streak rule mode', streakRule: 'Streak rule',
  strictMode: 'Strict mode', customFields: 'Custom fields', milestones: 'Milestones', ruleVersions: 'Rule history',
}

function recoveryFieldName(path: string) {
  return recoveryFieldNames[path] ?? path.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())
}

export function TrackerRecoveryPreview({ userId, trackerId }: { userId: string; trackerId?: string }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [preparedBackup, setPreparedBackup] = useState<WorkspaceBackup | null>(null)
  const [backupPreparing, setBackupPreparing] = useState(false)
  const [backupSaving, setBackupSaving] = useState(false)
  const [backupExportInitiated, setBackupExportInitiated] = useState(false)
  const [backupAcknowledged, setBackupAcknowledged] = useState(false)
  const [downloadFallbackAvailable, setDownloadFallbackAvailable] = useState(false)
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
    setPreparedBackup(null)
    setBackupExportInitiated(false)
    setBackupAcknowledged(false)
    setDownloadFallbackAvailable(false)
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

  async function prepareBackup() {
    if (!preview) return
    setBackupPreparing(true)
    setPreparedBackup(null)
    setBackupExportInitiated(false)
    setBackupAcknowledged(false)
    setDownloadFallbackAvailable(false)
    setError(false)
    setMessage('Preparing and validating a restorable workspace backup…')
    try {
      const backup = await createWorkspaceBackup(userId)
      const checked = await previewWorkspaceRestore(backup, userId)
      if (checked.conflicts.length) throw new Error(`The workspace backup failed its restore preview: ${checked.conflicts.join('; ')}`)
      setPreparedBackup(backup)
      setMessage('Backup is ready to save. Tap Save backup to open the share sheet or start a browser download.')
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? `Backup preparation failed: ${cause.message}` : 'Backup preparation failed. Local records were not changed.')
    } finally {
      setBackupPreparing(false)
    }
  }

  function initiateBackupDownload(backup: WorkspaceBackup) {
    try {
      downloadWorkspaceBackup(backup)
      setBackupExportInitiated(true)
      setDownloadFallbackAvailable(false)
      setMessage('The browser download was initiated. It cannot confirm the file was saved; check Downloads or Files, then acknowledge below.')
    } catch (cause) {
      setError(true)
      setDownloadFallbackAvailable(true)
      setMessage(cause instanceof Error ? `Backup export failed: ${cause.message}` : 'Backup export failed. The verified backup is still ready to try again.')
    }
  }

  function saveBackup() {
    if (!preparedBackup || backupSaving) return
    const file = new File([JSON.stringify(preparedBackup, null, 2)], 'progress-tracker-workspace-backup.json', { type: 'application/json' })
    const nav = navigator as unknown as { canShare?: (data: ShareData) => boolean; share?: (data: ShareData) => Promise<void> }
    let canShareFile = Boolean(nav.share && !nav.canShare)
    try { if (nav.share && nav.canShare) canShareFile = nav.canShare({ files: [file] }) } catch { canShareFile = false }
    if (!canShareFile || !nav.share) {
      initiateBackupDownload(preparedBackup)
      return
    }
    setBackupSaving(true)
    setError(false)
    setMessage('Opening the system share sheet…')
    let sharePromise: Promise<void>
    try {
      // Invoke share synchronously from this button event. Waiting for IndexedDB
      // or restore validation here can consume iOS Safari's transient gesture.
      sharePromise = nav.share({ files: [file], title: 'ProgressTracker blocked tracker recovery backup' })
    } catch (cause) {
      setBackupSaving(false)
      setDownloadFallbackAvailable(true)
      setError(true)
      setMessage(cause instanceof Error ? `The share sheet could not open: ${cause.message}. Try Download backup.` : 'The share sheet could not open. Try Download backup.')
      return
    }
    void sharePromise.then(() => {
      setBackupExportInitiated(true)
      setDownloadFallbackAvailable(false)
      setMessage('Sharing finished, but the browser cannot confirm the destination. Check that the file is in Files, then acknowledge below.')
    }).catch((cause: unknown) => {
      const canceled = typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError'
      setError(!canceled)
      setDownloadFallbackAvailable(true)
      setMessage(canceled
        ? 'Sharing was canceled. No backup was confirmed; try Save backup again or choose Download backup.'
        : cause instanceof Error ? `The share sheet failed: ${cause.message}. Try Download backup.` : 'The share sheet failed. Try Download backup.')
    }).finally(() => setBackupSaving(false))
  }

  function downloadPreparedBackup() {
    if (!preparedBackup || backupSaving) return
    setBackupSaving(true)
    setError(false)
    try {
      initiateBackupDownload(preparedBackup)
    } finally {
      setBackupSaving(false)
    }
  }

  async function repair(trackerId: string, name: string) {
    if (!preview || !backupAcknowledged || !window.confirm(`Repair ${name} by restoring quantity for its existing Progress measure, preserving all other settings, and queueing a new operation at the reviewed cloud revision?`)) return
    setActionBusy(trackerId)
    setError(false)
    try {
      await queueConfirmedMeasureRepair(preview, trackerId, true)
      // The workspace now contains a new queued operation. Require a backup of
      // this updated state before another tracker can be repaired.
      setPreparedBackup(null)
      setBackupExportInitiated(false)
      setBackupAcknowledged(false)
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
    if (!preview || !backupAcknowledged || !window.confirm(confirmation)) return
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
  return <section ref={previewRef} id="account-recovery-preview" className="sync-conflicts tracker-recovery-preview account-recovery-preview" tabIndex={-1} aria-labelledby={`tracker-recovery-preview-title-${trackerId ?? 'all'}`}>
    <h3 id={`tracker-recovery-preview-title-${trackerId ?? 'all'}`}>{trackerId ? 'Review cloud version' : 'Blocked tracker recovery preview'}</h3>
    <p>{trackerId ? 'Fetch the latest cloud definition and related records. Review every proposed change, then export a verified backup and confirm before restoring.' : 'Inspect blocked tracker changes and their latest cloud records. Inspection is read-only. Repair and discard actions require a saved backup, fresh revision checks, and separate confirmation.'}</p>
    <p className="auth-hint">The backup contains full check-in values and notes, operation payloads, and saved errors for these trackers. Keep the file private.</p>
    <Button variant="secondary" onClick={() => void inspect()} disabled={busy}>{busy ? 'Reading records…' : trackerId ? 'Fetch latest cloud version' : 'Inspect recovery state'}</Button>
    {message && <p className={error ? 'auth-error' : 'auth-success'} role={error ? 'alert' : 'status'}>{message}</p>}
    {preview && <div className="tracker-recovery-results">
      <p><strong>Preview status:</strong> {preview.status} · generated {new Date(preview.generatedAt).toLocaleString()}</p>
      <p><strong>Recovery actions:</strong> only the scoped, guarded actions shown below are available. No hosted write is sent during inspection.</p>
      {visibleTrackers.map((tracker) => <article className="sync-conflict" key={tracker.trackerId}>
        <h4>{tracker.name}</h4>
        <p>Local schema v{tracker.localSchemaVersion ?? 'unknown'} · acknowledged cloud revision {tracker.localAcknowledgedRevision ?? 'unknown'} · cloud schema v{tracker.cloudSchemaVersion ?? 'unknown'} · fresh cloud revision {tracker.cloudRevision ?? 'unavailable'}</p>
        {(tracker.metricSummary ?? []).length > 0 && <p>Measures: {(tracker.metricSummary ?? []).map((metric) => `${metric.name}: local ${metric.localType ?? 'missing'}, cloud ${metric.cloudType ?? 'missing'}`).join('; ')}</p>}
        {tracker.discardDiffs.length > 0 ? <><p><strong>Undo preview:</strong> restore the latest cloud configuration and discard {tracker.discardDiffs.length} changed section{tracker.discardDiffs.length === 1 ? '' : 's'} ({tracker.discardDiffs.map((diff) => recoveryFieldName(diff.path)).join(', ')}). All {tracker.localEntries.length} local check-in record{tracker.localEntries.length === 1 ? '' : 's'} will be preserved; cloud check-ins will not be changed.</p><details><summary>Review exact configuration differences</summary><ul>{tracker.discardDiffs.map((diff) => <li key={diff.path}><strong>{recoveryFieldName(diff.path)}</strong>: <code>{JSON.stringify(diff.before)}</code> → <code>{JSON.stringify(diff.after)}</code></li>)}</ul></details></> : <p>Undo will restore the latest cloud definition. No configuration differences were found in this preview.</p>}
        {tracker.diffs.length > 0 && <details><summary>Repair comparison details</summary><ul>{tracker.diffs.map((diff) => <li key={diff.path}><code>{diff.path}</code>: {String(diff.before)} → {String(diff.after)}</li>)}</ul>{tracker.latestRuleVersion && <p>Latest rule evaluation: revision {tracker.latestRuleVersion.revision}, {tracker.latestRuleVersion.application}, {tracker.latestRuleVersion.matchesCurrentAfterCorrection ? 'matches the corrected definition' : 'needs review'}.</p>}</details>}
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
      <section className="recovery-backup-export" aria-labelledby={`recovery-backup-title-${trackerId ?? 'all'}`}>
        <h4 id={`recovery-backup-title-${trackerId ?? 'all'}`}>Backup before undo</h4>
        <p>Prepare and validate a full workspace backup first. After that, save it to Files or Downloads and confirm you can retrieve it.</p>
        <Button variant="secondary" disabled={busy || backupPreparing || backupSaving || actionBusy !== null} onClick={() => void prepareBackup()}>{backupPreparing ? 'Preparing backup…' : preparedBackup ? 'Prepare a new backup' : 'Prepare verified backup'}</Button>
        {preparedBackup && <div className="recovery-backup-save-actions">
          <p role="status">Backup passed restore validation and is ready to save.</p>
          <Button variant="secondary" disabled={backupSaving || backupPreparing || actionBusy !== null} onClick={saveBackup}>{backupSaving ? 'Opening share sheet…' : 'Save backup'}</Button>
          {downloadFallbackAvailable && <Button variant="secondary" disabled={backupSaving || actionBusy !== null} onClick={downloadPreparedBackup}>Download backup</Button>}
        </div>}
        {backupExportInitiated && <div className="recovery-backup-acknowledgement">
          <p>The browser cannot verify that the file reached its destination. Find the exported file in Files or Downloads before continuing.</p>
          <label><input type="checkbox" checked={backupAcknowledged} onChange={(event) => setBackupAcknowledged(event.currentTarget.checked)} /> I verified the backup is available and can be selected for restore.</label>
        </div>}
      </section>
      {preview.trackers.map((tracker) => {
        const candidateOperations = tracker.operations.filter((operation) => operation.entity === 'tracker' && ['blocked', 'pending'].includes(operation.status))
        const scopedBlockers = getTrackerRecoveryBlockers(preview, tracker.trackerId)
        const undoBlockers = [...new Set([...(tracker.discardBlockers ?? []), ...scopedBlockers])]
        const schemaMatches = tracker.localSchemaVersion === tracker.cloudSchemaVersion
        const canUndo = candidateOperations.length > 0 && undoBlockers.length === 0 && schemaMatches
        const showRepair = tracker.diffs.length > 0 && TRACKER_RECOVERY_TARGETS.some((target) => target.trackerId === tracker.trackerId)
        const repairBlockers = getConfirmedMeasureRepairBlockers(preview, tracker.trackerId)
        return <section className="tracker-recovery-actions" key={`actions-${tracker.trackerId}`} aria-label={`${tracker.name} recovery actions`}>
          {candidateOperations.length > 0
            ? <Button variant="secondary" disabled={!backupAcknowledged || !canUndo || actionBusy !== null || busy || backupPreparing || backupSaving} onClick={() => void discard(tracker.trackerId, tracker.name)}>{actionBusy === tracker.trackerId ? 'Undoing…' : 'Undo changes'}</Button>
            : <p>No rejected configuration changes are available to undo.</p>}
          {!backupAcknowledged && candidateOperations.length > 0 && <p className="auth-hint">Undo is locked until you save the validated backup and confirm you can retrieve it.</p>}
          {undoBlockers.length > 0 && <div className="auth-hint" role="alert"><strong>Undo is blocked:</strong><ul>{undoBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
          {!schemaMatches && undoBlockers.length === 0 && <p className="auth-hint" role="alert">Undo is blocked because local schema v{tracker.localSchemaVersion ?? 'unknown'} and cloud schema v{tracker.cloudSchemaVersion ?? 'unknown'} differ and no verified conversion is available.</p>}
          {showRepair && <details className="recovery-other-options"><summary>Other recovery options</summary>
            <p>Repair keeps the local tracker schema and queues only the verified measure correction.</p>
            <Button variant="secondary" disabled={!backupAcknowledged || repairBlockers.length > 0 || actionBusy !== null || busy || backupPreparing || backupSaving} onClick={() => void repair(tracker.trackerId, tracker.name)}>{actionBusy === tracker.trackerId ? 'Repairing…' : 'Repair Changes'}</Button>
            {!backupAcknowledged && <p className="auth-hint">Repair is locked until you save the validated backup and confirm you can retrieve it.</p>}
            {repairBlockers.length > 0 && <div className="auth-hint" role="alert"><strong>Repair is unavailable:</strong><ul>{repairBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
          </details>}
        </section>
      })}
      <p className="auth-hint">The backup contains all local account data and can be restored through Account → Import backup. The app cannot verify that your browser saved the file.</p>
    </div>}
  </section>
}
