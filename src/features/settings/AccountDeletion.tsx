import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from '../../components/ui/IconButton'
import { InfoButton } from '../../components/ui/InfoButton'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { countPendingWorkspaceSyncOperations } from '../../db/database'
import { backupRecordCount, createWorkspaceBackup, downloadWorkspaceBackup } from '../../db/workspaceBackup'
import { getSupabaseClient } from '../../services/supabase/client'
import { requestAccountDeletionReauthentication } from '../auth/authService'
import { useAuth } from '../auth/AuthProvider'

const REAUTH_KEY = 'progress-tracker:delete-account-reauth'

function readReauthenticationRequestAt(): number | null {
  try { const value = Number(sessionStorage.getItem(REAUTH_KEY)); return value || null }
  catch { return null }
}

function tokenIssuedAt(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { amr?: unknown }
    if (!Array.isArray(payload.amr)) return null
    const timestamps = payload.amr.flatMap((method) => method && typeof method === 'object' && typeof (method as { timestamp?: unknown }).timestamp === 'number' ? [(method as { timestamp: number }).timestamp] : [])
    return timestamps.length ? Math.max(...timestamps) : null
  } catch { return null }
}

export function AccountDeletion() {
  const auth = useAuth()
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [typed, setTyped] = useState('')
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  const [recentAuthentication, setRecentAuthentication] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcomeUncertain, setOutcomeUncertain] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const panelRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const ownerId = auth.user?.id
  const email = auth.user?.email
  const isOpen = step > 0

  useModalLayer(isOpen, panelRef, () => {
    if (!busy && !outcomeUncertain) { restoreFocus.current = true; setStep(0); setError('') }
  })
  useVisualViewportBounds(isOpen, backdropRef)
  useEffect(() => { if (isOpen) closeRef.current?.focus() }, [isOpen])
  useEffect(() => {
    if (!isOpen && restoreFocus.current) { restoreFocus.current = false; document.getElementById('delete-account-start')?.focus() }
  }, [isOpen])
  useEffect(() => {
    const requestedAt = readReauthenticationRequestAt()
    if (!ownerId) return
    const client = getSupabaseClient()
    void client?.auth.getSession().then(({ data }) => {
      const issuedAt = data.session ? tokenIssuedAt(data.session.access_token) : null
      const isRecent = Boolean(issuedAt && Date.now() / 1000 - issuedAt <= 5 * 60 && issuedAt <= Date.now() / 1000 + 30)
      setRecentAuthentication(isRecent)
      if (requestedAt && issuedAt && issuedAt >= requestedAt && isRecent) {
        try { sessionStorage.removeItem(REAUTH_KEY) } catch { /* The fresh verified session remains authoritative on the server. */ }
        setStep(2)
        setMessage('Your sign-in was refreshed. Confirm the final deletion below.')
      }
    })
  }, [ownerId, auth.user])

  async function continueToVerification() {
    setError('')
    if (!ownerId || !email) { setError('Your account email is unavailable. Sign in again before deleting this account.'); return }
    try {
      const count = await countPendingWorkspaceSyncOperations(ownerId)
      setPendingCount(count)
      setStep(2)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check this account’s offline changes.') }
  }

  async function sendVerificationLink() {
    if (!email) return
    setError(''); setMessage(''); setRecentAuthentication(false)
    const requestedAt = Math.floor(Date.now() / 1000)
    try {
      const result = await requestAccountDeletionReauthentication(email, `${window.location.origin}${window.location.pathname}#/settings`)
      if (result.error) { setError(result.error); return }
      try { sessionStorage.setItem(REAUTH_KEY, String(requestedAt)) } catch { /* The user can still sign in and retry from Settings. */ }
      setMessage(`A secure sign-in link was sent to ${email}. Open it on this device, then return to this confirmation.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The verification email could not be sent.') }
  }

  async function exportData() {
    if (!ownerId) return
    setError('')
    try {
      const backup = await createWorkspaceBackup(ownerId)
      downloadWorkspaceBackup(backup)
      setMessage(`Workspace export downloaded (${backupRecordCount(backup)} records).`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The workspace export could not be created.') }
  }

  async function permanentlyDelete() {
    if (!ownerId || !email || typed !== 'DELETE' || pendingCount === null) return
    let requestSent = false
    let responseReceived = false
    setBusy(true); setError(''); setMessage(''); setOutcomeUncertain(false)
    try {
      const remaining = await auth.prepareAccountDeletion(ownerId)
      if (remaining > pendingCount) {
        setPendingCount(remaining)
        auth.resumeAccountSyncAfterDeletionFailure(ownerId)
        setError(`Another device added ${remaining - pendingCount} more unsynchronized change${remaining - pendingCount === 1 ? '' : 's'} since you reviewed this warning. Review the updated count and confirm again.`)
        setBusy(false)
        return
      }
      setPendingCount(remaining)
      const client = getSupabaseClient()
      if (!client) throw new Error('Supabase is not configured. No account data was deleted.')
      requestSent = true
      const { data, error: invokeError } = await client.functions.invoke<{ deleted: boolean }>('delete-account', { body: { confirmation: 'DELETE' } })
      const responseStatus = invokeError?.context instanceof Response ? invokeError.context.status : null
      responseReceived = !invokeError || (responseStatus !== null && responseStatus < 500 && responseStatus !== 409)
      if (invokeError) throw new Error(invokeError.message || 'The server could not confirm account deletion. Local data was preserved.')
      if (!data?.deleted) throw new Error('The server did not confirm deletion. Local data was preserved.')
      const cleanupNotice = await auth.finishAccountDeletion(ownerId)
      setStep(0); setTyped(''); setPendingCount(null)
      setMessage(cleanupNotice ? cleanupNotice : 'Your account and its cloud data were deleted. This device is now using guest mode.')
    } catch (cause) {
      const uncertain = requestSent && !responseReceived
      setOutcomeUncertain(uncertain)
      if (!uncertain) auth.resumeAccountSyncAfterDeletionFailure(ownerId)
      setError(requestSent && !responseReceived
        ? `${cause instanceof Error ? cause.message : 'The deletion request did not return a final result.'} Synchronization remains paused because the server may still be processing the request. Retry this confirmation to check the result; your local data is preserved until then.`
        : cause instanceof Error ? cause.message : 'Deletion could not be confirmed. Local data was preserved.')
    } finally { setBusy(false) }
  }

  if (auth.status !== 'signed-in' || !auth.user) return null
  return <>
    <section className="account-danger-zone" aria-labelledby="danger-zone-title">
      <h3 id="danger-zone-title">Danger Zone</h3>
      <div className="account-danger-row"><div><strong>Delete your ProgressTracker account</strong><p>Request permanent deletion of your account and associated cloud data.</p></div><InfoButton title="Deleting your account" summary="Deletion is permanent after Supabase confirms it." description="This removes your Supabase account and app-owned cloud records such as trackers, check-ins, goals, goal measures and progress, journals, schedules, holidays, settings, sync receipts, and deletion history. The account-specific data on this device is cleared only after the server confirms deletion; unrelated guest and other-account data are kept. Other offline devices may retain local copies you must clear on those devices; deleted accounts can no longer sync. Download the existing workspace export first if you want a copy. Changes still waiting to sync cannot be uploaded after deletion. A failed request leaves local records intact. External copies or backups outside ProgressTracker may remain according to their providers' retention policies." /></div>
      <button id="delete-account-start" type="button" className="button button-destructive button-small" onClick={() => { setStep(1); setError(''); setMessage('') }}>Delete Account</button>
      {message && !isOpen && <p className="auth-success" role="status">{message}</p>}
    </section>
    {isOpen && createPortal(<div ref={backdropRef} className="account-delete-backdrop">
      <section ref={panelRef} className="account-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="account-delete-title" tabIndex={-1}>
        <header className="account-delete-heading"><div><span className="settings-hint">ACCOUNT ACTIONS</span><h2 id="account-delete-title">{step === 1 ? 'Delete your account?' : 'Verify and confirm deletion'}</h2></div><IconButton ref={closeRef} className="today-detail-close" label="Close account deletion" disabled={busy || outcomeUncertain} onClick={() => { setStep(0); setError('') }}>×</IconButton></header>
        <div className="account-delete-content">
          {step === 1 ? <>
            <p>This permanently deletes <strong>{email}</strong> and the ProgressTracker cloud data owned by this account. You will lose access to the account. This cannot be undone.</p>
            <ul><li>Trackers, check-ins, goals, measures, milestones and planning data</li><li>Journals, schedules, holidays, settings and sync records</li><li>Account-specific local data after the server confirms deletion</li></ul>
            <p>Guest workspaces and other accounts on this device are kept separate. Other offline devices may retain local copies, and backups outside ProgressTracker follow their own retention rules.</p>
          </> : <>
            <p>Confirm the account <strong>{email}</strong>. A fresh email sign-in is required; the server accepts a recently authenticated session only.</p>
            <p className="account-pending-clear" role="status">{recentAuthentication ? 'Recent sign-in verified. You can complete the final confirmation.' : 'Verify your identity with a fresh email sign-in before deleting.'}</p>
            {pendingCount !== null && <p className={pendingCount ? 'form-alert account-pending-warning' : 'account-pending-clear'} role="status">{pendingCount ? `${pendingCount} local change${pendingCount === 1 ? '' : 's'} ${pendingCount === 1 ? 'has' : 'have'} not synchronized. Deletion will not upload them. Export a copy first if you need them.` : 'No pending offline changes were found.'}</p>}
            <div className="account-export"><div><strong>Want to keep a copy?</strong><span>Download your existing local workspace export before deleting.</span></div><button type="button" className="button button-secondary button-small" onClick={() => void exportData()}>Export My Data</button></div>
            <button type="button" className="button button-secondary button-small" onClick={() => void sendVerificationLink()} disabled={busy || !email}>Send fresh sign-in link</button>
            <label className="form-field account-delete-word"><span>Type DELETE to confirm</span><input className="auth-input" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} disabled={busy} /></label>
            {message && <p className="auth-success" role="status">{message}</p>}
          </>}
          {error && <p className="auth-error" role="alert">{error}</p>}
        </div>
        <footer className="account-delete-actions">
          {step === 1 ? <><button type="button" className="button button-secondary button-small" onClick={() => setStep(0)}>Cancel</button><button type="button" className="button button-destructive button-small" onClick={() => void continueToVerification()}>Continue to verification</button></> : <><button type="button" className="button button-secondary button-small" disabled={busy || outcomeUncertain} onClick={() => { setStep(0); setError('') }}>Cancel</button><button type="button" className="button button-destructive button-small" disabled={busy || !recentAuthentication || typed !== 'DELETE' || pendingCount === null} onClick={() => void permanentlyDelete()}>{busy ? 'Deleting account…' : outcomeUncertain ? 'Retry deletion status' : 'Permanently Delete Account'}</button></>}
        </footer>
      </section>
    </div>, document.body)}
  </>
}
