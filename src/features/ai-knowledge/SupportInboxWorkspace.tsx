import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { getSupportInboxThread, listSupportInbox, replyAsMaintainer, setSupportThreadStatus, type SupportCategory, type SupportInboxFilters, type SupportInboxList, type SupportStatus, type SupportThread, type SupportThreadDetail } from '../feedback/supportApi'

const categories: Array<{ id: SupportCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All feedback' }, { id: 'support_query', label: 'Support queries' }, { id: 'bug_report', label: 'Bug reports' },
  { id: 'feature_request', label: 'Feature requests' }, { id: 'general_feedback', label: 'General feedback' }, { id: 'ai_answer_feedback', label: 'AI answer feedback' },
]
const statuses: Array<{ id: SupportStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All statuses' }, { id: 'open', label: 'Open' }, { id: 'in_progress', label: 'In progress' }, { id: 'waiting_for_user', label: 'Waiting for user' }, { id: 'resolved', label: 'Resolved' },
]
const labelStatus = (status: SupportStatus) => statuses.find((item) => item.id === status)?.label ?? status
const labelCategory = (category: SupportCategory) => categories.find((item) => item.id === category)?.label ?? category
const dateLabel = (value: string) => new Date(value).toLocaleString()

type InboxThread = SupportThread & { user_email?: string | null }
type InboxResult = Omit<SupportInboxList, 'threads'> & { threads: InboxThread[] }

export function SupportInboxWorkspace() {
  const [category, setCategory] = useState<SupportCategory | 'all'>('all')
  const [status, setStatus] = useState<SupportStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<InboxResult | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<SupportThreadDetail | null>(null)
  const [reply, setReply] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  const reload = useCallback(async (append = false) => {
    setLoading(true); setError('')
    const filters: SupportInboxFilters & { sort: 'newest' | 'oldest' } = { category, status, search, offset: append ? offset : 0, sort }
    try {
      const next = await listSupportInbox(filters)
      setResult((current) => append && current ? { ...next, threads: [...current.threads, ...next.threads] } : next)
      if (!append) setOffset(0)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Feedback could not be loaded.') }
    finally { setLoading(false) }
  }, [category, offset, search, sort, status])
  useEffect(() => { void reload() }, [category, search, sort, status, refreshKey])
  useEffect(() => {
    let active = true
    if (!selectedId) { setDetail(null); setReply(''); return }
    setError('')
    void getSupportInboxThread(selectedId).then((value) => { if (active) { setDetail(value); setReply('') } })
      .catch((cause) => { if (active) { setDetail(null); setError(cause instanceof Error ? cause.message : 'The conversation could not be loaded.') } })
    return () => { active = false }
  }, [selectedId, refreshKey])

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || !reply.trim() || busy) return
    setBusy(true); setError('')
    try {
      await replyAsMaintainer(detail.thread.id, reply.trim(), crypto.randomUUID())
      setReply('')
      setRefreshKey((value) => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The reply could not be saved. Your draft remains available.') }
    finally { setBusy(false) }
  }
  async function updateStatus(next: SupportStatus) {
    if (!detail || busy) return
    setBusy(true); setError('')
    try {
      await setSupportThreadStatus(detail.thread.id, next)
      setRefreshKey((value) => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The status could not be updated.') }
    finally { setBusy(false) }
  }
  const loadMore = async () => { setOffset((value) => value + 25); setLoading(true); setError(''); try { const next = await listSupportInbox({ category, status, search, offset: offset + 25, sort }); setResult((current) => current ? { ...next, threads: [...current.threads, ...next.threads] } : next) } catch (cause) { setError(cause instanceof Error ? cause.message : 'More feedback could not be loaded.') } finally { setLoading(false) } }

  return <section className="tracker-page ai-knowledge-page support-inbox-page" aria-labelledby="support-inbox-title">
    <header className="ai-feedback-heading"><div><h2 id="support-inbox-title">Feedback &amp; Support</h2><p>Review in-app feedback and continue support conversations. Opening a thread marks it reviewed.</p></div><button type="button" className="button button-secondary button-small" onClick={() => setRefreshKey((value) => value + 1)}>Refresh</button></header>
    <div className="ai-knowledge-counts support-inbox-metrics" aria-label="Feedback overview">
      {[['Total feedback', result?.metrics.total], ['Open', result?.metrics.open], ['Waiting for user', result?.metrics.waiting], ['Resolved', result?.metrics.resolved], ['Unread', result?.metrics.unread], ['Incorrect AI answers', result?.metrics.incorrect_ai]].map(([label, count]) => <div className="ai-knowledge-count" key={label as string}><span>{label}</span><strong>{count ?? '—'}</strong></div>)}
    </div>
    <div className="ai-knowledge-workspace-tabs support-inbox-categories" aria-label="Feedback categories">{categories.map((item) => <button type="button" key={item.id} aria-pressed={category === item.id} className={category === item.id ? 'is-active' : ''} onClick={() => setCategory(item.id)}>{item.label}</button>)}<button type="button" aria-pressed={status === 'resolved'} className={status === 'resolved' ? 'is-active' : ''} onClick={() => setStatus(status === 'resolved' ? 'all' : 'resolved')}>Resolved</button></div>
    <section className="surface ai-knowledge-browser support-inbox-browser" aria-label="Feedback inbox">
      <div className="ai-knowledge-toolbar"><label className="support-search"><span>Search subject</span><input className="auth-input" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={80} placeholder="Search feedback" /></label><label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as SupportStatus | 'all')}>{statuses.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as 'newest' | 'oldest')}><option value="newest">Most recent activity</option><option value="oldest">Oldest activity</option></select></label></div>
      {error && <div className="ai-knowledge-error" role="alert"><p>{error}</p><button type="button" className="button button-secondary button-small" onClick={() => setRefreshKey((value) => value + 1)}>Retry</button></div>}
      {loading && !result ? <p className="ai-knowledge-loading" role="status">Loading feedback…</p> : !result?.threads.length ? <div className="ai-knowledge-empty"><h3>No feedback in this view</h3><p>Try another category or status.</p></div> : <div className="support-inbox-layout">
        <div className="support-inbox-list" role="list" aria-label="Feedback records">{result.threads.map((thread) => <button type="button" role="listitem" key={thread.id} className={`support-inbox-row${selectedId === thread.id ? ' is-active' : ''}`} onClick={() => setSelectedId(thread.id)}>
          <span className="support-inbox-row-title"><strong>{thread.subject}</strong>{!thread.maintainer_seen_at && <span className="support-unread">New</span>}</span><span>{labelCategory(thread.category)} · {thread.source.replaceAll('_',' ')}</span><span>{thread.user_email ?? 'Deleted account'} · {dateLabel(thread.created_at)}</span><span className={`support-status is-${thread.status}`}>{labelStatus(thread.status)}</span><small>Email: {thread.email_status.replaceAll('_',' ')}</small>
        </button>)}</div>
        {result.has_more && <button className="button button-secondary button-small" type="button" disabled={loading} onClick={() => void loadMore()}>{loading ? 'Loading…' : 'Load more feedback'}</button>}
        {detail ? <article className="support-thread-detail support-admin-thread" aria-label={`Feedback detail: ${detail.thread.subject}`}>
          <header><div><h3>{detail.thread.subject}</h3><span className="support-status is-open">{labelCategory(detail.thread.category)}</span></div><time dateTime={detail.thread.created_at}>{dateLabel(detail.thread.created_at)}</time></header>
          <dl className="support-admin-meta"><div><dt>From</dt><dd>{detail.user_email ?? 'Deleted account'}</dd></div><div><dt>Source</dt><dd>{detail.thread.source.replaceAll('_',' ')}</dd></div><div><dt>Email notification</dt><dd>{detail.thread.email_status.replaceAll('_',' ')}</dd></div><div><dt>Status</dt><dd>{labelStatus(detail.thread.status)}</dd></div></dl>
          <section className="support-thread-original"><h4>Original feedback</h4><p>{detail.thread.original_message}</p></section>
          {detail.thread.category === 'ai_answer_feedback' && <section className="support-thread-original"><h4>AI answer context</h4><dl><div><dt>Category</dt><dd>{String(detail.thread.metadata.answer_category ?? '')}</dd></div><div><dt>Topic</dt><dd>{String(detail.thread.metadata.topic ?? '')}</dd></div><div><dt>Knowledge bundle</dt><dd>{String(detail.thread.metadata.knowledge_version ?? '')}</dd></div><div><dt>Response ID</dt><dd>{String(detail.thread.metadata.response_id ?? '')}</dd></div></dl></section>}
          <ol className="support-messages">{detail.messages.map((message) => <li key={message.id} className={`support-message is-${message.sender_role}`}><strong>{message.sender_role === 'maintainer' ? 'Support team' : 'User follow-up'}</strong><p>{message.body}</p><time dateTime={message.created_at}>{dateLabel(message.created_at)}</time></li>)}</ol>
          <form className="support-reply-form" onSubmit={(event) => void sendReply(event)}><label className="form-field"><span>Reply to user</span><textarea className="auth-input" value={reply} onChange={(event) => setReply(event.target.value)} rows={4} maxLength={4000} disabled={busy} /></label><button className="button button-primary button-medium" type="submit" disabled={busy || !reply.trim()}>{busy ? 'Sending…' : 'Send Reply'}</button></form>
          <label className="support-status-control"><span>Thread status</span><select value={detail.thread.status} disabled={busy} onChange={(event) => void updateStatus(event.target.value as SupportStatus)}>{statuses.filter((item) => item.id !== 'all').map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        </article> : <div className="support-thread-detail support-thread-empty"><p>Select feedback to view its message and conversation.</p></div>}
      </div>}
      {loading && result && <p role="status">Refreshing feedback…</p>}
    </section>
  </section>
}
