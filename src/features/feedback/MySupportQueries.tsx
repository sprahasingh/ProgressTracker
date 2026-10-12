import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getMySupportThread, listMySupportThreads, replyToMySupportThread, type SupportThread, type SupportThreadDetail } from './supportApi'

const statusLabel: Record<SupportThread['status'], string> = { open: 'Open', in_progress: 'In progress', waiting_for_user: 'Waiting for you', resolved: 'Resolved' }
const dateLabel = (value: string) => new Date(value).toLocaleString()

export function MySupportQueries() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('support') ?? ''
  const [threads, setThreads] = useState<SupportThread[]>([])
  const [detail, setDetail] = useState<SupportThreadDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try { setThreads((await listMySupportThreads()).threads) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Support queries could not be loaded.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    let active = true
    if (!selectedId) { setDetail(null); setDraft(''); return }
    setError('')
    void getMySupportThread(selectedId).then((value) => { if (active) { setDetail(value); setDraft('') } })
      .catch((cause) => { if (active) { setDetail(null); setError(cause instanceof Error ? cause.message : 'This support query is unavailable.') } })
    return () => { active = false }
  }, [selectedId])

  async function sendReply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || !draft.trim() || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await replyToMySupportThread(detail.thread.id, draft.trim(), crypto.randomUUID())
      setDraft(''); setNotice('Your reply was saved. The support team has been notified.')
      await Promise.all([reload(), getMySupportThread(detail.thread.id).then(setDetail)])
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your reply could not be saved. It is still here so you can retry.') }
    finally { setBusy(false) }
  }

  return <section className="settings-section support-queries" id="my-support-queries" aria-labelledby="my-support-queries-title">
    <h2 id="my-support-queries-title">My Support Queries</h2>
    <p>In-app queries and replies stay in your account. Resolved conversations are read-only; start a new query if you need more help.</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {notice && <p className="settings-hint" role="status">{notice}</p>}
    {loading ? <p role="status">Loading your support queries…</p> : threads.length === 0 ? <p className="settings-hint">You have no tracked support queries yet. Use Feedback &amp; Support above to send one.</p> : <div className="support-user-layout">
      <nav aria-label="Your support queries" className="support-thread-list">{threads.map((thread) => <button type="button" key={thread.id} className={`support-thread-option${thread.id === selectedId ? ' is-active' : ''}`} onClick={() => setSearchParams((current) => { const next = new URLSearchParams(current); next.set('support', thread.id); return next }, { preventScrollReset: true })}>
        <strong>{thread.subject}</strong><span>{statusLabel[thread.status]} · {dateLabel(thread.last_activity_at)}</span>
      </button>)}</nav>
      {detail ? <article className="support-thread-detail" aria-label={`Conversation: ${detail.thread.subject}`}>
        <header><div><h3>{detail.thread.subject}</h3><span className={`support-status is-${detail.thread.status}`}>{statusLabel[detail.thread.status]}</span></div><time dateTime={detail.thread.created_at}>{dateLabel(detail.thread.created_at)}</time></header>
        <div className="support-thread-original"><strong>Your original message</strong><p>{detail.thread.original_message}</p></div>
        <ol className="support-messages">{detail.messages.map((message) => <li key={message.id} className={`support-message is-${message.sender_role}`}><strong>{message.sender_role === 'maintainer' ? 'ProgressTracker Support' : 'You'}</strong><p>{message.body}</p><time dateTime={message.created_at}>{dateLabel(message.created_at)}</time></li>)}</ol>
        {detail.thread.status === 'resolved' ? <p className="settings-hint">This conversation is resolved. Send a new support query to continue.</p> : <form className="support-reply-form" onSubmit={(event) => void sendReply(event)}><label className="form-field"><span>Reply to support</span><textarea className="auth-input" rows={3} maxLength={4000} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} /></label><button type="submit" className="button button-primary button-medium" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send Reply'}</button></form>}
      </article> : <div className="support-thread-detail support-thread-empty"><p>Select a support query to view the conversation.</p></div>}
    </div>}
  </section>
}
