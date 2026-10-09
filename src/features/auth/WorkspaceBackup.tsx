import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { backupRecordCount, createWorkspaceBackup, downloadWorkspaceBackup, previewWorkspaceRestore, restoreWorkspaceBackup, type WorkspaceRestorePreview } from '../../db/workspaceBackup'

function readBackupFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('The backup file could not be read.'))
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The backup file is not text.'))
    reader.readAsText(file)
  })
}

export function WorkspaceBackup({ ownerUserId }: { ownerUserId: string | null }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restorePreview, setRestorePreview] = useState<WorkspaceRestorePreview | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)

  async function handleExport() {
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const backup = await createWorkspaceBackup(ownerUserId)
      downloadWorkspaceBackup(backup)
      setMessage(`Backup downloaded with ${backupRecordCount(backup)} saved records and sync items.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The local backup could not be created.')
    } finally {
      setBusy(false)
    }
  }

  async function handleBackupFile(file: File | undefined) {
    setRestorePreview(null)
    setMessage(null)
    setError(null)
    if (!file) return
    try {
      const value: unknown = JSON.parse(await readBackupFile(file))
      setRestorePreview(await previewWorkspaceRestore(value, ownerUserId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The selected backup could not be read.')
    }
  }

  async function handleRestore() {
    if (!restorePreview || restorePreview.conflicts.length > 0) return
    setRestoreBusy(true)
    setMessage(null)
    setError(null)
    try {
      const result = await restoreWorkspaceBackup(restorePreview.backup, ownerUserId)
      const added = Object.values(result.added).reduce((total, count) => total + count, 0)
      const skipped = Object.values(result.alreadyPresent).reduce((total, count) => total + count, 0)
      setRestorePreview(result)
      setMessage(`Restore complete: ${added} records added; ${skipped} identical records already existed.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The backup could not be restored. Existing records were kept.')
    } finally {
      setRestoreBusy(false)
    }
  }

  const plannedAdditions = restorePreview ? Object.values(restorePreview.added).reduce((total, count) => total + count, 0) : 0

  return <section className="workspace-backup" aria-labelledby="workspace-backup-title">
    <h3 id="workspace-backup-title">Local backup</h3>
    <p>Download this workspace’s local records, deletion markers, and pending sync/conflict data as JSON. Keep the file somewhere private.</p>
    <Button variant="secondary" onClick={() => void handleExport()} disabled={busy}>
      {busy ? 'Preparing backup…' : 'Download workspace backup'}
    </Button>
    {message && <p className="auth-success" role="status">{message}</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    <div className="workspace-restore">
      <label htmlFor="workspace-backup-file">Restore a backup into this same workspace</label>
      <input id="workspace-backup-file" type="file" accept=".json,application/json" onChange={(event) => void handleBackupFile(event.currentTarget.files?.[0])} />
      <p>Restore adds missing records, skips identical records, and stops if it finds a conflicting ID or date. It never replaces existing data. The file must belong to this exact guest workspace or account.</p>
      {restorePreview && <div className="restore-preview" aria-live="polite">
        <p>Preview: {plannedAdditions} records can be added; {Object.values(restorePreview.alreadyPresent).reduce((total, count) => total + count, 0)} identical records are already present.</p>
        {restorePreview.conflicts.length > 0 && <p className="auth-error" role="alert">Restore is blocked by {restorePreview.conflicts.length} conflict{restorePreview.conflicts.length === 1 ? '' : 's'}; no records will be changed. First conflict: {restorePreview.conflicts[0]}</p>}
        {restorePreview.conflicts.length === 0 && plannedAdditions > 0 && <Button onClick={() => void handleRestore()} disabled={restoreBusy}>{restoreBusy ? 'Restoring…' : `Restore ${plannedAdditions} records`}</Button>}
        {restorePreview.conflicts.length === 0 && plannedAdditions === 0 && <p>Nothing needs restoring.</p>}
      </div>}
    </div>
  </section>
}
