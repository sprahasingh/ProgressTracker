import { useEffect, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, type SubmitHandler } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { supabaseConfiguration } from '../../services/supabase/client'
import { sendPasswordReset, sendSignInLink, signInWithPassword, signUpWithPassword, updateAccountPassword } from './authService'
import { useAuth } from './AuthProvider'
import { listSyncConflicts, resolveSyncConflict } from '../../db/syncConflictRepository'
import type { SyncConflict } from '../../db/models'

type AuthMode = 'magic-link' | 'sign-in' | 'sign-up' | 'forgot-password' | 'set-password'
const emailSchema = z.string().trim().email('Enter a valid email address.').toLowerCase()
const emailFormSchema = z.object({ email: emailSchema })
const passwordFormSchema = z.object({ email: emailSchema, password: z.string().min(8, 'Use at least 8 characters.') })
const setPasswordSchema = z.object({ password: z.string().min(8, 'Use at least 8 characters.'), confirmPassword: z.string() })
  .refine((values) => values.password === values.confirmPassword, { message: 'Passwords do not match.', path: ['confirmPassword'] })

type EmailValues = z.infer<typeof emailFormSchema>
type PasswordValues = z.infer<typeof passwordFormSchema>
type SetPasswordValues = z.infer<typeof setPasswordSchema>

function getCallbackUrl(): string { return `${window.location.origin}${window.location.pathname}` }

export function AuthPage() {
  const { status, user, workspaceStatus, workspaceUserId, signOut, passwordRecovery, completePasswordRecovery, syncNow, syncStatus, syncTrigger, isOnline, syncSummary, syncError } = useAuth()
  const [mode, setMode] = useState<AuthMode>('magic-link')
  const [notice, setNotice] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([])
  const [conflictsOwnerUserId, setConflictsOwnerUserId] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setSyncConflicts([])
    setConflictsOwnerUserId(null)
    setConflictError(null)
    if (status !== 'signed-in' || !user?.id || workspaceStatus !== 'ready' || workspaceUserId !== user.id) return () => { active = false }
    void listSyncConflicts(user.id).then((conflicts) => { if (active) { setSyncConflicts(conflicts); setConflictsOwnerUserId(user.id) } }).catch(() => {
      if (active) setConflictError('Saved sync conflicts could not be loaded for this account.')
    })
    return () => { active = false }
  }, [status, user?.id, workspaceStatus, workspaceUserId, syncSummary])

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
    try { setSignOutError(await signOut()) }
    catch { setSignOutError('We could not sign out. Check your connection and try again.') }
    finally { setIsSigningOut(false) }
  }

  const requestedMode = passwordRecovery ? 'set-password' : mode
  const isRecovery = passwordRecovery

  return (
    <section className="auth-page" aria-labelledby="auth-page-title">
      <PageHeader headingId="auth-page-title" eyebrow="YOUR ACCOUNT" title="Keep your progress close" description="Sign in on each device to prepare your account for secure cross-device sync. Your local data remains available either way." />
      <Surface className="auth-card">
        {status === 'loading' && <div className="auth-message" role="status"><span className="auth-status-icon" aria-hidden="true">◌</span><h2>Checking your account</h2><p>Your local progress stays available while we check your sign-in.</p></div>}
        {status === 'local-only' && <div className="auth-message" role="status"><span className="auth-status-icon" aria-hidden="true">⌂</span><h2>Local mode is ready</h2><p>Supabase is not configured for this build. ProgressTracker remains available on this device.</p>{supabaseConfiguration.status === 'invalid' && <p className="auth-error">{supabaseConfiguration.reason}</p>}</div>}

        {status === 'signed-in' && !isRecovery && requestedMode !== 'set-password' && (
          <div className="auth-message" role="status"><span className="auth-status-icon auth-status-icon-positive" aria-hidden="true">✓</span><h2>You’re signed in</h2><p className="auth-account-email">{user?.email}</p><p>Your local workspace is private to this account. Cloud sync starts after this workspace opens and when this browser reconnects. Local edits remain saved if a sync attempt fails.</p>
            {isOnline === false && <p className="auth-hint">You’re offline. Your local progress remains available; cloud data will be checked after reconnecting.</p>}
            {syncStatus === 'waiting' && <p className="auth-hint">Your account workspace is ready. Preparing its first cloud check…</p>}
            {syncStatus === 'syncing' && <p className="auth-hint" role="status">{syncTrigger === 'automatic' ? 'Checking your cloud progress…' : 'Syncing this account…'}</p>}
            {syncStatus === 'complete' && syncSummary && <p className="auth-success">Cloud check complete: {syncSummary.uploaded} uploaded, {syncSummary.downloaded} downloaded.</p>}
            {syncError && <p className="auth-error" role="alert">{syncError}</p>}
            {syncSummary && syncSummary.conflicts > 0 && <p className="auth-error" role="status">{syncSummary.conflicts} sync conflict{syncSummary.conflicts === 1 ? '' : 's'} need review below.</p>}
            {conflictError && <p className="auth-error" role="alert">{conflictError}</p>}
            {conflictsOwnerUserId === user?.id && workspaceStatus === 'ready' && workspaceUserId === user?.id && syncConflicts.length > 0 && <section className="sync-conflicts" aria-labelledby="sync-conflicts-title"><h3 id="sync-conflicts-title">Sync conflicts</h3><p>Choose which version to keep. Your other account’s data is never shown here.</p>{syncConflicts.map((conflict) => {
              const cloud = conflict.remoteRecord
              const cloudAvailable = Boolean(cloud && cloud.user_id === user?.id && typeof cloud.server_revision === 'number')
              const localPayload = conflict.localPayload as Record<string, unknown>
              const cloudPayload = conflict.entity === 'tracker' ? cloud?.definition as Record<string, unknown> | undefined : cloud ?? undefined
              const describe = (value: Record<string, unknown> | undefined) => value ? JSON.stringify(value, null, 2) : null
              return <article className="sync-conflict" key={conflict.id}><h4>{conflict.entity === 'tracker' ? 'Tracker' : 'Daily entry'} conflict · {conflict.entityId}</h4><div className="sync-conflict-versions"><details><summary>This device’s version</summary><pre>{describe(localPayload)}</pre></details><details><summary>Cloud version</summary><pre>{describe(cloudPayload) ?? 'Cloud copy unavailable for this account.'}</pre></details></div>{cloudAvailable ? <div className="auth-actions"><Button variant="secondary" disabled={resolvingConflict === conflict.id} onClick={() => void handleConflictResolution(conflict, 'keep-local')}>Keep this device’s version</Button><Button variant="secondary" disabled={resolvingConflict === conflict.id} onClick={() => void handleConflictResolution(conflict, 'use-cloud')}>Use cloud version</Button></div> : <><p className="auth-hint">The server did not provide a record this account can read. Save your local record under a new ID to keep it available for sync.</p><div className="auth-actions"><Button variant="secondary" disabled={resolvingConflict === conflict.id} onClick={() => void handleConflictResolution(conflict, 'fork-local')}>Save local copy as new</Button></div></>}</article>
            })}</section>}
            {signOutError && <p className="auth-error" role="alert">{signOutError}</p>}
            {notice && <p className="auth-success" role="status">{notice}</p>}
            <div className="auth-actions"><Button onClick={() => void syncNow?.()} disabled={syncStatus === 'syncing'}>{syncStatus === 'syncing' ? 'Syncing…' : 'Sync this account'}</Button><Button variant="secondary" onClick={() => { clearFeedback(); setMode('set-password') }}>Set or change password</Button><Button variant="secondary" onClick={handleSignOut} disabled={isSigningOut}>{isSigningOut ? 'Signing out…' : 'Sign out'}</Button></div>
          </div>
        )}

        {status === 'signed-out' && requestedMode === 'magic-link' && <form className="auth-form" onSubmit={emailForm.handleSubmit(onMagicLink)} noValidate>
          <div className="auth-form-heading"><span className="auth-status-icon" aria-hidden="true">✉</span><div><h2>Sign in with email</h2><p>We’ll email you a secure, one-time sign-in link.</p></div></div>
          <label className="auth-label" htmlFor="auth-email">Email address</label><input className="auth-input" id="auth-email" type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" aria-invalid={Boolean(emailForm.formState.errors.email)} {...emailForm.register('email')} />
          {emailForm.formState.errors.email && <p className="auth-error" role="alert">{emailForm.formState.errors.email.message}</p>}{notice && <p className="auth-success" role="status">{notice}</p>}{requestError && <p className="auth-error" role="alert">{requestError}</p>}
          <Button type="submit" className="auth-submit" disabled={emailForm.formState.isSubmitting}>{emailForm.formState.isSubmitting ? 'Sending link…' : 'Email me a sign-in link'}</Button>
          <div className="auth-switches"><button type="button" onClick={() => { clearFeedback(); setMode('sign-in') }}>Use password</button><button type="button" onClick={() => { clearFeedback(); setMode('sign-up') }}>Create account</button></div>
          <p className="auth-hint">No password to remember. A new account is created when you use an email for the first time.</p>
        </form>}

        {status === 'signed-out' && (requestedMode === 'sign-in' || requestedMode === 'sign-up') && <form className="auth-form" onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} noValidate>
          <div className="auth-form-heading"><span className="auth-status-icon" aria-hidden="true">◎</span><div><h2>{requestedMode === 'sign-in' ? 'Sign in with password' : 'Create your account'}</h2><p>{requestedMode === 'sign-in' ? 'Use your email and password.' : 'Choose a password with at least 8 characters.'}</p></div></div>
          <label className="auth-label" htmlFor="password-email">Email address</label><input className="auth-input" id="password-email" type="email" autoComplete="email" {...passwordForm.register('email')} />
          {passwordForm.formState.errors.email && <p className="auth-error" role="alert">{passwordForm.formState.errors.email.message}</p>}
          <label className="auth-label auth-label-spaced" htmlFor="account-password">Password</label><input className="auth-input" id="account-password" type="password" autoComplete={requestedMode === 'sign-in' ? 'current-password' : 'new-password'} {...passwordForm.register('password')} />
          {passwordForm.formState.errors.password && <p className="auth-error" role="alert">{passwordForm.formState.errors.password.message}</p>}{notice && <p className="auth-success" role="status">{notice}</p>}{requestError && <p className="auth-error" role="alert">{requestError}</p>}
          <Button type="submit" className="auth-submit" disabled={passwordForm.formState.isSubmitting}>{passwordForm.formState.isSubmitting ? 'Please wait…' : requestedMode === 'sign-in' ? 'Sign in' : 'Create account'}</Button>
          <div className="auth-switches">{requestedMode === 'sign-in' ? <><button type="button" onClick={() => { clearFeedback(); setMode('forgot-password') }}>Forgot password?</button><button type="button" onClick={() => { clearFeedback(); setMode('sign-up') }}>Create account</button></> : <button type="button" onClick={() => { clearFeedback(); setMode('sign-in') }}>Already have an account? Sign in</button>}</div>
          <button className="auth-text-button" type="button" onClick={() => { clearFeedback(); setMode('magic-link') }}>Use a magic link instead</button>
        </form>}

        {status === 'signed-out' && requestedMode === 'forgot-password' && <form className="auth-form" onSubmit={emailForm.handleSubmit(onForgotPassword)} noValidate>
          <div className="auth-form-heading"><span className="auth-status-icon" aria-hidden="true">✉</span><div><h2>Reset your password</h2><p>We’ll send a recovery link if the account can receive one.</p></div></div>
          <label className="auth-label" htmlFor="auth-email">Email address</label><input className="auth-input" id="auth-email" type="email" autoComplete="email" {...emailForm.register('email')} />
          {emailForm.formState.errors.email && <p className="auth-error" role="alert">{emailForm.formState.errors.email.message}</p>}{notice && <p className="auth-success" role="status">{notice}</p>}{requestError && <p className="auth-error" role="alert">{requestError}</p>}
          <Button type="submit" className="auth-submit" disabled={emailForm.formState.isSubmitting}>{emailForm.formState.isSubmitting ? 'Sending…' : 'Send reset link'}</Button><button className="auth-text-button" type="button" onClick={() => { clearFeedback(); setMode('sign-in') }}>Back to sign in</button>
        </form>}

        {(isRecovery || status === 'signed-in' && requestedMode === 'set-password') && <form className="auth-form" onSubmit={setPasswordForm.handleSubmit(onSetPassword)} noValidate>
          <div className="auth-form-heading"><span className="auth-status-icon" aria-hidden="true">◎</span><div><h2>{isRecovery ? 'Choose a new password' : 'Set your password'}</h2><p>{isRecovery ? 'Your recovery link is verified. Choose a new password for this account.' : 'Add a password so you can sign in without a magic link.'}</p></div></div>
          <label className="auth-label" htmlFor="new-account-password">New password</label><input className="auth-input" id="new-account-password" type="password" autoComplete="new-password" {...setPasswordForm.register('password')} />
          {setPasswordForm.formState.errors.password && <p className="auth-error" role="alert">{setPasswordForm.formState.errors.password.message}</p>}
          <label className="auth-label auth-label-spaced" htmlFor="confirm-account-password">Confirm password</label><input className="auth-input" id="confirm-account-password" type="password" autoComplete="new-password" {...setPasswordForm.register('confirmPassword')} />
          {setPasswordForm.formState.errors.confirmPassword && <p className="auth-error" role="alert">{setPasswordForm.formState.errors.confirmPassword.message}</p>}{notice && <p className="auth-success" role="status">{notice}</p>}{requestError && <p className="auth-error" role="alert">{requestError}</p>}
          <Button type="submit" className="auth-submit" disabled={setPasswordForm.formState.isSubmitting}>{setPasswordForm.formState.isSubmitting ? 'Updating…' : 'Save password'}</Button>
          {!isRecovery && <button className="auth-text-button" type="button" onClick={() => { clearFeedback(); setMode('magic-link') }}>Back to account</button>}
        </form>}
      </Surface>
    </section>
  )
}
