import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { createAnswerFeedbackCandidate, listAnswerFeedback, reviewAnswerFeedback, setAnswerFeedbackKnowledgeDecision, type AnswerFeedback, type AnswerFeedbackCategory, type AnswerFeedbackKnowledgeDecision, type AnswerFeedbackStatus, type CandidateFields } from './aiKnowledgeApi'

const categories: Array<{ value: AnswerFeedbackCategory | 'all'; label: string }> = [
  { value: 'all', label: 'All categories' }, { value: 'helpful', label: 'Helpful' },
  { value: 'factually_incorrect', label: 'Factually incorrect' }, { value: 'outdated', label: 'Outdated' },
  { value: 'wrong_instructions', label: 'Wrong instructions' }, { value: 'wrong_contact', label: 'Wrong contact' }, { value: 'other', label: 'Other' },
]
const statuses: Array<{ value: AnswerFeedbackStatus | 'all'; label: string }> = [
  { value: 'pending', label: 'New' }, { value: 'reviewed', label: 'Reviewed' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All statuses' },
]
const decisions: Array<{ value: AnswerFeedbackKnowledgeDecision; label: string }> = [
  { value: 'not_decided', label: 'Not decided' },
  { value: 'create_candidate', label: 'Create knowledge candidate' },
  { value: 'no_knowledge_change', label: 'No knowledge change needed' },
]
const featureCategories = ['core', 'trackers', 'goals', 'schedules', 'history', 'analytics', 'sync', 'privacy', 'account', 'notifications', 'settings', 'other']
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

function FeedbackCard({ row, currentVersion, candidateSourceRefs, busy, onStatus, onDecision, onCreateCandidate, onOpenCandidate }: {
  row: AnswerFeedback
  currentVersion: string
  candidateSourceRefs: string[]
  busy: boolean
  onStatus: (row: AnswerFeedback, next: AnswerFeedbackStatus) => void
  onDecision: (row: AnswerFeedback, next: AnswerFeedbackKnowledgeDecision) => void
  onCreateCandidate: (row: AnswerFeedback, fields: CandidateFields) => void
  onOpenCandidate: (candidateId: string) => void
}) {
  const versionChanged = Boolean(row.knowledge_version && currentVersion && row.knowledge_version !== currentVersion)
  const [draft, setDraft] = useState<CandidateFields>(() => ({
    topic_id: `${row.topic || 'other'}.answer_guidance`,
    title: `Improve ${topicLabel(row.topic).toLocaleLowerCase()} answer guidance`,
    explanation: '', detailed_explanation: null,
    feature_category: featureCategories.includes(row.topic) ? row.topic : 'other',
    source_refs: [],
  }))
  function submitCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onCreateCandidate(row, draft)
  }
  return <article className="ai-feedback-row" aria-label={`${categoryLabel(row.category)} feedback, ${statusLabel(row.status)}`}>
    <header>
      <div className="ai-feedback-card-heading">
        <strong>{categoryLabel(row.category)}</strong>
        <span className={`ai-knowledge-status is-${row.status}`} aria-label={`Status: ${statusLabel(row.status)}`}>{statusLabel(row.status)}</span>
      </div>
      <time dateTime={row.created_at}>{displayDate(row.created_at)}</time>
    </header>
    <p className="ai-feedback-explanation"><strong>Reported problem</strong><br />{row.explanation?.trim() || <span className="ai-feedback-muted">No additional details provided.</span>}</p>
    <p className="ai-feedback-topic"><span>AI Help answer context</span><strong>{topicLabel(row.topic)}</strong><small>Source bundle: {row.knowledge_version || 'Unavailable'}. The exact answer text is not retained with this report.</small></p>
    <p className="ai-feedback-identity"><span>Submitted by</span><strong>{row.identity
      ? [row.identity.display_name, row.identity.email].filter((value): value is string => Boolean(value)).join(' · ') || 'Identity shared'
      : 'Submitted anonymously'}</strong></p>
    {versionChanged && <p className="ai-feedback-version-note"><strong>AI Help version changed since this feedback was submitted.</strong><small>This does not necessarily mean the reported issue has been fixed.</small></p>}
    {row.status !== 'pending' && row.reviewed_at && <p className="ai-feedback-reviewed-date">{row.status === 'resolved' ? 'Closed' : 'Reviewed'} {displayDate(row.reviewed_at)}</p>}
    <details className="ai-feedback-review-details">
      <summary>Maintainer review</summary>
      <div className="ai-feedback-review-controls">
        <label><span>Review status</span><select aria-label="Review status" value={row.status} disabled={busy} onChange={(event) => onStatus(row, event.target.value as AnswerFeedbackStatus)}>{statuses.filter((item) => item.value !== 'all').map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label><span>Knowledge decision</span><select aria-label="Knowledge decision" value={row.knowledge_decision} disabled={busy} onChange={(event) => onDecision(row, event.target.value as AnswerFeedbackKnowledgeDecision)}>{decisions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        {row.knowledge_decision === 'no_knowledge_change' && <p className="ai-feedback-muted">This report is recorded without proposing a knowledge update.</p>}
        {row.candidate && <div className="ai-feedback-linked-candidate"><span>Linked knowledge candidate</span><strong>{row.candidate.title}</strong><span className={`ai-knowledge-status is-${row.candidate.status}`}>{row.candidate.status}</span><button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => onOpenCandidate(row.candidate!.id)}>Open candidate</button></div>}
        {row.knowledge_decision === 'create_candidate' && !row.candidate && <form className="ai-feedback-candidate-form" onSubmit={submitCandidate}>
          <p>Draft a general answer that is supported by current product sources. The user’s report is context only; it is not copied into the knowledge entry.</p>
          <label>Candidate topic ID<input value={draft.topic_id} onChange={(event) => setDraft((value) => ({ ...value, topic_id: event.target.value }))} required maxLength={100} /></label>
          <label>Candidate title<input value={draft.title} onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))} required minLength={5} maxLength={120} /></label>
          <label>Feature category<select value={draft.feature_category} onChange={(event) => setDraft((value) => ({ ...value, feature_category: event.target.value }))}>{featureCategories.map((value) => <option key={value} value={value}>{topicLabel(value)}</option>)}</select></label>
          <label>Proposed answer<textarea value={draft.explanation} onChange={(event) => setDraft((value) => ({ ...value, explanation: event.target.value }))} required minLength={40} maxLength={1200} rows={4} /></label>
          <label>Additional detail (optional)<textarea value={draft.detailed_explanation ?? ''} onChange={(event) => setDraft((value) => ({ ...value, detailed_explanation: event.target.value || null }))} maxLength={2400} rows={3} /></label>
          <label>Supporting source files<select aria-label="Supporting source files" multiple size={5} value={draft.source_refs} onChange={(event) => {
            const sourceRefs = [...event.currentTarget.selectedOptions].map((option) => option.value)
            setDraft((value) => ({ ...value, source_refs: sourceRefs }))
          }}>{candidateSourceRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}</select></label>
          <small>Choose one to four current indexed source files. The review service checks the explanation against their current evidence.</small>
          <button type="submit" className="button button-primary button-small" disabled={busy || !draft.source_refs.length || draft.source_refs.length > 4}>{busy ? 'Creating…' : 'Create pending candidate'}</button>
        </form>}
      </div>
    </details>
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

export function AnswerFeedbackWorkspace({ onOpenCandidate = () => undefined }: { onOpenCandidate?: (candidateId: string) => void }) {
  const [status, setStatus] = useState<AnswerFeedbackStatus | 'all'>('pending')
  const [category, setCategory] = useState<AnswerFeedbackCategory | 'all'>('all')
  const [rows, setRows] = useState<AnswerFeedback[]>([])
  const [counts, setCounts] = useState<Record<AnswerFeedbackStatus, number>>({ pending: 0, reviewed: 0, resolved: 0 })
  const [currentVersion, setCurrentVersion] = useState('')
  const [candidateSourceRefs, setCandidateSourceRefs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [notice, setNotice] = useState('')
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
      setCandidateSourceRefs(result.candidate_source_refs)
      setHasLoaded(true)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Answer feedback could not be loaded.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [status, category, refresh])

  async function mark(row: AnswerFeedback, next: AnswerFeedbackStatus) {
    if (busyId) return
    setBusyId(row.id)
    setError('')
    setNotice('')
    try {
      await reviewAnswerFeedback(row.id, next)
      setNotice(`Review status changed to ${statusLabel(next)}.`)
      reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Feedback could not be updated.') }
    finally { setBusyId('') }
  }

  async function decide(row: AnswerFeedback, next: AnswerFeedbackKnowledgeDecision) {
    if (busyId) return
    setBusyId(row.id)
    setError('')
    setNotice('')
    try {
      await setAnswerFeedbackKnowledgeDecision(row.id, next)
      setNotice('Knowledge decision saved.')
      reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Knowledge decision could not be saved.') }
    finally { setBusyId('') }
  }

  async function createCandidate(row: AnswerFeedback, fields: CandidateFields) {
    if (busyId) return
    setBusyId(row.id)
    setError('')
    setNotice('')
    try {
      const result = await createAnswerFeedbackCandidate(row.id, fields)
      setNotice(result.duplicate ? 'An existing pending candidate was linked to this feedback.' : 'A pending knowledge candidate was created and linked. It still requires maintainer review and approval.')
      reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Knowledge candidate could not be created.') }
    finally { setBusyId('') }
  }

  return <section className="ai-feedback-workspace" aria-labelledby="ai-feedback-title">
    <header className="ai-feedback-heading"><div><h2 id="ai-feedback-title">Answer Feedback</h2><p>Needs review means not yet investigated. Reviewed means examined by a maintainer. Resolved means addressed or otherwise closed.</p></div><button type="button" className="button button-secondary button-small" onClick={reload} disabled={loading}>Refresh</button></header>
    {hasLoaded && <div className="ai-knowledge-counts" aria-label="Answer feedback counts">
      {(['pending', 'reviewed', 'resolved'] as const).map((key) => <button type="button" key={key} className={`ai-knowledge-count${status === key ? ' is-active' : ''}`} aria-pressed={status === key} onClick={() => setStatus(key)}><span>{statusLabel(key)}</span><strong>{counts[key]}</strong></button>)}
    </div>}
    {notice && <p className="ai-feedback-save-notice" role="status">{notice}</p>}
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
          {rows.map((row) => <FeedbackCard key={row.id} row={row} currentVersion={currentVersion} candidateSourceRefs={candidateSourceRefs} busy={busyId === row.id} onStatus={(item, next) => void mark(item, next)} onDecision={(item, next) => void decide(item, next)} onCreateCandidate={(item, fields) => void createCandidate(item, fields)} onOpenCandidate={onOpenCandidate} />)}
        </div>}
      </>}
    </div>
  </section>
}
