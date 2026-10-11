import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from '../../components/ui/IconButton'
import { AppIcon } from '../../components/ui/AppIcon'
import { InfoButton } from '../../components/ui/InfoButton'
import { useToast } from '../../components/ui/ToastProvider'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { countPendingWorkspaceSyncOperations } from '../../db/database'
import { backupRecordCount, createWorkspaceBackup, downloadWorkspaceBackup } from '../../db/workspaceBackup'
import { getSupabaseClient } from '../../services/supabase/client'
import { useAuth } from '../auth/AuthProvider'

async function deletionRequestError(error: { name?: string; context?: unknown }): Promise<string> {
  if (error.context instanceof Response) {
    try {
      const payload = await error.context.clone().json() as { error?: unknown }
      if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    } catch { /* Use the stable fallback for empty or non-JSON responses. */ }
    if (error.context.status === 401) return 'Your password verification expired. Enter your password and try again.'
    if (error.context.status === 429) return 'Too many password checks. Wait 15 minutes before trying again.'
  }
  if (error.name === 'FunctionsFetchError') return 'Could not connect to the account deletion service. Check your connection and retry.'
  return 'The account deletion service did not return a response. Check your connection and retry.'
}

export function AccountDeletion() {
  const auth = useAuth()
  const { notify } = useToast()
  const [isOpen, setIsOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  const [pendingLoading, setPendingLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcomeUncertain, setOutcomeUncertain] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const requestInFlight = useRef(false)
  const panelRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const ownerId = auth.user?.id
  const email = auth.user?.email

  useModalLayer(isOpen, panelRef, () => {
    if (!busy && !outcomeUncertain) closeDialog()
  })
  useVisualViewportBounds(isOpen, backdropRef)
  useEffect(() => { if (isOpen) closeRef.current?.focus() }, [isOpen])
  useEffect(() => {
    if (!isOpen || !ownerId) return
    let active = true
    setPendingLoading(true)
    setPendingCount(null)
    void countPendingWorkspaceSyncOperations(ownerId).then((count) => {
      if (active) setPendingCount(count)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not check this account’s offline changes.')
    }).finally(() => { if (active) setPendingLoading(false) })
    return () => { active = false }
  }, [isOpen, ownerId])
  useEffect(() => {
    if (!isOpen && restoreFocus.current) {
      restoreFocus.current = false
      document.getElementById('delete-account-start')?.focus()
    }
  }, [isOpen])

  function clearSensitiveInputs() {
    setPassword('')
    setTyped('')
    setShowPassword(false)
  }

  function closeDialog() {
    if (busy || outcomeUncertain) return
    restoreFocus.current = true
    clearSensitiveInputs()
    setError('')
    setIsOpen(false)
  }

  function openDialog() {
    setError('')
    setMessage('')
    setOutcomeUncertain(false)
    clearSensitiveInputs()
    setPendingCount(null)
    setIsOpen(true)
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

  async function checkDeletionStatus(client: NonNullable<ReturnType<typeof getSupabaseClient>>) {
    const { data, error: statusError } = await client.functions.invoke<{ deleted: boolean }>('delete-account', { body: { action: 'status' } })
    if (statusError) throw new Error(await deletionRequestError(statusError))
    if (data?.deleted) return true
    setOutcomeUncertain(false)
    auth.resumeAccountSyncAfterDeletionFailure(ownerId!)
    setError('Your account is still active. No deletion was confirmed. Enter your password and confirm again when ready.')
    return false
  }

  async function permanentlyDelete() {
    if (requestInFlight.current || !ownerId || !email || typed !== 'DELETE' || pendingCount === null || pendingLoading || (!password && !outcomeUncertain)) return
    const client = getSupabaseClient()
    if (!client) { setError('Account deletion is unavailable because Supabase is not configured.'); return }
    requestInFlight.current = true
    let deletionRequestSent = false
    let responseReceived = false
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (outcomeUncertain) {
        deletionRequestSent = true
        const deleted = await checkDeletionStatus(client)
        responseReceived = true
        if (!deleted) return
      } else {
        const remaining = await auth.prepareAccountDeletion(ownerId)
        if (remaining > pendingCount) {
          setPendingCount(remaining)
          auth.resumeAccountSyncAfterDeletionFailure(ownerId)
          setError(`Another device added ${remaining - pendingCount} more unsynchronized change${remaining - pendingCount === 1 ? '' : 's'} since you reviewed this warning. Review the updated count and confirm again.`)
          return
        }
        setPendingCount(remaining)

        const { data: verification, error: verificationError } = await client.functions.invoke<{ authorized: boolean; authorization: string }>('delete-account', {
          body: { action: 'verify-password', password },
        })
        setPassword('')
        if (verificationError) throw new Error(await deletionRequestError(verificationError))
        responseReceived = true
        if (!verification?.authorized || !verification.authorization) throw new Error('The password could not be verified. Try again.')

        responseReceived = false
        deletionRequestSent = true
        const { data, error: invokeError } = await client.functions.invoke<{ deleted: boolean }>('delete-account', {
          body: { action: 'delete', confirmation: 'DELETE', authorization: verification.authorization },
        })
        const responseStatus = invokeError?.context instanceof Response ? invokeError.context.status : null
        responseReceived = !invokeError || (responseStatus !== null && responseStatus < 500 && responseStatus !== 409)
        if (invokeError) throw new Error(await deletionRequestError(invokeError))
        if (!data?.deleted) throw new Error('The server did not confirm deletion. Your local data remains on this device.')
      }

      const cleanupNotice = await auth.finishAccountDeletion(ownerId)
      notify({ kind: cleanupNotice ? 'warning' : 'success', title: 'Account deletion confirmed', description: cleanupNotice ?? 'Your account and cloud data were deleted. This device is now using guest mode.', duration: cleanupNotice ? 0 : undefined })
      setIsOpen(false)
      clearSensitiveInputs()
      setPendingCount(null)
      setOutcomeUncertain(false)
      setMessage(cleanupNotice ?? 'Your account and its cloud data were deleted. This device is now using guest mode.')
    } catch (cause) {
      const uncertain = deletionRequestSent && !responseReceived
      setOutcomeUncertain(uncertain)
      if (!uncertain) auth.resumeAccountSyncAfterDeletionFailure(ownerId)
      setError(deletionRequestSent && !responseReceived
        ? `${cause instanceof Error ? cause.message : 'The deletion request did not return a final result.'} Synchronization remains paused because the server may still be processing the request. Retry the status; your local data remains on this device until the result is confirmed.`
        : cause instanceof Error ? cause.message : 'Deletion could not be confirmed. Your local data remains on this device.')
    } finally {
      requestInFlight.current = false
      setBusy(false)
      setPassword('')
    }
  }

  if (auth.status !== 'signed-in' || !auth.user) return null
  const passwordError = /password|verify your password/i.test(error)
  const readyToSubmit = Boolean(outcomeUncertain || password) && typed === 'DELETE' && pendingCount !== null && !pendingLoading && !busy
  return <>
    <section className="account-danger-zone" aria-labelledby="danger-zone-title">
      <h3 id="danger-zone-title">Danger Zone</h3>
      <div className="account-danger-row"><div><strong>Delete your ProgressTracker account</strong><p>Request permanent deletion of your account and associated cloud data.</p></div><InfoButton title="Deleting your account" summary="Deletion is permanent after Supabase confirms it." description="This removes your Supabase account and app-owned cloud records such as trackers, check-ins, goals, goal measures and progress, journals, schedules, holidays, settings, sync receipts, and deletion history. The account-specific data on this device is cleared only after the server confirms deletion; unrelated guest and other-account data are kept. Other offline devices may retain local copies you must clear on those devices; deleted accounts can no longer sync. Download the existing workspace export first if you want a copy. Changes still waiting to sync cannot be uploaded after deletion. A failed request leaves local records intact. External copies or backups outside ProgressTracker may remain according to their providers' retention policies." /></div>
      <button id="delete-account-start" type="button" className="button button-destructive button-small" onClick={openDialog}>Delete Account</button>
      {message && !isOpen && <p className="auth-success" role="status">{message}</p>}
    </section>
    {isOpen && createPortal(<div ref={backdropRef} className="account-delete-backdrop">
      <section ref={panelRef} className="account-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="account-delete-title" tabIndex={-1}>
        <header className="account-delete-heading"><div><span className="settings-hint">ACCOUNT ACTIONS</span><h2 id="account-delete-title">Delete your account?</h2></div><IconButton ref={closeRef} className="today-detail-close" label="Close account deletion" disabled={busy || outcomeUncertain} onClick={closeDialog}><AppIcon name="close" /></IconButton></header>
        <form className="account-delete-content" onSubmit={(event) => { event.preventDefault(); void permanentlyDelete() }}>
          <p>This permanently deletes <strong>{email}</strong> and the ProgressTracker cloud data owned by this account. This cannot be undone.</p>
          {pendingLoading ? <p className="account-pending-clear" role="status">Checking for unsynchronized changes…</p> : pendingCount !== null && <p className={pendingCount ? 'form-alert account-pending-warning' : 'account-pending-clear'} role="status">{pendingCount ? `${pendingCount} local change${pendingCount === 1 ? '' : 's'} ${pendingCount === 1 ? 'has' : 'have'} not synchronized. Deletion will not upload them. Export a copy first if you need them.` : 'No pending offline changes were found.'}</p>}
          <div className="account-export"><div><strong>Want to keep a copy?</strong><span>Download your existing local workspace export before deleting.</span></div><button type="button" className="button button-secondary button-small" onClick={() => void exportData()} disabled={busy}>Export My Data</button></div>
          <label className="form-field account-delete-password" htmlFor="delete-account-password"><span>Current account password</span><span className="account-password-row"><input id="delete-account-password" className="auth-input" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => { setPassword(event.target.value); setError('') }} disabled={busy || outcomeUncertain} aria-invalid={passwordError} aria-describedby={passwordError ? 'delete-account-password-help delete-account-error' : 'delete-account-password-help'} /><button type="button" className="button button-secondary button-small" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)} disabled={busy || outcomeUncertain}>{showPassword ? 'Hide' : 'Show'}</button></span><small id="delete-account-password-help">Your password is checked securely by Supabase and is not saved by ProgressTracker. If you usually use email sign-in links, set a password first under Settings → Sync &amp; Data.</small></label>
          <label className="form-field account-delete-word" htmlFor="delete-account-confirmation"><span>Type DELETE to confirm</span><input id="delete-account-confirmation" className="auth-input" autoComplete="off" value={typed} onChange={(event) => { setTyped(event.target.value); setError('') }} disabled={busy || outcomeUncertain} aria-invalid={Boolean(typed && typed !== 'DELETE')} aria-describedby={typed && typed !== 'DELETE' ? 'delete-account-confirmation-help delete-account-error' : 'delete-account-confirmation-help'} /><small id="delete-account-confirmation-help">Enter DELETE in capital letters.</small></label>
          {error && <p id="delete-account-error" className="auth-error" role="alert">{error}</p>}
          {message && <p className="auth-success" role="status">{message}</p>}
          <footer className="account-delete-actions">
            <button type="button" className="button button-secondary button-small" disabled={busy || outcomeUncertain} onClick={closeDialog}>Cancel</button>
            <button type="submit" className="button button-destructive button-small" disabled={!readyToSubmit}>{busy ? 'Verifying and deleting…' : outcomeUncertain ? 'Retry deletion status' : 'Permanently Delete Account'}</button>
          </footer>
        </form>
      </section>
    </div>, document.body)}
  </>
}
