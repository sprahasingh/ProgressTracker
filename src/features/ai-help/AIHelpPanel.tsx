import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { IconButton } from '../../components/ui/IconButton'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { suggestionsByRoute, type ChatMessage, type HelpRoute } from './aiHelpService'

type Props = { messages: ChatMessage[]; draft: string; loading: boolean; route: HelpRoute; liveText: string; nearBottom: boolean; now: number; onClose: () => void; onSend: (question: string) => void; onDraftChange: (draft: string) => void; onRetry: (id: string) => void; onNewConversation: () => void; onScrollPositionChange: (near: boolean) => void; triggerRef: RefObject<HTMLButtonElement | null> }
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

export function AIHelpPanel({ messages, draft, loading, route, liveText, nearBottom, now, onClose, onSend, onDraftChange, onRetry, onNewConversation, onScrollPositionChange, triggerRef }: Props) {
  const [mobile, setMobile] = useState(() => window.matchMedia?.('(max-width: 760px)').matches ?? false)
  const panelRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const [showJump, setShowJump] = useState(false)
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
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose()
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [mobile, onClose, triggerRef])
  useEffect(() => { if (nearBottom) endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' }) }, [messages, loading, nearBottom])
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

  return <div className={`ai-help-backdrop${mobile ? ' is-mobile' : ''}`} onMouseDown={(event) => { if (mobile && event.target === event.currentTarget) onClose() }}>
    <section ref={panelRef} className={`ai-help-panel${mobile ? ' is-mobile' : ''}`} role={mobile ? 'dialog' : 'region'} aria-modal={mobile || undefined} aria-labelledby="ai-help-title" aria-describedby="ai-help-subtitle" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape' && !mobile) { event.preventDefault(); onClose() } }}>
      <header className="ai-help-header">
        <span className="ai-help-mark"><AppIcon name="spark" /></span>
        <div className="ai-help-heading"><h2 id="ai-help-title">Ask ProgressTracker</h2><p id="ai-help-subtitle">Help with features and how things work</p></div>
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
          <div className="ai-help-message-content"><MessageText content={message.content} />{message.links?.length ? <nav className="ai-help-message-links" aria-label="Related pages">{message.links.map((link) => <Link key={link.href} to={link.href}>{link.label}</Link>)}</nav> : null}{message.status === 'error' ? (() => { const remaining = message.retryAfterUntil ? Math.max(0, Math.ceil((message.retryAfterUntil - now) / 1000)) : 0; return <button type="button" className="ai-help-text-action" disabled={remaining > 0} onClick={() => onRetry(message.id)} aria-label={remaining ? `Retry in ${remaining} seconds` : 'Retry'}>{remaining ? `Retry in ${remaining}s` : 'Retry'}</button> })() : message.role === 'assistant' && <button type="button" className="ai-help-text-action" onClick={() => void navigator.clipboard?.writeText(message.content)}>Copy</button>}{message.followUps?.length && message.role === 'assistant' && message.id === latestAssistantId ? <nav className="ai-help-follow-ups" aria-label="Suggested follow-up questions">{message.followUps.map((question) => <button type="button" key={question} disabled={loading} onClick={() => onSend(question)}>{question}</button>)}</nav> : null}</div>
        </article>)}{loading && <div className="ai-help-message assistant"><span className="ai-help-message-mark"><AppIcon name="spark" /></span><div className="ai-help-loading" aria-hidden="true"><span /><span /><span /></div></div>}<div ref={endRef} /></div>}
      </div>
      {showJump && <button className="ai-help-jump" type="button" onClick={() => { endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' }); onScrollPositionChange(true); setShowJump(false) }}>Jump to latest</button>}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveText}</div>
      <form className="ai-help-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="ai-help-input">Ask about ProgressTracker</label>
        <textarea id="ai-help-input" ref={textareaRef} value={draft} rows={1} maxLength={1500} placeholder="Ask about ProgressTracker..." onChange={(event) => { onDraftChange(event.target.value); event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 132)}px` }} onKeyDown={keyDown} />
        <button className="ai-help-send" type="submit" disabled={!draft.trim() || loading} aria-label="Send message" title="Send message"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 12 20 4l-5 16-3-7-8-1Z" /><path d="m12 13 8-9" /></svg></button>
      </form>
      <p className="ai-help-privacy">General help only · Your tracker data isn’t shared</p>
    </section>
  </div>
}
