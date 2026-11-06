import { useState } from 'react'
import type { StorageDiagnostic } from '../../db/storageDiagnostics'

export function StorageDiagnosticDetails({ diagnostic }: { diagnostic: StorageDiagnostic | null }) {
  const [copyStatus, setCopyStatus] = useState('')
  if (!diagnostic) return null

  async function copyDiagnostic() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2))
      setCopyStatus('Diagnostic copied. It contains operation metadata only, not tracker data or credentials.')
    } catch {
      setCopyStatus('Copy is unavailable in this browser. Share the operation, stage, category, browser, error name, and error code shown below.')
    }
  }

  return <details className="storage-diagnostic">
    <summary>Technical diagnostic</summary>
    <dl>
      <dt>Operation</dt><dd>{diagnostic.operation}</dd>
      <dt>Stage</dt><dd>{diagnostic.stage}</dd>
      <dt>Category</dt><dd>{diagnostic.category}</dd>
      <dt>Browser</dt><dd>{diagnostic.browser}</dd>
      {diagnostic.errorName && <><dt>Error name</dt><dd>{diagnostic.errorName}</dd></>}
      {diagnostic.errorCode !== undefined && <><dt>Error code</dt><dd>{diagnostic.errorCode}</dd></>}
      <dt>Time</dt><dd>{diagnostic.occurredAt}</dd>
    </dl>
    <button className="button button-secondary button-small" type="button" onClick={() => void copyDiagnostic()}>Copy safe diagnostic</button>
    {copyStatus && <p role="status">{copyStatus}</p>}
  </details>
}
