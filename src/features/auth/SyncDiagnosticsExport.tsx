import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { createSyncDiagnosticsExport } from '../../db/syncDiagnosticsExport'

export function SyncDiagnosticsExport({ userId }: { userId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [clipboardJson, setClipboardJson] = useState<string | null>(null)

  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl) }, [fileUrl])

  async function exportDiagnostics() {
    setState('busy')
    setMessage('')
    setFileUrl(null)
    setFile(null)
    setClipboardJson(null)
    try {
      const json = await createSyncDiagnosticsExport(userId)
      const report = JSON.parse(json) as { summary?: { totalRelevantOperations?: number } }
      const blob = new Blob([json], { type: 'application/json' })
      const nextFile = new File([blob], 'progress-tracker-sync-diagnostics.json', { type: 'application/json' })
      let createdUrl: string | null = null
      try { if (typeof URL.createObjectURL === 'function') createdUrl = URL.createObjectURL(blob) } catch { /* use copy fallback below */ }
      if (createdUrl) {
        setFileUrl(createdUrl)
        setFile(nextFile)
      } else {
        setClipboardJson(json)
      }
      setState('success')
      setMessage(!createdUrl
        ? 'File download is unavailable. Copy the diagnostics JSON to share it after review.'
        : report.summary?.totalRelevantOperations === 0
        ? 'No persisted sync operations were found. An empty diagnostics report is ready to download or share.'
        : 'Diagnostics are ready. Download or share the file, then review it before sharing with support.')
    } catch {
      setState('error')
      setMessage('Sync diagnostics could not be read or exported. Your saved sync data was not changed.')
    }
  }

  async function shareDiagnostics() {
    if (!file) return
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean; share?: (data: ShareData) => Promise<void> }
    try {
      if (!nav.share || !nav.canShare?.({ files: [file] })) throw new Error('Sharing files is unavailable.')
      await nav.share({ files: [file], title: 'ProgressTracker Sync Diagnostics' })
      setMessage('Diagnostics shared. The file contains operation identifiers; review it before sending.')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setMessage('The share sheet is unavailable. Use Download diagnostics instead.')
    }
  }

  async function copyDiagnostics() {
    if (!clipboardJson) return
    try {
      await navigator.clipboard.writeText(clipboardJson)
      setMessage('Diagnostics JSON copied. Review it before sharing.')
    } catch {
      setState('error')
      setMessage('This browser cannot download or copy the diagnostics file.')
    }
  }

  return <div className="sync-diagnostics-export">
    <div><h4>Export Sync Diagnostics</h4><p>Prepare a redacted report to help diagnose saved sync failures. It includes operation identifiers; review the file before sharing.</p></div>
    <Button variant="secondary" onClick={() => void exportDiagnostics()} disabled={state === 'busy'}>{state === 'busy' ? 'Preparing…' : 'Export Sync Diagnostics'}</Button>
    {fileUrl && <div className="sync-diagnostics-actions"><a className="button button-secondary" href={fileUrl} download="progress-tracker-sync-diagnostics.json">Download diagnostics</a>{typeof navigator !== 'undefined' && 'share' in navigator && <Button variant="secondary" onClick={() => void shareDiagnostics()}>Share diagnostics</Button>}</div>}
    {clipboardJson && <Button variant="secondary" onClick={() => void copyDiagnostics()}>Copy diagnostics JSON</Button>}
    {message && <p className={state === 'error' ? 'auth-error' : 'auth-success'} role={state === 'error' ? 'alert' : 'status'}>{message}</p>}
  </div>
}
