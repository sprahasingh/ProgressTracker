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
const topicLabels: Record<string, string> = {
  core: 'Core AI Help', trackers: 'Trackers', goals: 'Goals', schedules: 'Schedules', history: 'History',
  analytics: 'Analytics', sync: 'Sync', privacy: 'Privacy', account: 'Account', notifications: 'Notifications', settings: 'Settings', other: 'Other',
}
const categoryLabel = (value: string) => categories.find((item) => item.value === value)?.label ?? 'Unknown feedback category'
const statusLabel = (value: AnswerFeedbackStatus) => statuses.find((item) => item.value === value)?.label ?? 'Needs review'
const topicLabel = (value: string) => topicLabels[value] ?? 'Unknown topic'

function displayDate(value: string | null | undefined) {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function CopyIdentifier({ label, value }: { label: string; value: string }) {
  const [message, setMessage] = useState('')
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setMessage(`${label} copied.`)
    } catch {
      setMessage('Copy is unavailable in this browser.')
    }
  }
  return <span className="ai-feedback-copy"><button type="button" className="button button-secondary button-small" onClick={() => void copy()} aria-label={`Copy ${label}`}>Copy</button>{message && <span role="status">{message}</span>}</span>
}

function TechnicalValue({ label, value, copy = false }: { label: string; value: string; copy?: boolean }) {
  return <div><dt>{label}</dt><dd><code>{value || 'Unavailable'}</code>{copy && value && <CopyIdentifier label={label} value={value} />}</dd></div>
}

function FeedbackCard({ row, currentVersion, busy, onMark }: {
  row: AnswerFeedback
  currentVersion: string
  busy: boolean
  onMark: (row: AnswerFeedback, next: 'reviewed' | 'resolved') => void
}) {
  const versionChanged = Boolean(row.knowledge_version && currentVersion && row.knowledge_version !== currentVersion)
  return <article className="ai-feedback-row" aria-label={`${categoryLabel(row.category)} feedback, ${statusLabel(row.status)}`}>
    <header>
      <div className="ai-feedback-card-heading">
        <strong>{categoryLabel(row.category)}</strong>
        <span className={`ai-knowledge-status is-${row.status}`} aria-label={`Status: ${statusLabel(row.status)}`}>{statusLabel(row.status)}</span>
      </div>
      <time dateTime={row.created_at}>{displayDate(row.created_at)}</time>
    </header>
    <p className="ai-feedback-explanation">{row.explanation?.trim() || <span className="ai-feedback-muted">No additional details provided.</span>}</p>
    <p className="ai-feedback-topic"><span>AI Help topic</span><strong>{topicLabel(row.topic)}</strong></p>
    <p className="ai-feedback-identity"><span>Submitted by</span><strong>{row.identity
      ? [row.identity.display_name, row.identity.email].filter((value): value is string => Boolean(value)).join(' · ') || 'Identity shared'
      : 'Submitted anonymously'}</strong></p>
    {versionChanged && <p className="ai-feedback-version-note"><strong>AI Help version changed since this feedback was submitted.</strong><small>This does not necessarily mean the reported issue has been fixed.</small></p>}
    {row.status === 'pending' && <footer>
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => onMark(row, 'reviewed')}>{busy ? 'Saving…' : 'Mark reviewed'}</button>
      <button type="button" className="button button-primary button-small" disabled={busy} onClick={() => onMark(row, 'resolved')}>{busy ? 'Saving…' : 'Mark resolved'}</button>
    </footer>}
    {row.status !== 'pending' && row.reviewed_at && <p className="ai-feedback-reviewed-date">{row.status === 'resolved' ? 'Closed' : 'Reviewed'} {displayDate(row.reviewed_at)}</p>}
    <details className="ai-feedback-technical">
      <summary>Technical details</summary>
      <dl>
        <TechnicalValue label="Reported bundle identifier" value={row.knowledge_version} copy />
        <TechnicalValue label="Current bundle identifier" value={currentVersion} copy />
        <TechnicalValue label="Feedback identifier" value={row.id} copy />
        {row.identity && row.response_id && <TechnicalValue label="Response identifier" value={row.response_id} copy />}
      </dl>
    </details>
  </article>
}

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
    <header className="ai-feedback-heading"><div><h2 id="ai-feedback-title">Answer Feedback</h2><p>Needs review means not yet investigated. Reviewed means examined by a maintainer. Resolved means addressed or otherwise closed.</p></div><button type="button" className="button button-secondary button-small" onClick={reload} disabled={loading}>Refresh</button></header>
    {hasLoaded && <div className="ai-knowledge-counts" aria-label="Answer feedback counts">
      {(['pending', 'reviewed', 'resolved'] as const).map((key) => <button type="button" key={key} className={`ai-knowledge-count${status === key ? ' is-active' : ''}`} aria-pressed={status === key} onClick={() => setStatus(key)}><span>{statusLabel(key)}</span><strong>{counts[key]}</strong></button>)}
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
          {rows.map((row) => <FeedbackCard key={row.id} row={row} currentVersion={currentVersion} busy={Boolean(busyId)} onMark={(item, next) => void mark(item, next)} />)}
        </div>}
      </>}
    </div>
  </section>
}
