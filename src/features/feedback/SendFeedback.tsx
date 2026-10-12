import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { IconButton } from '../../components/ui/IconButton'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { SUPPORT_EMAIL } from '../../config/supportContact'
import { getSupabaseClient } from '../../services/supabase/client'
import { useAuth } from '../auth/AuthProvider'
import { FeedbackSubmissionError, submitGeneralFeedback, type GeneralFeedbackCategory } from './feedbackService'

const categoryLabels: Record<GeneralFeedbackCategory, string> = {
  bug_report: 'Bug report', feature_request: 'Feature request', general_feedback: 'General feedback', help_support: 'Help / Support',
}

function createRequestId() { return crypto.randomUUID() }

function SendFeedbackDialog({ open, onClose, signedIn, accountEmail, source }: { open: boolean; onClose: () => void; signedIn: boolean; accountEmail?: string | null; source: 'settings' | 'ai_help_support' | 'other' }) {
  const [category, setCategory] = useState<GeneralFeedbackCategory>('general_feedback')
  const [message, setMessage] = useState('')
  const [shareEmail, setShareEmail] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryAllowed, setRetryAllowed] = useState(true)
  const [outcomeUncertain, setOutcomeUncertain] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [copied, setCopied] = useState(false)
  const [emailStatus, setEmailStatus] = useState<'accepted' | 'pending' | 'failed' | 'uncertain' | 'not_required'>('pending')
  const [feedbackId, setFeedbackId] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const requestRef = useRef<{ requestId: string; category: GeneralFeedbackCategory; message: string } | null>(null)

  useModalLayer(open, dialogRef, onClose, { manageHistoryEntry: false })
  useVisualViewportBounds(open, backdropRef)
  useEffect(() => {
    if (open) dialogRef.current?.focus({ preventScroll: true })
  }, [open])
  useEffect(() => {
    if (!open) {
      setCategory('general_feedback')
      setMessage('')
      setShareEmail(true)
      setBusy(false)
      setError('')
      setRetryAllowed(true)
      setOutcomeUncertain(false)
      setAccepted(false)
      setCopied(false)
      setEmailStatus('pending')
      setFeedbackId('')
      busyRef.current = false
      requestRef.current = null
    }
  }, [open])

  if (!open) return null

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    const cleanMessage = message.trim()
    if (!cleanMessage) { setError('Enter a message before sending.'); return }
    if (cleanMessage.length > 2000) { setError('Keep your message under 2,000 characters.'); return }
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setOutcomeUncertain(false)
    const prior = requestRef.current
    const requestId = prior && prior.category === category && prior.message === cleanMessage ? prior.requestId : createRequestId()
    requestRef.current = { requestId, category, message: cleanMessage }
    try {
      const result = await submitGeneralFeedback(getSupabaseClient(), { category, message: cleanMessage, requestId, source, shareEmail })
      setEmailStatus(result.deliveryStatus)
      setFeedbackId(result.feedbackId ?? '')
      window.dispatchEvent(new Event('progress-tracker:support-feedback-changed'))
      setAccepted(true)
      setMessage('')
      requestRef.current = null
    } catch (cause) {
      if (cause instanceof FeedbackSubmissionError) {
        setRetryAllowed(cause.retryable && !cause.uncertain)
        setOutcomeUncertain(cause.uncertain)
      } else {
        setRetryAllowed(true)
      }
      setError(cause instanceof Error ? cause.message : 'Couldn’t send your feedback right now. You can email us directly instead.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL)
      setCopied(true)
    } catch { setCopied(false) }
  }

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`[ProgressTracker Feedback] ${categoryLabels[category]}`)}&body=${encodeURIComponent(`Feedback type: ${categoryLabels[category]}\n\n${message.trim()}`)}`

  return createPortal(<div ref={backdropRef} className="send-feedback-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialogRef} className="send-feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="send-feedback-title" aria-describedby="send-feedback-dialog-description" tabIndex={-1}>
      <p className="sr-only" id="send-feedback-dialog-description">Send a bug report, feature request, general feedback, or support question.</p>
      <header className="send-feedback-heading"><div><span className="send-feedback-eyebrow">PROGRESS TRACKER</span><h2 id="send-feedback-title">Send Feedback</h2></div><IconButton label="Close feedback" title="Close" onClick={onClose} disabled={busy}><AppIcon name="close" /></IconButton></header>
      {accepted ? <><div className="send-feedback-content send-feedback-scroll"><p className="send-feedback-success" role="status"><AppIcon name="check" />Feedback saved. Thank you for helping improve ProgressTracker!</p><p>{emailStatus === 'accepted' ? 'The email provider accepted a notification for sending. Delivery to the support inbox may take a little time.' : emailStatus === 'uncertain' ? 'The feedback is saved, but notification delivery could not be confirmed. It will not be retried automatically to avoid a duplicate.' : emailStatus === 'failed' ? 'The feedback is saved, but the support email notification could not be sent. You can still contact support directly.' : emailStatus === 'pending' ? 'The feedback is saved. Its support email notification is pending.' : 'The feedback is saved.'}</p>{feedbackId && <small>Reference: {feedbackId}</small>}<p>Find support conversations later in Settings → My Support Queries.</p></div><footer className="send-feedback-actions"><button type="button" className="button button-primary button-medium" onClick={onClose}>Done</button></footer></> : <>
        <form id="general-feedback-form" className="send-feedback-content send-feedback-scroll" onSubmit={(event) => void submit(event)}>
        <label className="form-field" htmlFor="general-feedback-category"><span>Feedback type</span><select id="general-feedback-category" className="auth-input" value={category} onChange={(event) => setCategory(event.target.value as GeneralFeedbackCategory)} disabled={busy}><option value="bug_report">Bug report</option><option value="feature_request">Feature request</option><option value="general_feedback">General feedback</option><option value="help_support">Help / Support</option></select></label>
        <label className="form-field" htmlFor="general-feedback-message"><span>Your message</span><textarea id="general-feedback-message" className="auth-input send-feedback-textarea" value={message} onChange={(event) => setMessage(event.target.value.slice(0, 2000))} maxLength={2000} rows={6} placeholder="Tell us what's happening or what you'd like improved..." disabled={busy} required aria-describedby="send-feedback-privacy send-feedback-count" /></label>
        <div className="send-feedback-meta"><small id="send-feedback-count">{message.length}/2,000</small>{signedIn && shareEmail && accountEmail && <small>Email shared with support: {accountEmail}</small>}</div>
        {signedIn && <label className="send-feedback-share-email"><input type="checkbox" checked={shareEmail} onChange={(event) => setShareEmail(event.target.checked)} disabled={busy} /><span><strong>Share my email with support</strong><small>{shareEmail ? 'Support can contact you directly by email as well as reply in the app.' : 'Email sharing is off. You can still see replies in Notifications and My Support Queries.'}</small></span></label>}
        <p className="settings-hint" id="send-feedback-privacy">Don’t include passwords, sign-in links, access tokens, or private tracker details. Your message is saved in Feedback &amp; Support.</p>
        {!signedIn && <p className="send-feedback-error" role="status">Sign in to submit feedback here. You can still contact support using the fallback below.</p>}
        {error && <p className="send-feedback-error" role="alert">{error}</p>}
        {(error || !signedIn) && <section className="send-feedback-fallback" aria-label="Email support fallback"><p>{outcomeUncertain ? 'We could not confirm whether the message was accepted. To avoid a duplicate, automatic retry is disabled. Please email us directly if you still need help.' : "Couldn't send your feedback right now. You can email us directly instead."}</p><strong>{SUPPORT_EMAIL}</strong><div><a className="button button-secondary button-small" href={mailto}>Email Support</a><button type="button" className="button button-secondary button-small" onClick={() => void copyEmail()}>Copy Email</button></div>{copied && <small role="status">Support email copied.</small>}</section>}
        </form>
        <footer className="send-feedback-actions">
          <button type="button" className="button button-secondary button-medium" onClick={onClose} disabled={busy}>Cancel</button>
          {error && signedIn && retryAllowed
            ? <button type="button" className="button button-primary button-medium" disabled={busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Try Again'}</button>
            : signedIn && !error && <button form="general-feedback-form" type="submit" className="button button-primary button-medium" disabled={busy || !message.trim()}>{busy ? 'Sending…' : 'Send Feedback'}</button>}
        </footer>
      </>}
    </section>
  </div>, document.body)
}

export function SendFeedbackAction({ variant = 'button', className = '', source = 'settings' }: { variant?: 'button' | 'icon'; className?: string; source?: 'settings' | 'ai_help_support' | 'other' }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const routeAtOpen = useRef('')
  const popDismissed = useRef(false)
  const scrollAtOpen = useRef(0)
  const auth = useAuth()
  const signedIn = auth.status === 'signed-in' && Boolean(auth.user?.id)
  const accountEmail = signedIn ? auth.user?.email ?? null : null
  const close = () => setOpen(false)
  useEffect(() => {
    if (!open) return
    routeAtOpen.current = `${location.pathname}${location.search}${location.hash}`
    popDismissed.current = false
    scrollAtOpen.current = window.scrollY
    // Add a router-managed entry at the same route so browser Back dismisses
    // the dialog without popping the user's actual page from history.
    navigate(routeAtOpen.current, { state: location.state, preventScrollReset: true })
    const handlePopState = () => {
      popDismissed.current = true
      close()
    }
    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
      if (!popDismissed.current) navigate(-1)
      requestAnimationFrame(() => {
        if (window.scrollY !== scrollAtOpen.current) window.scrollTo(0, scrollAtOpen.current)
      })
    }
    // This effect represents one modal history entry; its route is captured at open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return <>
    {variant === 'icon' ? <IconButton className={className} label="Send general feedback" title="Send Feedback" onClick={() => setOpen(true)}><AppIcon name="mail" /></IconButton>
      : <button type="button" className={className || 'button button-secondary button-medium'} onClick={() => setOpen(true)}><AppIcon name="mail" />Send Feedback</button>}
    <SendFeedbackDialog open={open} onClose={close} signedIn={signedIn} accountEmail={accountEmail} source={source} />
  </>
}
