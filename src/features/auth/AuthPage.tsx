import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, type SubmitHandler } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { supabaseConfiguration } from '../../services/supabase/client'
import { sendSignInLink } from './authService'
import { useAuth } from './AuthProvider'

const emailFormSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').toLowerCase(),
})

type EmailFormValues = z.infer<typeof emailFormSchema>

function getCallbackUrl(): string {
  return `${window.location.origin}${window.location.pathname}`
}

export function AuthPage() {
  const { status, user, signOut } = useAuth()
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<EmailFormValues>({
    resolver: zodResolver(emailFormSchema),
    defaultValues: { email: '' },
  })

  const onSubmit: SubmitHandler<EmailFormValues> = async ({ email }) => {
    setRequestError(null)
    try {
      const result = await sendSignInLink(email, getCallbackUrl())
      if (result.error) {
        setRequestError(result.error)
        return
      }
      setSentTo(email)
    } catch {
      setRequestError('We could not reach Supabase. Check your connection and try again.')
    }
  }

  async function handleSignOut() {
    setIsSigningOut(true)
    try {
      setSignOutError(await signOut())
    } catch {
      setSignOutError('We could not sign out. Check your connection and try again.')
    } finally {
      setIsSigningOut(false)
    }
  }

  return (
    <section className="auth-page" aria-labelledby="auth-page-title">
      <PageHeader
        headingId="auth-page-title"
        eyebrow="YOUR ACCOUNT"
        title="Keep your progress close"
        description="Sign in on each device to prepare your account for secure cross-device sync. Your local data remains available either way."
      />

      <Surface className="auth-card">
        {status === 'loading' && (
          <div className="auth-message" role="status">
            <span className="auth-status-icon" aria-hidden="true">◌</span>
            <h2>Checking your account</h2>
            <p>Your local progress stays available while we check your sign-in.</p>
          </div>
        )}

        {status === 'local-only' && (
          <div className="auth-message" role="status">
            <span className="auth-status-icon" aria-hidden="true">⌂</span>
            <h2>Local mode is ready</h2>
            <p>Supabase is not configured for this build. ProgressTracker remains available on this device.</p>
            {supabaseConfiguration.status === 'invalid' && <p className="auth-error">{supabaseConfiguration.reason}</p>}
          </div>
        )}

        {status === 'signed-in' && (
          <div className="auth-message" role="status">
            <span className="auth-status-icon auth-status-icon-positive" aria-hidden="true">✓</span>
            <h2>You’re signed in</h2>
            <p className="auth-account-email">{user?.email}</p>
            <p>Your data is still saved locally. Cloud synchronization will become available in a later step.</p>
            {signOutError && <p className="auth-error" role="alert">{signOutError}</p>}
            <Button variant="secondary" onClick={handleSignOut} disabled={isSigningOut}>
              {isSigningOut ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        )}

        {status === 'signed-out' && (sentTo ? (
          <div className="auth-message" role="status">
            <span className="auth-status-icon auth-status-icon-positive" aria-hidden="true">✉</span>
            <h2>Check your inbox</h2>
            <p>We sent a sign-in link to <strong>{sentTo}</strong>. Open it on this device to finish signing in.</p>
            <p className="auth-hint">For cross-device use, request a separate link on each device.</p>
            <Button variant="secondary" onClick={() => setSentTo(null)}>Use a different email</Button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit(onSubmit)} noValidate>
            <div className="auth-form-heading">
              <span className="auth-status-icon" aria-hidden="true">✉</span>
              <div><h2>Sign in with email</h2><p>We’ll email you a secure, one-time sign-in link.</p></div>
            </div>
            <label className="auth-label" htmlFor="auth-email">Email address</label>
            <input
              className="auth-input"
              id="auth-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'auth-email-error' : undefined}
              {...register('email')}
            />
            {errors.email && <p id="auth-email-error" className="auth-error" role="alert">{errors.email.message}</p>}
            {requestError && <p className="auth-error" role="alert">{requestError}</p>}
            <Button type="submit" className="auth-submit" disabled={isSubmitting}>
              {isSubmitting ? 'Sending link…' : 'Email me a sign-in link'}
            </Button>
            <p className="auth-hint">No password to remember. A new account is created when you use an email for the first time.</p>
          </form>
        ))}
      </Surface>
    </section>
  )
}
