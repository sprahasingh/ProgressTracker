import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { backupRecordCount, createWorkspaceBackup, downloadWorkspaceBackup } from '../../db/workspaceBackup'

export function WorkspaceBackup({ ownerUserId }: { ownerUserId: string | null }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  return <section className="workspace-backup" aria-labelledby="workspace-backup-title">
    <h3 id="workspace-backup-title">Local backup</h3>
    <p>Download this workspace’s local records, deletion markers, and pending sync/conflict data as JSON. Keep the file somewhere private.</p>
    <Button variant="secondary" onClick={() => void handleExport()} disabled={busy}>
      {busy ? 'Preparing backup…' : 'Download workspace backup'}
    </Button>
    {message && <p className="auth-success" role="status">{message}</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
  </section>
}
