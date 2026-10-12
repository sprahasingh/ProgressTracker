import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { IconButton } from '../../components/ui/IconButton'
import { hasModalLayerAbove, useModalLayer } from '../../components/ui/useModalLayer'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { SendFeedbackAction } from '../feedback/SendFeedback'
import { SUPPORT_EMAIL } from '../../config/supportContact'
import { FeedbackSubmissionError, type GeneralFeedbackResult } from '../feedback/feedbackService'
import { suggestionsByRoute, type ChatMessage, type FeedbackCategory, type HelpRoute } from './aiHelpService'

type Props = { messages: ChatMessage[]; draft: string; loading: boolean; route: HelpRoute; liveText: string; nearBottom: boolean; now: number; onClose: () => void; onSend: (question: string) => void; onDraftChange: (draft: string) => void; onRetry: (id: string) => void; onNewConversation: () => void; onScrollPositionChange: (near: boolean) => void; onFeedback: (id: string, category: FeedbackCategory, explanation?: string) => Promise<void>; supportOpen: boolean; supportDraft: string; onSupportDraftChange: (draft: string) => void; onSupportOpen: (open: boolean) => void; onSupportSubmit: (message: string, requestId: string) => Promise<GeneralFeedbackResult>; triggerRef: RefObject<HTMLButtonElement | null> }
const internalLinks = new Map([['/trackers', 'Trackers'], ['/trackers/new', 'Create a tracker'], ['/goals', 'Goals'], ['/dashboard', 'Insights'], ['/calendar', 'Calendar'], ['/settings', 'Settings'], ['/history', 'History']])

function renderInline(text: string) {
  const segments = text.split(/(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g).filter(Boolean)
  return segments.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('http')) {
      try {
        const url = new URL(part)
        if (url.origin === window.location.origin && internalLinks.has(url.pathname)) return <Link key={index} to={url.pathname}>{internalLinks.get(url.pathname)}</Link>
        if (url.protocol === 'https:' && url.hostname === 'progress-tracker.app') return <a key={index} href={url.href}>{part}</a>
      } catch { /* Render malformed URLs as plain text. */ }
    }
    return part
  })
}

function MessageText({ content }: { content: string }) {
  return <div className="ai-help-formatted">{content.split(/\n{2,}/).map((block, index) => {
    const codeBlock = block.match(/^```(?:[a-z0-9_-]+)?\n([\s\S]*?)\n```$/i)
    if (codeBlock) return <pre key={index}><code>{codeBlock[1]}</code></pre>
    if (/^#{1,3} /.test(block)) return <h4 key={index}>{renderInline(block.replace(/^#{1,3} /, ''))}</h4>
    const lines = block.split('\n')
    if (lines.every((line) => /^[-*] /.test(line))) return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{renderInline(line.slice(2))}</li>)}</ul>
    if (lines.every((line) => /^\d+[.)] /.test(line))) return <ol key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{renderInline(line.replace(/^\d+[.)] /, ''))}</li>)}</ol>
    return <p key={index}>{lines.map((line, lineIndex) => <span key={lineIndex}>{lineIndex > 0 && <br />}{renderInline(line)}</span>)}</p>
  })}</div>
}

function AnswerFeedback({ message, onFeedback }: { message: ChatMessage; onFeedback: Props['onFeedback'] }) {
  const [showReasons, setShowReasons] = useState(false)
  const [category, setCategory] = useState<FeedbackCategory>('factually_incorrect')
  const [explanation, setExplanation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!message.knowledgeVersion || !message.topic) return null
  if (message.feedbackStatus) return <p className="ai-help-feedback-thanks" role="status">{message.feedbackStatus === 'helpful' ? 'Thanks for your feedback.' : 'Thanks. Your report was sent for review.'}</p>
  async function submit(choice: FeedbackCategory, details?: string) {
    setBusy(true)
    setError('')
    try { await onFeedback(message.id, choice, details) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Feedback could not be sent. Try again.') }
    finally { setBusy(false) }
  }
  return <div className="ai-help-feedback">
    <span>Was this answer helpful?</span>
    <button type="button" className="ai-help-text-action" disabled={busy} onClick={() => void submit('helpful')}>👍 Helpful</button>
    <button type="button" className="ai-help-text-action" disabled={busy} onClick={() => { setShowReasons(true); setError('') }}>👎 Incorrect</button>
    {showReasons && <form className="ai-help-feedback-form" onSubmit={(event) => { event.preventDefault(); void submit(category, explanation.trim() || undefined) }}>
      <label>What was wrong?<select value={category} onChange={(event) => setCategory(event.target.value as FeedbackCategory)} disabled={busy}>
        <option value="factually_incorrect">Factually incorrect</option><option value="outdated">Outdated information</option><option value="wrong_instructions">Wrong instructions</option><option value="wrong_contact">Wrong contact information</option><option value="other">Other</option>
      </select></label>
      <label>Optional note<textarea value={explanation} onChange={(event) => setExplanation(event.target.value.slice(0, 300))} maxLength={300} rows={2} placeholder="Briefly describe the issue. Don’t include personal information." disabled={busy} /></label>
      {error && <p className="ai-help-feedback-error" role="alert">{error}</p>}
      <div><button className="button button-primary button-small" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send report'}</button><button className="button button-secondary button-small" type="button" disabled={busy} onClick={() => setShowReasons(false)}>Cancel</button></div>
    </form>}
  </div>
}

export function AIHelpPanel({ messages, draft, loading, route, liveText, nearBottom, now, onClose, onSend, onDraftChange, onRetry, onNewConversation, onScrollPositionChange, onFeedback, supportOpen, supportDraft, onSupportDraftChange, onSupportOpen, onSupportSubmit, triggerRef }: Props) {
  const [mobile, setMobile] = useState(() => window.matchMedia?.('(max-width: 760px)').matches ?? false)
  const panelRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const [showJump, setShowJump] = useState(false)
  const [supportDetails, setSupportDetails] = useState('')
  const [supportBusy, setSupportBusy] = useState(false)
  const [supportError, setSupportError] = useState('')
  const [supportAccepted, setSupportAccepted] = useState(false)
  const [supportEmailStatus, setSupportEmailStatus] = useState<GeneralFeedbackResult['deliveryStatus']>('pending')
  const [supportFeedbackId, setSupportFeedbackId] = useState('')
  const requestIdRef = useRef<{ content: string; id: string } | null>(null)
  const latestAssistantId = [...messages].reverse().find((item) => item.role === 'assistant' && item.status !== 'error')?.id
  useModalLayer(mobile, panelRef, onClose)
  useVisualViewportBounds(mobile, panelRef)

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 760px)')
    if (!media) return
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (mobile) return
    const closeOutside = (event: PointerEvent) => {
      if (hasModalLayerAbove(panelRef.current)) return
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose()
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [mobile, onClose, triggerRef])
  useEffect(() => { if (nearBottom) endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' }) }, [messages, loading, nearBottom])
  useEffect(() => {
    if (!supportOpen) return
    setSupportAccepted(false)
    setSupportError('')
    setSupportDetails('')
    requestIdRef.current = null
  }, [supportOpen])
  useEffect(() => { if (!window.matchMedia?.('(max-width: 760px)').matches) textareaRef.current?.focus() }, [])

  function submit(event: FormEvent) { event.preventDefault(); if (draft.trim() && !loading) onSend(draft) }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.trim() && !loading) onSend(draft) } }
  function onListScroll() {
    const node = listRef.current
    if (!node) return
    const closeToBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 72
    onScrollPositionChange(closeToBottom)
    setShowJump(!closeToBottom)
  }

  async function submitSupport(event: FormEvent) {
    event.preventDefault()
    const message = [supportDraft.trim(), supportDetails.trim() ? `\n\nAdditional details:\n${supportDetails.trim()}` : ''].join('').trim()
    if (!message || supportBusy || supportAccepted) return
    setSupportBusy(true)
    setSupportError('')
    const requestId = requestIdRef.current?.content === message ? requestIdRef.current.id : crypto.randomUUID()
    requestIdRef.current = { content: message, id: requestId }
    try {
      const result = await onSupportSubmit(message, requestId)
      setSupportEmailStatus(result.deliveryStatus)
      setSupportFeedbackId(result.feedbackId ?? '')
      window.dispatchEvent(new Event('progress-tracker:support-feedback-changed'))
      setSupportAccepted(true)
      setSupportError('')
    } catch (error) {
      setSupportError(error instanceof FeedbackSubmissionError && error.uncertain
        ? `${error.message} Check with support before retrying to avoid a duplicate.`
        : error instanceof Error ? error.message : 'The support query could not be sent. Try again.')
    } finally { setSupportBusy(false) }
  }

  return <div className={`ai-help-backdrop${mobile ? ' is-mobile' : ''}`} onMouseDown={(event) => { if (mobile && event.target === event.currentTarget) onClose() }}>
    <section ref={panelRef} className={`ai-help-panel${mobile ? ' is-mobile' : ''}`} role={mobile ? 'dialog' : 'region'} aria-modal={mobile || undefined} aria-labelledby="ai-help-title" aria-describedby="ai-help-subtitle" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape' && !mobile && !hasModalLayerAbove(panelRef.current)) { event.preventDefault(); onClose() } }}>
      <header className="ai-help-header">
        <span className="ai-help-mark"><AppIcon name="spark" /></span>
        <div className="ai-help-heading"><h2 id="ai-help-title">Ask ProgressTracker</h2><p id="ai-help-subtitle">Help with features and how things work</p></div>
        <SendFeedbackAction variant="icon" className="ai-help-feedback-action" source="ai_help_support" />
        {messages.length > 0 && <IconButton label="Start a new conversation" title="Start a new conversation" className="ai-help-new" onClick={onNewConversation}><AppIcon name="add" /></IconButton>}
        <IconButton label="Close AI Help Assistant" title="Close" className="ai-help-close" onClick={onClose}><AppIcon name="close" /></IconButton>
      </header>
      <div className="ai-help-messages" ref={listRef} onScroll={onListScroll}>
        {messages.length === 0 ? <div className="ai-help-empty">
          <h3>Ask ProgressTracker</h3><p>Questions about trackers, streaks, goals, or anything else? I’m here to help.</p>
          <div className="ai-help-suggestions">{suggestionsByRoute[route].map((suggestion) => <button type="button" key={suggestion} disabled={loading} onClick={() => onSend(suggestion)}>{suggestion}<AppIcon name="chevron-down" /></button>)}</div>
          {!navigator.onLine && <p className="ai-help-offline-note">Some quick answers are available offline.</p>}
        </div> : <div className="ai-help-thread">{messages.map((message) => <article key={message.id} className={`ai-help-message ${message.role}${message.status === 'error' ? ' has-error' : ''}`}>
          {message.role === 'assistant' && <span className="ai-help-message-mark"><AppIcon name="spark" /></span>}
          <div className="ai-help-message-content"><MessageText content={message.content} />{message.links?.length ? <nav className="ai-help-message-links" aria-label="Related pages">{message.links.map((link) => <Link key={link.href} to={link.href}>{link.label}</Link>)}</nav> : null}{message.status === 'error' ? (() => { const remaining = message.retryAfterUntil ? Math.max(0, Math.ceil((message.retryAfterUntil - now) / 1000)) : 0; return <button type="button" className="ai-help-text-action" disabled={remaining > 0} onClick={() => onRetry(message.id)} aria-label={remaining ? `Retry in ${remaining} seconds` : 'Retry'}>{remaining ? `Retry in ${remaining}s` : 'Retry'}</button> })() : message.role === 'assistant' && <><button type="button" className="ai-help-text-action" onClick={() => void navigator.clipboard?.writeText(message.content)}>Copy</button>{message.offerSupport && <button type="button" className="ai-help-text-action ai-help-raise-support" onClick={() => { onSupportDraftChange(message.supportPrefill ?? ''); onSupportOpen(true) }}>Raise Support Query</button>}<AnswerFeedback message={message} onFeedback={onFeedback} /></>}{message.followUps?.length && message.role === 'assistant' && message.id === latestAssistantId ? <nav className="ai-help-follow-ups" aria-label="Suggested follow-up questions">{message.followUps.map((question) => <button type="button" key={question} disabled={loading} onClick={() => onSend(question)}>{question}</button>)}</nav> : null}</div>
        </article>)}{loading && <div className="ai-help-message assistant"><span className="ai-help-message-mark"><AppIcon name="spark" /></span><div className="ai-help-loading" aria-hidden="true"><span /><span /><span /></div></div>}<div ref={endRef} /></div>}
      </div>
      {showJump && <button className="ai-help-jump" type="button" onClick={() => { endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' }); onScrollPositionChange(true); setShowJump(false) }}>Jump to latest</button>}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveText}</div>
      {supportOpen ? <form className="ai-help-support-form" onSubmit={(event) => void submitSupport(event)}>
        {supportAccepted ? <div className="ai-help-support-success" role="status"><strong>Support query saved.</strong><span>{supportEmailStatus === 'accepted' ? `The email provider accepted a notification for ${SUPPORT_EMAIL}; inbox delivery may take a little time.` : supportEmailStatus === 'uncertain' ? 'The query is saved, but email notification delivery could not be confirmed and will not be retried automatically.' : supportEmailStatus === 'failed' ? 'The query is saved, but its support email notification could not be sent.' : 'The query is saved and its support email notification is pending.'}</span>{supportFeedbackId && <><small>Reference: {supportFeedbackId}</small><Link className="button button-secondary button-small" to={`/settings?support=${encodeURIComponent(supportFeedbackId)}`} onClick={onClose}>View support query</Link></>}<button type="button" className="button button-secondary button-small" onClick={() => { onSupportOpen(false); setSupportAccepted(false); setSupportDetails(''); setSupportError(''); requestIdRef.current = null }}>Return to conversation</button></div> : <>
          <label htmlFor="ai-help-support-message">Support query <small>Review and edit before sending.</small></label>
          <textarea id="ai-help-support-message" value={supportDraft} maxLength={1800} rows={3} onChange={(event) => { onSupportDraftChange(event.target.value.slice(0, 1800)); requestIdRef.current = null; setSupportError('') }} disabled={supportBusy} required />
          <label htmlFor="ai-help-support-details">Additional details <small>Optional. Don’t include passwords, sign-in links, or private tracker data.</small></label>
          <textarea id="ai-help-support-details" value={supportDetails} maxLength={1000} rows={2} placeholder="Add details if needed" onChange={(event) => { setSupportDetails(event.target.value.slice(0, 1000)); requestIdRef.current = null; setSupportError('') }} disabled={supportBusy} />
          <p className="ai-help-support-destination">To: {SUPPORT_EMAIL}. Your signed-in account email is used only as the reply address. Only the text shown above will be sent.</p>
          {supportError && <p className="ai-help-support-error" role="alert">{supportError}</p>}
          <footer><button type="button" className="button button-secondary button-small" onClick={() => { if (!supportBusy) { onSupportOpen(false); setSupportError('') } }} disabled={supportBusy}>Cancel</button><button type="submit" className="button button-primary button-small" disabled={supportBusy || !supportDraft.trim()}>{supportBusy ? 'Sending…' : 'Send Query'}</button></footer>
        </>}
      </form> : <form className="ai-help-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="ai-help-input">Ask about ProgressTracker</label>
        <textarea id="ai-help-input" ref={textareaRef} value={draft} rows={1} maxLength={1500} placeholder="Ask about ProgressTracker..." onChange={(event) => { onDraftChange(event.target.value); event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 132)}px` }} onKeyDown={keyDown} />
        <button className="ai-help-send" type="submit" disabled={!draft.trim() || loading} aria-label="Send message" title="Send message"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 12 20 4l-5 16-3-7-8-1Z" /><path d="m12 13 8-9" /></svg></button>
      </form>}
      {!supportOpen && <p className="ai-help-privacy">General help only · Your tracker data isn’t shared</p>}
    </section>
  </div>
}
