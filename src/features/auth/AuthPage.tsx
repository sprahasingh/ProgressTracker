import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, type SubmitHandler } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '../../components/ui/Button'
import { AppIcon } from '../../components/ui/AppIcon'
import { useToast } from '../../components/ui/ToastProvider'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { supabaseConfiguration } from '../../services/supabase/client'
import { sendPasswordReset, sendSignInLink, signInWithPassword, signUpWithPassword, updateAccountPassword } from './authService'
import { useAuth } from './AuthProvider'
import { listSyncConflicts, resolveSyncConflict } from '../../db/syncConflictRepository'
import { listSyncRecoveryOperations } from '../../db/syncRecoveryRepository'
import type { SyncConflict, SyncOperation } from '../../db/models'
import { WorkspaceBackup } from './WorkspaceBackup'
import { getAuthRedirectUrl } from './authRedirect'
import { SyncDiagnosticsExport } from './SyncDiagnosticsExport'
import { TrackerRecoveryPreview } from './TrackerRecoveryPreview'
import { BlockedTrackerSyncCard } from './BlockedTrackerSyncCard'
import { isTrackerRecoveryInspectionMode } from './recoveryInspectionMode'
import { countPendingWorkspaceSyncOperations } from '../../db/database'

type AuthMode = 'magic-link' | 'sign-in' | 'sign-up' | 'forgot-password' | 'set-password'
const emailSchema = z.string().trim().email('Enter a valid email address.').toLowerCase()
const emailFormSchema = z.object({ email: emailSchema })
const passwordFormSchema = z.object({ email: emailSchema, password: z.string().min(8, 'Use at least 8 characters.') })
const setPasswordSchema = z.object({ password: z.string().min(8, 'Use at least 8 characters.'), confirmPassword: z.string() })
  .refine((values) => values.password === values.confirmPassword, { message: 'Passwords do not match.', path: ['confirmPassword'] })

type EmailValues = z.infer<typeof emailFormSchema>
type PasswordValues = z.infer<typeof passwordFormSchema>
type SetPasswordValues = z.infer<typeof setPasswordSchema>

function getCallbackUrl(): string { return getAuthRedirectUrl(window.location) }

export function AuthPage({ embedded = false, redirectSignedIn = false }: { embedded?: boolean; redirectSignedIn?: boolean } = {}) {
  const { notify } = useToast()
  const { status, user, workspaceStatus, workspaceUserId, signOut, passwordRecovery, completePasswordRecovery, syncNow, syncStatus, isOnline, syncSummary, syncError } = useAuth()
  const [mode, setMode] = useState<AuthMode>('magic-link')
  const [notice, setNotice] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [manualSyncPhase, setManualSyncPhase] = useState<'idle' | 'requested' | 'started'>('idle')
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([])
  const [blockedOperations, setBlockedOperations] = useState<SyncOperation[]>([])
  const [conflictsOwnerUserId, setConflictsOwnerUserId] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null)
  const [copiedPayloadId, setCopiedPayloadId] = useState<string | null>(null)
  const readOnlyRecoveryInspection = isTrackerRecoveryInspectionMode()
  const [pendingOperationCount, setPendingOperationCount] = useState<number | null>(null)
  const [syncIssueRefreshVersion, setSyncIssueRefreshVersion] = useState(0)
  const [advancedOpen, setAdvancedOpen] = useState(readOnlyRecoveryInspection)

  useEffect(() => {
    let active = true
    setSyncConflicts([])
    setBlockedOperations([])
    setConflictsOwnerUserId(null)
    setConflictError(null)
    setPendingOperationCount(null)
    if (readOnlyRecoveryInspection) return () => { active = false }
    if (status !== 'signed-in' || !user?.id || workspaceStatus !== 'ready' || workspaceUserId !== user.id) return () => { active = false }
    void Promise.allSettled([listSyncConflicts(user.id), listSyncRecoveryOperations(user.id), countPendingWorkspaceSyncOperations(user.id)]).then(([conflictsResult, operationsResult, pendingResult]) => {
      if (!active) return
      if (conflictsResult.status === 'fulfilled' && operationsResult.status === 'fulfilled') {
        setSyncConflicts(conflictsResult.value)
        setBlockedOperations(operationsResult.value)
        setConflictsOwnerUserId(user.id)
      } else setConflictError('Saved sync issues could not be loaded for this account.')
      if (pendingResult.status === 'fulfilled') setPendingOperationCount(pendingResult.value)
    })
    return () => { active = false }
  }, [status, user?.id, workspaceStatus, workspaceUserId, syncSummary, readOnlyRecoveryInspection, syncIssueRefreshVersion])

  useEffect(() => setAdvancedOpen(readOnlyRecoveryInspection), [readOnlyRecoveryInspection])

  useEffect(() => {
    if (manualSyncPhase === 'requested' && syncStatus === 'syncing') {
      notify({ kind: 'info', title: 'Sync started', description: 'Checking this account for updates.', dedupeKey: 'manual-sync' })
      setManualSyncPhase('started')
    } else if (manualSyncPhase === 'started' && syncStatus === 'complete') {
      notify({ kind: 'success', title: 'Sync complete', description: 'Your account is up to date.', dedupeKey: 'manual-sync' })
      setManualSyncPhase('idle')
    } else if (manualSyncPhase === 'started' && syncStatus === 'error') {
      notify({ kind: 'warning', title: 'Sync pending', description: 'Your changes remain saved on this device. Sync will retry.', dedupeKey: 'manual-sync' })
      setManualSyncPhase('idle')
    }
  }, [manualSyncPhase, syncStatus, notify])

  async function runManualSync() {
    setManualSyncPhase('requested')
    await syncNow?.()
  }

  async function handleConflictResolution(conflict: SyncConflict, choice: 'keep-local' | 'use-cloud' | 'fork-local') {
    if (!user?.id || workspaceUserId !== user.id) return
    setResolvingConflict(conflict.id)
    setConflictError(null)
    try {
      await resolveSyncConflict(user.id, conflict.id, choice)
      setSyncConflicts(await listSyncConflicts(user.id))
      setConflictsOwnerUserId(user.id)
    } catch (cause) {
      setConflictError(cause instanceof Error ? cause.message : 'The conflict could not be resolved. Both copies remain saved.')
    } finally { setResolvingConflict(null) }
  }

  async function handleCopyBlockedPayload(operation: SyncOperation) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(operation.payload, null, 2))
      setCopiedPayloadId(operation.id)
    } catch {
      setConflictError('The payload could not be copied. Expand it to review the saved diagnostic.')
    }
  }

  const emailForm = useForm<EmailValues>({ resolver: zodResolver(emailFormSchema), defaultValues: { email: '' } })
  const passwordForm = useForm<PasswordValues>({ resolver: zodResolver(passwordFormSchema), defaultValues: { email: '', password: '' } })
  const setPasswordForm = useForm<SetPasswordValues>({ resolver: zodResolver(setPasswordSchema), defaultValues: { password: '', confirmPassword: '' } })

  const clearFeedback = () => { setRequestError(null); setNotice(null) }
  const onMagicLink: SubmitHandler<EmailValues> = async ({ email }) => {
    clearFeedback()
    try {
      const result = await sendSignInLink(email, getCallbackUrl())
      if (result.error) { setRequestError(result.error); return }
      setNotice(`We sent a sign-in link to ${email}. Open it on this device to finish signing in.`)
    } catch { setRequestError('We could not reach Supabase. Check your connection and try again.') }
  }

  const onPasswordSubmit: SubmitHandler<PasswordValues> = async ({ email, password }) => {
    clearFeedback()
    try {
      if (mode === 'sign-in') {
        const result = await signInWithPassword(email, password)
        if (result.error) { setRequestError(result.error); return }
      } else {
        const result = await signUpWithPassword(email, password, getCallbackUrl())
        if (result.error) { setRequestError(result.error); return }
        if (result.requiresEmailConfirmation) {
          setNotice('If the address can be registered, check your inbox to confirm your account before signing in.')
        } else {
          setNotice('Your account is ready.')
        }
      }
    } catch { setRequestError('We could not reach Supabase. Check your connection and try again.') }
  }

  const onForgotPassword: SubmitHandler<EmailValues> = async ({ email }) => {
    clearFeedback()
    try {
      const result = await sendPasswordReset(email, getCallbackUrl())
      if (result.error) { setRequestError(result.error); return }
      setNotice('If an account can receive a password reset, a link will arrive by email.')
    } catch { setRequestError('We could not reach Supabase. Check your connection and try again.') }
  }

  const onSetPassword: SubmitHandler<SetPasswordValues> = async ({ password }) => {
    clearFeedback()
    try {
      const result = await updateAccountPassword(password)
      if (result.error) { setRequestError(result.error); return }
      setNotice('Your password has been updated.')
      completePasswordRecovery?.()
      setMode('set-password')
      setPasswordForm.reset()
    } catch { setRequestError('We could not reach Supabase. Check your connection and try again.') }
  }

  async function handleSignOut() {
    setIsSigningOut(true)
    try {
      const error = await signOut()
      setSignOutError(error)
      if (!error) notify({ kind: 'success', title: 'Signed out', description: 'Your local workspace remains saved on this device.' })
    }
    catch { setSignOutError('We could not sign out. Check your connection and try again.') }
    finally { setIsSigningOut(false) }
  }

  const requestedMode = passwordRecovery ? 'set-password' : mode
  const isRecovery = passwordRecovery
  const accountConflicts = conflictsOwnerUserId === user?.id ? syncConflicts : []
  const accountOperations = conflictsOwnerUserId === user?.id ? blockedOperations : []
  const activeBlockedOperations = accountOperations.filter((operation) => operation.status === 'blocked')
  const blockedTrackerGroups = [...activeBlockedOperations.filter((operation) => operation.entity === 'tracker').reduce((groups, operation) => groups.set(operation.entityId, [...(groups.get(operation.entityId) ?? []), operation]), new Map<string, SyncOperation[]>()).entries()]
  const otherBlockedOperations = activeBlockedOperations.filter((operation) => operation.entity !== 'tracker')
  const historicalRejectedOperations = accountOperations.filter((operation) => operation.failureCode && (operation.status === 'superseded' || operation.status === 'discarded'))
  const issueCount = activeBlockedOperations.length + accountConflicts.length
  const hasSyncFailure = Boolean(syncError) || (syncSummary?.failed ?? 0) > 0
  const hasSyncIssues = issueCount > 0 || (syncSummary?.conflicts ?? 0) > 0
  const accountSyncLabel = readOnlyRecoveryInspection
    ? 'Inspection mode'
    : hasSyncIssues
      ? 'Action needed'
      : isOnline === false
        ? 'Offline'
        : syncStatus === 'syncing'
          ? 'Syncing'
          : hasSyncFailure
            ? 'Action needed'
            : pendingOperationCount !== null && pendingOperationCount > 0
              ? 'Changes waiting to sync'
              : syncStatus === 'complete' && pendingOperationCount === 0
                ? 'Synced'
                : syncStatus === 'waiting'
                  ? 'Checking for updates'
                  : 'Not checked yet'
  const accountSyncDescription = readOnlyRecoveryInspection
    ? 'Sync is paused while you inspect this device.'
    : accountSyncLabel === 'Action needed'
      ? 'Some saved changes need your attention.'
      : accountSyncLabel === 'Offline'
        ? 'Your progress stays saved on this device.'
        : accountSyncLabel === 'Syncing'
          ? 'Checking your account for updates.'
          : accountSyncLabel === 'Changes waiting to sync'
            ? 'Your changes stay saved here until sync completes.'
            : accountSyncLabel === 'Synced'
              ? 'Your progress is up to date.'
              : 'Your changes sync automatically when you’re online.'

  if (redirectSignedIn && status === 'signed-in' && !isRecovery) return <Navigate to="/settings#sync-data" replace />

  return (
    <section className={`auth-page${embedded ? ' auth-page-embedded' : ''}`} aria-labelledby={embedded ? 'account-sync-status-title' : 'auth-page-title'}>
      {!embedded && <PageHeader headingId="auth-page-title" eyebrow="YOUR ACCOUNT" title="Keep your progress close" description="Sign in on each device to prepare your account for secure cross-device sync. Your local data remains available either way." help={{ title: 'Account and sync', summary: 'Sign in to access the private workspace associated with your account.', description: 'Each account has an isolated local workspace. Sync sends queued changes through the authenticated server boundary and preserves local progress if a request fails. Guest progress stays separate unless you explicitly choose to import it. Sign-out keeps that account’s local changes for its next sign-in.' }} />}
      <Surface className="auth-card">
        {status === 'loading' && <div className="auth-message" role="status"><span className="auth-status-icon" aria-hidden="true"><AppIcon name="loading" /></span><h2>Checking your account</h2><p>Your local progress stays available while we check your sign-in.</p></div>}
        {status === 'local-only' && <div className="auth-message" role="status"><span className="auth-status-icon" aria-hidden="true"><AppIcon name="home" /></span><h2>Local mode is ready</h2><p>Supabase is not configured for this build. ProgressTracker remains available on this device.</p>{supabaseConfiguration.status === 'invalid' && <p className="auth-error">{supabaseConfiguration.reason}</p>}</div>}

        {status === 'signed-in' && !isRecovery && requestedMode !== 'set-password' && (
          <div className="account-sync-page">
            <section className="account-sync-overview" aria-labelledby="account-sync-status-title">
              <div className="account-sync-identity"><div><h2 id="account-sync-status-title">Account sync</h2><p className="auth-account-email" title={user?.email ?? undefined}>{user?.email || 'Email unavailable'}</p></div><span className={`account-sync-badge${accountSyncLabel === 'Action needed' ? ' account-sync-badge-alert' : accountSyncLabel === 'Synced' ? ' account-sync-badge-good' : ''}`} role="status">{accountSyncLabel}</span></div>
              <p className="account-sync-description">{accountSyncDescription}</p>
              <div className="account-sync-counts" aria-live="polite">{pendingOperationCount !== null && pendingOperationCount > 0 && <span>{pendingOperationCount} change{pendingOperationCount === 1 ? '' : 's'} waiting</span>}{issueCount > 0 && <span>{issueCount} sync issue{issueCount === 1 ? '' : 's'}</span>}</div>
              {readOnlyRecoveryInspection && <p className="account-inspection-notice" role="status">Inspection mode is active. Automatic and manual sync are paused on this page.</p>}
              {!readOnlyRecoveryInspection && <Button className="account-sync-primary" onClick={() => void runManualSync()} disabled={syncStatus === 'syncing' || isOnline === false}>{syncStatus === 'syncing' ? 'Syncing…' : 'Sync now'}</Button>}
              {syncStatus === 'error' && !issueCount && <p className="auth-error" role="alert">Sync could not finish. Your local progress is still saved.</p>}
              {conflictError && <p className="auth-error" role="alert">{conflictError}</p>}
              {signOutError && <p className="auth-error" role="alert">{signOutError}</p>}
              {notice && <p className="auth-success" role="status">{notice}</p>}
              <div className="auth-actions account-secondary-actions"><Button variant="secondary" size="small" className="account-password-action" onClick={() => { clearFeedback(); setMode('set-password') }}>Set or change password</Button><Button variant="secondary" size="small" className="account-sign-out" onClick={handleSignOut} disabled={isSigningOut}>{isSigningOut ? 'Signing out…' : 'Sign out'}</Button></div>
            </section>
            {!readOnlyRecoveryInspection && conflictsOwnerUserId === user?.id && workspaceStatus === 'ready' && workspaceUserId === user?.id && issueCount > 0 && <section className="account-sync-issues" aria-labelledby="sync-issues-title"><div className="account-section-heading"><div><h3 id="sync-issues-title">Sync issues</h3><p>{issueCount} saved item{issueCount === 1 ? '' : 's'} need attention. They remain on this device.</p></div><Link to="/settings?recoveryPreview=1#sync-data" onClick={() => setAdvancedOpen(true)}>Review recovery tools</Link></div>
            {activeBlockedOperations.length > 0 && <section className="sync-conflicts" aria-labelledby="blocked-sync-title"><h4 id="blocked-sync-title">Rejected changes</h4>{blockedTrackerGroups.map(([trackerId, operations]) => <BlockedTrackerSyncCard key={trackerId} userId={user!.id!} trackerId={trackerId} operations={operations} syncNow={syncNow} onOperationsChanged={() => setSyncIssueRefreshVersion((version) => version + 1)} />)}{otherBlockedOperations.map((operation) => {
              const payload = operation.payload as { name?: unknown } | undefined
              const trackerName = operation.entity === 'tracker' && typeof payload?.name === 'string' ? payload.name : null
              return <article className="sync-conflict blocked-sync-operation" key={operation.id}>
                <h4>{trackerName ?? `${operation.entity.replaceAll('_', ' ')} change`}</h4><p>This saved change was rejected and will not be retried unchanged.</p>
                <details><summary>Technical details and saved payload</summary><p className="sync-operation-id">Operation {operation.id} · record {operation.entityId}</p><p>{operation.lastError ?? 'The server rejected this saved change.'}</p>{operation.failureDiagnostic && <p className="sync-server-diagnostic">{operation.failureDiagnostic.message}{operation.failureDiagnostic.table && ` · ${operation.failureDiagnostic.table}`}{operation.failureDiagnostic.constraint && ` · ${operation.failureDiagnostic.constraint}`}</p>}<pre aria-label={`Rejected payload for ${trackerName ?? operation.entity}`}>{JSON.stringify(operation.payload, null, 2)}</pre><Button variant="secondary" size="small" onClick={() => void handleCopyBlockedPayload(operation)}>{copiedPayloadId === operation.id ? 'Payload copied' : 'Copy saved payload'}</Button></details>
              </article>
            })}</section>}
            {accountConflicts.length > 0 && <section className="sync-conflicts" aria-labelledby="sync-conflicts-title"><h4 id="sync-conflicts-title">Conflicting versions</h4><p>Choose which saved version to keep. Your other account’s data is never shown here.</p>{accountConflicts.map((conflict) => {
              const cloud = conflict.remoteRecord
              const cloudAvailable = Boolean(cloud && cloud.user_id === user?.id && typeof cloud.server_revision === 'number')
              const localPayload = conflict.localPayload as Record<string, unknown>
              const cloudPayload = conflict.entity === 'tracker' ? cloud?.definition as Record<string, unknown> | undefined : cloud ?? undefined
              const entityName = conflict.entity === 'tracker' ? 'Tracker' : conflict.entity === 'account_holiday' ? 'Holiday' : 'Daily entry'
              const holidaySummary = conflict.entity === 'account_holiday' ? (() => {
                const reasonLabel = (reason: unknown) => typeof reason === 'string' && reason ? `${reason[0]!.toLocaleUpperCase()}${reason.slice(1)}` : 'No reason'
                const localDate = typeof localPayload.date === 'string' ? localPayload.date : 'Date unavailable'
                const localReason = reasonLabel(localPayload.reason)
                const cloudDate = typeof cloudPayload?.holiday_date === 'string' ? cloudPayload.holiday_date : typeof cloudPayload?.date === 'string' ? cloudPayload.date : 'Cloud date unavailable'
                const cloudReason = reasonLabel(cloudPayload?.reason)
                return `This device: ${localDate} · ${localReason}. Cloud: ${cloudDate} · ${cloudReason}.`
              })() : null
              const describe = (value: Record<string, unknown> | undefined) => value ? JSON.stringify(value, null, 2) : null
              return <article className="sync-conflict" key={conflict.id}><h4>{entityName} conflict · {conflict.entityId}</h4>{conflict.reason && <p className="auth-hint" role="status">{conflict.reason}</p>}{holidaySummary && <p>{holidaySummary}</p>}<div className="sync-conflict-versions"><details><summary>This device’s version</summary><pre>{describe(localPayload)}</pre></details><details><summary>Cloud version</summary><pre>{describe(cloudPayload) ?? 'Cloud copy unavailable for this account.'}</pre></details></div>{cloudAvailable ? <div className="auth-actions"><Button variant="secondary" disabled={resolvingConflict === conflict.id} onClick={() => void handleConflictResolution(conflict, 'keep-local')}>Keep this device’s version</Button><Button variant="secondary" disabled={resolvingConflict === conflict.id} onClick={() => void handleConflictResolution(conflict, 'use-cloud')}>Use cloud version</Button></div> : conflict.entity === 'account_holiday' ? <p className="auth-hint">The cloud holiday is unavailable to review. The local holiday remains saved on this device; sync again when the cloud record is readable.</p> : <><p className="auth-hint">The server did not provide a record this account can read. Save your local record under a new ID to keep it available for sync.</p><div className="auth-actions"><Button variant="secondary" disabled={resolvingConflict === conflict.id} onClick={() => void handleConflictResolution(conflict, 'fork-local')}>Save local copy as new</Button></div></>}</article>
            })}</section>}
            </section>}
            <details className="account-disclosure account-backup-disclosure"><summary>Backup &amp; Restore</summary>{workspaceStatus === 'ready' && workspaceUserId === user?.id && user?.id && <WorkspaceBackup ownerUserId={user.id} />}</details>
            <details className="account-disclosure account-advanced-disclosure" id="account-advanced-tools" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary>Advanced tools</summary>
              {syncError && <p className="account-technical-error"><strong>Latest sync error</strong><br /><span className="sync-server-diagnostic">{syncError}</span></p>}
              {historicalRejectedOperations.length > 0 && <section className="account-history-list" aria-labelledby="account-history-title"><h3 id="account-history-title">Past rejected changes</h3><ul>{historicalRejectedOperations.map((operation) => <li key={operation.id}>Historical rejection · {operation.status === 'superseded' && operation.supersededByRevision ? `superseded by successful revision ${operation.supersededByRevision}` : operation.status}{' · '}{operation.entity.replaceAll('_', ' ')} · {operation.entityId}</li>)}</ul></section>}
              {workspaceStatus === 'ready' && workspaceUserId === user?.id && user?.id && <><SyncDiagnosticsExport userId={user.id} /><TrackerRecoveryPreview userId={user.id} /></>}
            </details>
          </div>
        )}

        {status === 'signed-out' && requestedMode === 'magic-link' && <form className="auth-form" onSubmit={emailForm.handleSubmit(onMagicLink)} noValidate>
          <div className="auth-form-heading"><span className="auth-status-icon" aria-hidden="true"><AppIcon name="mail" /></span><div><h2>Sign in with email</h2><p>We’ll email you a secure, one-time sign-in link.</p></div></div>
          <label className="auth-label" htmlFor="auth-email">Email address</label><input className="auth-input" id="auth-email" type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" aria-invalid={Boolean(emailForm.formState.errors.email)} {...emailForm.register('email')} />
          {emailForm.formState.errors.email && <p className="auth-error" role="alert">{emailForm.formState.errors.email.message}</p>}{notice && <p className="auth-success" role="status">{notice}</p>}{requestError && <p className="auth-error" role="alert">{requestError}</p>}
          <Button type="submit" className="auth-submit" disabled={emailForm.formState.isSubmitting}>{emailForm.formState.isSubmitting ? 'Sending link…' : 'Email me a sign-in link'}</Button>
          <div className="auth-switches"><button type="button" onClick={() => { clearFeedback(); setMode('sign-in') }}>Use password</button><button type="button" onClick={() => { clearFeedback(); setMode('sign-up') }}>Create account</button></div>
          <p className="auth-hint">No password to remember. A new account is created when you use an email for the first time.</p>
        </form>}

        {status === 'signed-out' && (requestedMode === 'sign-in' || requestedMode === 'sign-up') && <form className="auth-form" onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} noValidate>
          <div className="auth-form-heading"><span className="auth-status-icon" aria-hidden="true"><AppIcon name="account" /></span><div><h2>{requestedMode === 'sign-in' ? 'Sign in with password' : 'Create your account'}</h2><p>{requestedMode === 'sign-in' ? 'Use your email and password.' : 'Choose a password with at least 8 characters.'}</p></div></div>
          <label className="auth-label" htmlFor="password-email">Email address</label><input className="auth-input" id="password-email" type="email" autoComplete="email" {...passwordForm.register('email')} />
          {passwordForm.formState.errors.email && <p className="auth-error" role="alert">{passwordForm.formState.errors.email.message}</p>}
          <label className="auth-label auth-label-spaced" htmlFor="account-password">Password</label><input className="auth-input" id="account-password" type="password" autoComplete={requestedMode === 'sign-in' ? 'current-password' : 'new-password'} {...passwordForm.register('password')} />
          {passwordForm.formState.errors.password && <p className="auth-error" role="alert">{passwordForm.formState.errors.password.message}</p>}{notice && <p className="auth-success" role="status">{notice}</p>}{requestError && <p className="auth-error" role="alert">{requestError}</p>}
          <Button type="submit" className="auth-submit" disabled={passwordForm.formState.isSubmitting}>{passwordForm.formState.isSubmitting ? 'Please wait…' : requestedMode === 'sign-in' ? 'Sign in' : 'Create account'}</Button>
          <div className="auth-switches">{requestedMode === 'sign-in' ? <><button type="button" onClick={() => { clearFeedback(); setMode('forgot-password') }}>Forgot password?</button><button type="button" onClick={() => { clearFeedback(); setMode('sign-up') }}>Create account</button></> : <button type="button" onClick={() => { clearFeedback(); setMode('sign-in') }}>Already have an account? Sign in</button>}</div>
          <button className="auth-text-button" type="button" onClick={() => { clearFeedback(); setMode('magic-link') }}>Use a magic link instead</button>
        </form>}

        {status === 'signed-out' && requestedMode === 'forgot-password' && <form className="auth-form" onSubmit={emailForm.handleSubmit(onForgotPassword)} noValidate>
          <div className="auth-form-heading"><span className="auth-status-icon" aria-hidden="true"><AppIcon name="mail" /></span><div><h2>Reset your password</h2><p>We’ll send a recovery link if the account can receive one.</p></div></div>
          <label className="auth-label" htmlFor="auth-email">Email address</label><input className="auth-input" id="auth-email" type="email" autoComplete="email" {...emailForm.register('email')} />
          {emailForm.formState.errors.email && <p className="auth-error" role="alert">{emailForm.formState.errors.email.message}</p>}{notice && <p className="auth-success" role="status">{notice}</p>}{requestError && <p className="auth-error" role="alert">{requestError}</p>}
          <Button type="submit" className="auth-submit" disabled={emailForm.formState.isSubmitting}>{emailForm.formState.isSubmitting ? 'Sending…' : 'Send reset link'}</Button><button className="auth-text-button" type="button" onClick={() => { clearFeedback(); setMode('sign-in') }}>Back to sign in</button>
        </form>}

        {(isRecovery || status === 'signed-in' && requestedMode === 'set-password') && <form className="auth-form" onSubmit={setPasswordForm.handleSubmit(onSetPassword)} noValidate>
          <div className="auth-form-heading"><span className="auth-status-icon" aria-hidden="true"><AppIcon name="account" /></span><div><h2>{isRecovery ? 'Choose a new password' : 'Set your password'}</h2><p>{isRecovery ? 'Your recovery link is verified. Choose a new password for this account.' : 'Add a password so you can sign in without a magic link.'}</p></div></div>
          <label className="auth-label" htmlFor="new-account-password">New password</label><input className="auth-input" id="new-account-password" type="password" autoComplete="new-password" {...setPasswordForm.register('password')} />
          {setPasswordForm.formState.errors.password && <p className="auth-error" role="alert">{setPasswordForm.formState.errors.password.message}</p>}
          <label className="auth-label auth-label-spaced" htmlFor="confirm-account-password">Confirm password</label><input className="auth-input" id="confirm-account-password" type="password" autoComplete="new-password" {...setPasswordForm.register('confirmPassword')} />
          {setPasswordForm.formState.errors.confirmPassword && <p className="auth-error" role="alert">{setPasswordForm.formState.errors.confirmPassword.message}</p>}{notice && <p className="auth-success" role="status">{notice}</p>}{requestError && <p className="auth-error" role="alert">{requestError}</p>}
          <Button type="submit" className="auth-submit" disabled={setPasswordForm.formState.isSubmitting}>{setPasswordForm.formState.isSubmitting ? 'Updating…' : 'Save password'}</Button>
          {!isRecovery && <button className="auth-text-button" type="button" onClick={() => { clearFeedback(); setMode('magic-link') }}>Back to account</button>}
        </form>}

        {(status === 'signed-out' || status === 'local-only') && workspaceStatus === 'ready' && workspaceUserId === null && <WorkspaceBackup ownerUserId={null} />}
      </Surface>
    </section>
  )
}
