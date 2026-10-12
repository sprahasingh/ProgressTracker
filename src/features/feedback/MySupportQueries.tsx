import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getMySupportThread, listMySupportThreads, replyToMySupportThread, type SupportThread, type SupportThreadDetail } from './supportApi'

const statusLabel: Record<SupportThread['status'], string> = { open: 'Open', in_progress: 'In progress', waiting_for_user: 'Waiting for you', resolved: 'Resolved' }
const dateLabel = (value: string) => new Date(value).toLocaleString()

export function MySupportQueries({ embedded = false }: { embedded?: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('support') ?? ''
  const [threads, setThreads] = useState<SupportThread[]>([])
  const [detail, setDetail] = useState<SupportThreadDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [listError, setListError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [notice, setNotice] = useState('')
  const sectionRef = useRef<HTMLElement>(null)

  const reload = useCallback(async () => {
    setLoading(true); setListError('')
    try { setThreads((await listMySupportThreads()).threads) }
    catch (cause) { setListError(cause instanceof Error ? cause.message : 'Support queries could not be loaded.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    void reload()
    const refresh = () => { void reload() }
    window.addEventListener('progress-tracker:support-feedback-changed', refresh)
    return () => window.removeEventListener('progress-tracker:support-feedback-changed', refresh)
  }, [reload])
  useEffect(() => {
    let active = true
    if (!selectedId) { setDetail(null); setDraft(''); setDetailError(''); return }
    setDetail(null)
    setDetailError('')
    void getMySupportThread(selectedId).then((value) => { if (active) { setDetail(value); setDraft(''); requestAnimationFrame(() => { sectionRef.current?.scrollIntoView?.({ block: 'start' }); sectionRef.current?.focus({ preventScroll: true }) } ) } })
      .catch((cause) => { if (active) { setDetail(null); setDetailError(cause instanceof Error ? cause.message : 'This support query is unavailable.') } })
    return () => { active = false }
  }, [selectedId])

  async function sendReply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || !draft.trim() || busy) return
    setBusy(true); setDetailError(''); setNotice('')
    try {
      const result = await replyToMySupportThread(detail.thread.id, draft.trim(), crypto.randomUUID())
      setDraft(''); setNotice(result.emailStatus === 'accepted' ? 'Your reply was saved. The email provider accepted a support notification; inbox delivery may take a little time.' : result.emailStatus === 'uncertain' ? 'Your reply was saved, but email notification delivery could not be confirmed.' : result.emailStatus === 'failed' ? 'Your reply was saved, but the support email notification could not be sent.' : 'Your reply was saved and the support team will see it in the inbox.')
      await Promise.all([reload(), getMySupportThread(detail.thread.id).then(setDetail)])
    } catch (cause) { setDetailError(cause instanceof Error ? cause.message : 'Your reply could not be saved. It is still here so you can retry.') }
    finally { setBusy(false) }
  }

  const Container = embedded ? 'div' : 'section'
  return <Container ref={(node: HTMLElement | null) => { sectionRef.current = node }} tabIndex={-1} className={embedded ? 'support-queries support-queries-embedded' : 'settings-section support-queries'} id={embedded ? undefined : 'my-support-queries'} aria-labelledby={embedded ? undefined : 'my-support-queries-title'}>
    {!embedded && <h2 id="my-support-queries-title">My Support Queries</h2>}
    <p>In-app queries and replies stay in your account. Resolved conversations are read-only; start a new query if you need more help.</p>
    {notice && !loading && !listError && <p className="settings-hint" role="status">{notice}</p>}
    {loading ? <p role="status">Loading your support queries…</p> : listError ? <div className="support-load-error"><p className="auth-error" role="alert">{listError}</p><button type="button" className="button button-secondary button-small" onClick={() => void reload()}>Try again</button></div> : threads.length === 0 && selectedId && detailError ? <div className="support-load-error"><p className="auth-error" role="alert">{detailError}</p><button type="button" className="button button-secondary button-small" onClick={() => { setDetailError(''); void getMySupportThread(selectedId).then(setDetail).catch((cause) => setDetailError(cause instanceof Error ? cause.message : 'This support query is unavailable.')) }}>Try again</button></div> : threads.length === 0 ? <p className="settings-hint">You have no tracked support queries yet. Use Feedback &amp; Support above to send one.</p> : <div className="support-user-layout">
      <nav aria-label="Your support queries" className="support-thread-list">{threads.map((thread) => <button type="button" key={thread.id} className={`support-thread-option${thread.id === selectedId ? ' is-active' : ''}`} onClick={() => setSearchParams((current) => { const next = new URLSearchParams(current); next.set('support', thread.id); return next }, { preventScrollReset: true })}>
        <strong>{thread.subject}</strong><span>{statusLabel[thread.status]} · {dateLabel(thread.last_activity_at)}</span>
      </button>)}</nav>
      {detail ? <article className="support-thread-detail" aria-label={`Conversation: ${detail.thread.subject}`}>
        {detailError && <p className="auth-error" role="alert">{detailError}</p>}
        <header><div><h3>{detail.thread.subject}</h3><span className={`support-status is-${detail.thread.status}`}>{statusLabel[detail.thread.status]}</span></div><time dateTime={detail.thread.created_at}>{dateLabel(detail.thread.created_at)}</time></header>
        <div className="support-thread-original"><strong>Your original message</strong><p>{detail.thread.original_message}</p></div>
        <ol className="support-messages">{detail.messages.map((message) => <li key={message.id} className={`support-message is-${message.sender_role}`}><strong>{message.sender_role === 'maintainer' ? 'ProgressTracker Support' : 'You'}</strong><p>{message.body}</p><time dateTime={message.created_at}>{dateLabel(message.created_at)}</time></li>)}</ol>
        {detail.thread.status === 'resolved' ? <p className="settings-hint">This conversation is resolved. Send a new support query to continue.</p> : <form className="support-reply-form" onSubmit={(event) => void sendReply(event)}><label className="form-field"><span>Reply to support</span><textarea className="auth-input" rows={3} maxLength={4000} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} /></label><button type="submit" className="button button-primary button-medium" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send Reply'}</button></form>}
      </article> : <div className="support-thread-detail support-thread-empty">{detailError ? <><p className="auth-error" role="alert">{detailError}</p>{selectedId && <button type="button" className="button button-secondary button-small" onClick={() => { setDetailError(''); void getMySupportThread(selectedId).then(setDetail).catch((cause) => setDetailError(cause instanceof Error ? cause.message : 'This support query is unavailable.')) }}>Try again</button>}</> : <p>Select a support query to view the conversation.</p>}</div>}
    </div>}
  </Container>
}
