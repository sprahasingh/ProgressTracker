import { useCallback, useEffect, useState } from 'react'
import { listAnswerFeedback, reviewAnswerFeedback, type AnswerFeedback, type AnswerFeedbackCategory, type AnswerFeedbackStatus } from './aiKnowledgeApi'

const categories: Array<{ value: AnswerFeedbackCategory | 'all'; label: string }> = [
  { value: 'all', label: 'All categories' }, { value: 'helpful', label: 'Helpful' },
  { value: 'factually_incorrect', label: 'Factually incorrect' }, { value: 'outdated', label: 'Outdated' },
  { value: 'wrong_instructions', label: 'Wrong instructions' }, { value: 'wrong_contact', label: 'Wrong contact' }, { value: 'other', label: 'Other' },
]
const statuses: Array<{ value: AnswerFeedbackStatus | 'all'; label: string }> = [
  { value: 'pending', label: 'Needs review' }, { value: 'reviewed', label: 'Reviewed' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All statuses' },
]
const labelFor = (value: string) => categories.find((item) => item.value === value)?.label ?? value
const displayDate = (value: string) => new Date(value).toLocaleString()

export function AnswerFeedbackWorkspace() {
  const [status, setStatus] = useState<AnswerFeedbackStatus | 'all'>('pending')
  const [category, setCategory] = useState<AnswerFeedbackCategory | 'all'>('all')
  const [rows, setRows] = useState<AnswerFeedback[]>([])
  const [counts, setCounts] = useState<Record<AnswerFeedbackStatus, number>>({ pending: 0, reviewed: 0, resolved: 0 })
  const [currentVersion, setCurrentVersion] = useState('')
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [refresh, setRefresh] = useState(0)

  const reload = useCallback(() => setRefresh((value) => value + 1), [])
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void listAnswerFeedback({ status, category, limit: 100, offset: 0 }).then((result) => {
      if (!active) return
      setRows(result.feedback)
      setCounts(result.counts)
      setCurrentVersion(result.current_knowledge_version)
      setHasLoaded(true)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Answer feedback could not be loaded.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [status, category, refresh])

  async function mark(row: AnswerFeedback, next: 'reviewed' | 'resolved') {
    if (busyId) return
    setBusyId(row.id)
    setError('')
    try {
      await reviewAnswerFeedback(row.id, next)
      reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Feedback could not be updated.') }
    finally { setBusyId('') }
  }

  return <section className="ai-feedback-workspace" aria-labelledby="ai-feedback-title">
    <header className="ai-feedback-heading"><div><h2 id="ai-feedback-title">Answer Feedback</h2><p>Reports include a category and optional note only. They do not include the conversation or assistant answer text.</p></div><button type="button" className="button button-secondary button-small" onClick={reload}>Refresh</button></header>
    {hasLoaded && <div className="ai-knowledge-counts" aria-label="Answer feedback counts">
      {(['pending', 'reviewed', 'resolved'] as const).map((key) => <button type="button" key={key} className={`ai-knowledge-count${status === key ? ' is-active' : ''}`} onClick={() => setStatus(key)}><span>{key === 'pending' ? 'Needs review' : key[0]!.toLocaleUpperCase() + key.slice(1)}</span><strong>{counts[key]}</strong></button>)}
    </div>}
    <div className="surface ai-knowledge-browser">
      <div className="ai-knowledge-toolbar ai-feedback-toolbar">
        <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value as AnswerFeedbackCategory | 'all')}>{categories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as AnswerFeedbackStatus | 'all')}>{statuses.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      </div>
      {error && <div className="ai-knowledge-error" role="alert"><p>{error}</p><button className="button button-secondary button-small" type="button" onClick={reload}>Retry</button></div>}
      {loading && <div className="ai-knowledge-loading" role="status">{hasLoaded ? 'Refreshing answer feedback…' : 'Loading answer feedback…'}</div>}
      {!loading && <>
      {error && hasLoaded && <p className="ai-knowledge-stale" role="status">Showing the last successfully loaded results. They may be out of date.</p>}
      {!error && rows.length === 0 ? <div className="ai-knowledge-empty"><h3>No feedback reports in this view</h3><p>New reports appear here after a user submits feedback on an AI Help answer.</p></div> : rows.length > 0 && <div className="ai-feedback-list">
        {rows.map((row) => <article className="ai-feedback-row" key={row.id}>
          <header><div><strong>{labelFor(row.category)}</strong><span className={`ai-knowledge-status is-${row.status === 'pending' ? 'pending' : 'verified'}`}>{row.status}</span></div><time dateTime={row.created_at}>{displayDate(row.created_at)}</time></header>
          {row.explanation ? <p className="ai-feedback-explanation">{row.explanation}</p> : <p className="ai-feedback-muted">No optional note was supplied.</p>}
          <dl><div><dt>Topic</dt><dd>{row.topic}</dd></div><div><dt>Reported bundle</dt><dd><code>{row.knowledge_version}</code></dd></div><div><dt>Current bundle</dt><dd><code>{currentVersion}</code></dd></div><div><dt>Response</dt><dd><code>{row.response_id.slice(0, 8)}</code></dd></div><div><dt>User</dt><dd><code>{row.user_id.slice(0, 8)}</code></dd></div></dl>
          {row.status === 'pending' && <footer><button type="button" className="button button-secondary button-small" disabled={Boolean(busyId)} onClick={() => void mark(row, 'reviewed')}>{busyId === row.id ? 'Saving…' : 'Mark reviewed'}</button><button type="button" className="button button-primary button-small" disabled={Boolean(busyId)} onClick={() => void mark(row, 'resolved')}>{busyId === row.id ? 'Saving…' : 'Mark resolved'}</button></footer>}
          {row.reviewer_id && <small>Reviewed by maintainer {row.reviewer_id.slice(0, 8)} · {row.reviewed_at ? displayDate(row.reviewed_at) : 'date unavailable'}</small>}
        </article>)}
      </div>}
      </>}
    </div>
  </section>
}
