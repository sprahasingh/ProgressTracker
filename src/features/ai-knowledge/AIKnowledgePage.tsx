import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { Navigate, useNavigate, useOutletContext } from 'react-router-dom'
import { PageHeader } from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/ToastProvider'
import { useAuth } from '../auth/AuthProvider'
import { getCandidate, getVerifiedTopic, invalidateVerifiedTopic, listKnowledge, ReviewApiError, revalidateTopic, reviewCandidate } from './aiKnowledgeApi'
import type { CandidateFields, KnowledgeCandidate, ReviewCounts, ReviewDetail, ReviewSort, ReviewStatus, VerifiedTopic } from './aiKnowledgeApi'
import type { MaintainerAccess } from './useMaintainerAccess'
import { AnswerFeedbackWorkspace } from './AnswerFeedbackWorkspace'
import { SupportInboxWorkspace } from './SupportInboxWorkspace'

const tabs: Array<{ id: ReviewStatus; label: string; countKey: keyof ReviewCounts }> = [
  { id: 'pending', label: 'Pending', countKey: 'pending' },
  { id: 'verified', label: 'Approved', countKey: 'approved' },
  { id: 'stale', label: 'Stale', countKey: 'stale' },
  { id: 'rejected', label: 'Rejected', countKey: 'rejected' },
]
const categories = ['core', 'trackers', 'goals', 'schedules', 'history', 'analytics', 'sync', 'privacy', 'account', 'notifications', 'settings', 'other']
const PAGE_SIZE = 50

type Item = { kind: 'candidate'; value: KnowledgeCandidate } | { kind: 'topic'; value: VerifiedTopic }
type EditableFields = CandidateFields

function itemKey(item: Item) { return item.kind === 'candidate' ? `candidate:${item.value.id}` : `topic:${item.value.topic_id}` }
function displayDate(value: string | null | undefined) { return value ? new Date(value).toLocaleString() : 'Not reviewed' }
function safeApiMessage(error: unknown) { return error instanceof Error ? error.message : 'The request could not be completed. Try again.' }

function KnowledgeWorkspace() {
  const { notify } = useToast()
  const [workspaceTab, setWorkspaceTab] = useState<'knowledge' | 'feedback' | 'support'>('knowledge')
  const [tab, setTab] = useState<ReviewStatus>('pending')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<ReviewSort>('newest')
  const [items, setItems] = useState<Item[]>([])
  const [counts, setCounts] = useState<ReviewCounts>({ pending: 0, approved: 0, stale: 0, rejected: 0 })
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [selected, setSelected] = useState<Item | null>(null)
  const [detail, setDetail] = useState<ReviewDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [busyAction, setBusyAction] = useState('')
  const [confirmApproval, setConfirmApproval] = useState(false)
  const [invalidationReason, setInvalidationReason] = useState('')
  const [editing, setEditing] = useState(false)
  const [fields, setFields] = useState<EditableFields | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])
  useEffect(() => {
    if (workspaceTab !== 'knowledge') return
    let active = true
    setLoading(true)
    setError('')
    void listKnowledge({ status: tab, search, sort, limit: PAGE_SIZE, offset: 0 }).then((result) => {
      if (!active) return
      const next: Item[] = [
        ...result.candidates.map((value) => ({ kind: 'candidate' as const, value })),
        ...result.verified_knowledge.map((value) => ({ kind: 'topic' as const, value })),
      ]
      next.sort((left, right) => {
        const leftDate = sort === 'reviewed' ? left.value.reviewed_at ?? (left.kind === 'candidate' ? left.value.created_at : '') : left.kind === 'candidate' ? left.value.created_at : left.value.reviewed_at
        const rightDate = sort === 'reviewed' ? right.value.reviewed_at ?? (right.kind === 'candidate' ? right.value.created_at : '') : right.kind === 'candidate' ? right.value.created_at : right.value.reviewed_at
        return (sort === 'oldest' ? 1 : -1) * (Date.parse(leftDate) - Date.parse(rightDate))
      })
      setItems(next)
      setCounts(result.counts)
      setHasMore(result.page.has_more)
    }).catch((cause) => {
      if (active) setError(safeApiMessage(cause))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [tab, search, sort, refreshKey, workspaceTab])

  useEffect(() => {
    if (!selected) return
    let active = true
    setDetail(null)
    setDetailError('')
    setDetailLoading(true)
    const load = selected.kind === 'candidate' ? getCandidate(selected.value.id) : getVerifiedTopic(selected.value.topic_id)
    void load.then((result) => {
      if (!active) return
      setDetail(result)
      const record = result.candidate ?? result.entry
      if (record) setFields({ topic_id: record.topic_id, title: record.title, explanation: record.explanation, detailed_explanation: record.detailed_explanation, feature_category: record.feature_category, source_refs: record.source_refs })
      setEditing(false)
      setConfirmApproval(false)
      setInvalidationReason('')
    }).catch((cause) => { if (active) setDetailError(safeApiMessage(cause)) })
      .finally(() => { if (active) setDetailLoading(false) })
    return () => { active = false }
  }, [selected, refreshKey])

  useEffect(() => {
    if (!selected) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyAction) { closeDetail(); return }
      if (event.key !== 'Tab') return
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')
      if (!controls?.length) { event.preventDefault(); dialogRef.current?.focus(); return }
      const first = controls[0]!
      const last = controls[controls.length - 1]!
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', closeOnEscape)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [selected, busyAction])

  const selectedCandidate = detail?.candidate
  const selectedTopic = detail?.entry
  const activeRecord = selectedCandidate ?? selectedTopic
  const visibleItems = useMemo(() => items, [items])

  function openDetail(item: Item, event: MouseEvent<HTMLElement>) {
    returnFocusRef.current = event.currentTarget
    setSelected(item)
  }
  function closeDetail() {
    setSelected(null)
    setDetail(null)
    setFields(null)
    setEditing(false)
    setConfirmApproval(false)
    requestAnimationFrame(() => returnFocusRef.current?.focus())
  }
  async function loadMore() {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await listKnowledge({ status: tab, search, sort, limit: PAGE_SIZE, offset: items.length })
      const next: Item[] = [...result.candidates.map((value) => ({ kind: 'candidate' as const, value })), ...result.verified_knowledge.map((value) => ({ kind: 'topic' as const, value }))]
      next.sort((left, right) => {
        const leftDate = sort === 'reviewed' ? left.value.reviewed_at ?? (left.kind === 'candidate' ? left.value.created_at : '') : left.kind === 'candidate' ? left.value.created_at : left.value.reviewed_at
        const rightDate = sort === 'reviewed' ? right.value.reviewed_at ?? (right.kind === 'candidate' ? right.value.created_at : '') : right.kind === 'candidate' ? right.value.created_at : right.value.reviewed_at
        return (sort === 'oldest' ? 1 : -1) * (Date.parse(leftDate) - Date.parse(rightDate))
      })
      setItems((current) => [...current, ...next.filter((item) => !current.some((existing) => itemKey(existing) === itemKey(item)))])
      setHasMore(result.page.has_more)
      setCounts(result.counts)
    } catch (cause) { setError(safeApiMessage(cause)) }
    finally { setLoadingMore(false) }
  }
  async function performReview(action: 'approve' | 'reject' | 'defer' | 'edit') {
    if (!selectedCandidate || busyAction) return
    if (action === 'approve' && !confirmApproval) { setConfirmApproval(true); return }
    setBusyAction(action)
    setDetailError('')
    try {
      await reviewCandidate(action, selectedCandidate, action === 'edit' || action === 'approve' ? fields ?? undefined : undefined)
      notify({ kind: 'success', title: action === 'approve' ? 'Knowledge approved' : action === 'reject' ? 'Candidate rejected' : action === 'edit' ? 'Candidate updated' : 'Candidate deferred', description: 'The review service confirmed the change.' })
      closeDetail()
      refresh()
    } catch (cause) {
      const message = safeApiMessage(cause)
      setDetailError(message)
      if (cause instanceof ReviewApiError && cause.status === 409) refresh()
    } finally { setBusyAction('') }
  }
  async function queueRevalidation() {
    if (!selectedTopic || selectedTopic.status !== 'stale' || busyAction) return
    setBusyAction('revalidate')
    setDetailError('')
    try {
      await revalidateTopic({ ...selectedTopic, ...fields })
      notify({ kind: 'success', title: 'Re-review queued', description: 'The topic is pending approval against current source evidence.' })
      closeDetail()
      refresh()
    } catch (cause) { setDetailError(safeApiMessage(cause)) }
    finally { setBusyAction('') }
  }
  async function invalidateTopic() {
    if (!selectedTopic || selectedTopic.status !== 'verified' || invalidationReason.trim().length < 8 || busyAction) return
    setBusyAction('invalidate')
    setDetailError('')
    try {
      await invalidateVerifiedTopic(selectedTopic, invalidationReason.trim())
      notify({ kind: 'success', title: 'Topic marked stale', description: 'It is excluded from AI Help until it is reviewed against current evidence.' })
      closeDetail()
      refresh()
    } catch (cause) { setDetailError(safeApiMessage(cause)) }
    finally { setBusyAction('') }
  }
  function updateField<K extends keyof EditableFields>(key: K, value: EditableFields[K]) { setFields((current) => current ? { ...current, [key]: value } : current) }

  if (workspaceTab === 'support') return <section className="tracker-page ai-knowledge-page support-inbox-page" aria-labelledby="ai-knowledge-title">
    <PageHeader headingId="ai-knowledge-title" eyebrow="MAINTAINER TOOLS" title="Feedback & Support" description="Manage user feedback and support conversations." />
    <nav className="ai-knowledge-workspace-tabs" aria-label="Maintainer workspace">
      <button type="button" onClick={() => setWorkspaceTab('knowledge')}>Knowledge candidates</button>
      <button type="button" onClick={() => setWorkspaceTab('feedback')}>Answer Feedback</button>
      <button type="button" aria-current="page" className="is-active">Feedback &amp; Support</button>
    </nav>
    <SupportInboxWorkspace />
  </section>

  if (workspaceTab === 'feedback') return <section className="tracker-page ai-knowledge-page" aria-labelledby="ai-knowledge-title">
    <PageHeader headingId="ai-knowledge-title" eyebrow="MAINTAINER TOOLS" title="AI Knowledge" description="Review knowledge and user-reported answer issues." />
    <nav className="ai-knowledge-workspace-tabs" aria-label="AI Knowledge workspace">
      <button type="button" aria-current="false" onClick={() => setWorkspaceTab('knowledge')}>Knowledge candidates</button>
      <button type="button" aria-current="page" className="is-active">Answer Feedback</button>
      <button type="button" onClick={() => setWorkspaceTab('support')}>Feedback &amp; Support</button>
    </nav>
    <AnswerFeedbackWorkspace />
  </section>

  return <section className="tracker-page ai-knowledge-page" aria-labelledby="ai-knowledge-title">
    <PageHeader headingId="ai-knowledge-title" eyebrow="MAINTAINER TOOLS" title="AI Knowledge" description="Review and manage the knowledge your AI assistant uses." />
    <nav className="ai-knowledge-workspace-tabs" aria-label="AI Knowledge workspace">
      <button type="button" aria-current="page" className="is-active">Knowledge candidates</button>
      <button type="button" aria-current="false" onClick={() => setWorkspaceTab('feedback')}>Answer Feedback</button>
      <button type="button" onClick={() => setWorkspaceTab('support')}>Feedback &amp; Support</button>
    </nav>
    <p className="ai-knowledge-intro">Candidates are proposed automatically from current product evidence. Each one stays pending until a maintainer reviews and approves it.</p>
    <div className="ai-knowledge-counts" aria-label="Knowledge review counts">
      {tabs.map(({ id, label, countKey }) => <button type="button" key={id} className={`ai-knowledge-count${tab === id ? ' is-active' : ''}`} onClick={() => setTab(id)}>
        <span>{label}</span><strong>{counts[countKey]}</strong>
      </button>)}
    </div>
    <section className="surface ai-knowledge-browser" aria-label="Knowledge entries">
      <div className="ai-knowledge-toolbar">
        <div className="ai-knowledge-tabs" role="tablist" aria-label="Filter by review status">
          {tabs.map(({ id, label }) => <button type="button" role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)}>{label}</button>)}
        </div>
        <div className="ai-knowledge-tools">
          <label><span className="sr-only">Search topic and knowledge text</span><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') setSearch(searchInput.trim()) }} placeholder="Search knowledge" /></label>
          <button className="button button-secondary button-small" type="button" onClick={() => setSearch(searchInput.trim())}>Search</button>
          <label className="ai-knowledge-sort"><span className="sr-only">Sort entries</span><select value={sort} onChange={(event) => setSort(event.target.value as ReviewSort)}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="reviewed">Last reviewed</option></select></label>
          <button className="button button-secondary button-small ai-knowledge-refresh" type="button" onClick={refresh} aria-label="Refresh knowledge list">Refresh</button>
        </div>
      </div>
      {error && <div className="ai-knowledge-error" role="alert"><p>{error}</p><button className="button button-secondary button-small" type="button" onClick={refresh}>Retry</button></div>}
      {loading ? <div className="ai-knowledge-loading" role="status">Loading knowledge entries…</div>
        : visibleItems.length === 0 ? <div className="ai-knowledge-empty"><h2>No {tabs.find((item) => item.id === tab)?.label.toLowerCase()} knowledge</h2><p>{search ? 'Try a different search, or clear the search field.' : 'There are no entries in this view yet.'}</p></div>
          : <div className="ai-knowledge-list">{visibleItems.map((item) => {
            const value = item.value
            const entryStatus = value.status
            return <button type="button" className="ai-knowledge-row" key={itemKey(item)} onClick={(event) => openDetail(item, event)}>
              <span className="ai-knowledge-row-main"><strong>{value.title}</strong><span className="ai-knowledge-topic">{value.topic_id} · {value.feature_category}</span><span className="ai-knowledge-summary">{value.explanation}</span></span>
              <span className={`ai-knowledge-status is-${entryStatus}`}>{entryStatus === 'verified' ? 'Approved' : entryStatus === 'pending' ? 'Pending' : entryStatus === 'stale' ? 'Stale' : 'Rejected'}</span>
              <span className="ai-knowledge-row-date">{item.kind === 'candidate' ? `Added ${displayDate(item.value.created_at)}` : `Reviewed ${displayDate(item.value.reviewed_at)}`}</span>
            </button>
          })}</div>}
      {!loading && hasMore && <div className="ai-knowledge-load-more"><button className="button button-secondary button-small" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button></div>}
    </section>

    {selected && <div className="ai-knowledge-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyAction) closeDetail() }}>
      <section ref={dialogRef} className="ai-knowledge-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-knowledge-detail-title" tabIndex={-1}>
        <header className="ai-knowledge-dialog-header"><div><span className="eyebrow"><span className="eyebrow-line" />{selectedCandidate ? 'CANDIDATE REVIEW' : 'VERIFIED TOPIC'}</span><h2 id="ai-knowledge-detail-title">{activeRecord?.title ?? 'Knowledge details'}</h2></div><button type="button" className="button button-quiet button-small" onClick={closeDetail} disabled={Boolean(busyAction)}>Close</button></header>
        {detailLoading ? <div className="ai-knowledge-loading" role="status">Loading details and source evidence…</div>
          : detailError && !detail ? <div className="ai-knowledge-error" role="alert"><p>{detailError}</p><button className="button button-secondary button-small" type="button" onClick={() => setRefreshKey((value) => value + 1)}>Retry</button></div>
            : detail && activeRecord && fields && <>
              <div className="ai-knowledge-detail-scroll">
                <div className="ai-knowledge-detail-meta"><span className={`ai-knowledge-status is-${activeRecord.status}`}>{activeRecord.status === 'verified' ? 'Approved' : activeRecord.status === 'pending' ? 'Pending' : activeRecord.status === 'stale' ? 'Stale' : 'Rejected'}</span><span>Topic: <code>{activeRecord.topic_id}</code></span><span>Category: {activeRecord.feature_category}</span></div>
                <p className="ai-knowledge-version">Source version: <code>{activeRecord.knowledge_version}</code>{detail.knowledge_version !== activeRecord.knowledge_version && <> · Current version: <code>{detail.knowledge_version}</code></>}</p>
                {activeRecord.status === 'stale' && <p className="ai-knowledge-stale-note">Supporting source evidence changed. This entry is excluded from AI Help until it is reviewed against current evidence.</p>}
                {editing ? <div className="ai-knowledge-edit-form">
                  <label>Topic title<input value={fields.title} onChange={(event) => updateField('title', event.target.value)} maxLength={120} /></label>
                  <label>Explanation<textarea value={fields.explanation} onChange={(event) => updateField('explanation', event.target.value)} rows={5} maxLength={1200} /></label>
                  <label>Additional detail<textarea value={fields.detailed_explanation ?? ''} onChange={(event) => updateField('detailed_explanation', event.target.value || null)} rows={4} maxLength={2400} /></label>
                  <label>Feature category<select value={fields.feature_category} onChange={(event) => updateField('feature_category', event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
                  <p>Source references stay attached and are checked against current indexed evidence when saved.</p>
                </div> : <>
                  <section className="ai-knowledge-detail-section"><h3>Proposed explanation</h3><p>{activeRecord.explanation}</p>{activeRecord.detailed_explanation && <p>{activeRecord.detailed_explanation}</p>}</section>
                  <section className="ai-knowledge-detail-section"><h3>Supporting sources</h3><ul>{activeRecord.source_refs.map((ref) => <li key={ref}><code>{ref}</code><small>Fingerprint: {activeRecord.source_fingerprints?.[ref]?.slice(0, 16) ?? 'Not available'}…</small></li>)}</ul>{detail.current_evidence ? <details className="ai-knowledge-evidence"><summary>Current source excerpts</summary><pre>{detail.current_evidence}</pre></details> : <p className="ai-knowledge-muted">Current source excerpts are unavailable for these references.</p>}</section>
                  {selectedCandidate?.possible_duplicates?.length ? <section className="ai-knowledge-detail-section"><h3>Related verified topics</h3><ul>{selectedCandidate.possible_duplicates.map((duplicate) => <li key={duplicate.topic_id}>{duplicate.title} <span className={`ai-knowledge-status is-${duplicate.status}`}>{duplicate.status === 'verified' ? 'Approved' : 'Stale'}</span></li>)}</ul></section> : null}
                  <section className="ai-knowledge-detail-section"><h3>Review history</h3>{detail.review_history.length ? <ol className="ai-knowledge-history">{detail.review_history.map((event, index) => <li key={`${event.created_at}-${index}`}><strong>{event.action.replaceAll('_', ' ')}</strong><span>{event.previous_status ?? '—'} → {event.next_status ?? '—'}</span><small>{displayDate(event.created_at)} · {event.reviewer_id ? `Maintainer ${event.reviewer_id.slice(0, 8)}` : 'System'}</small>{typeof event.metadata?.reason === 'string' && <small>Reason: {event.metadata.reason}</small>}</li>)}</ol> : <p className="ai-knowledge-muted">No review history is available.</p>}{selectedCandidate?.status === 'rejected' && <p className="ai-knowledge-muted">The review API does not store a rejection reason.</p>}</section>
                </>}
              </div>
              {detailError && <p className="ai-knowledge-inline-error" role="alert">{detailError}</p>}
              <footer className="ai-knowledge-actions">
                {(selectedCandidate?.status === 'pending' || selectedCandidate?.status === 'stale') && (editing ? <><button className="button button-primary button-small" type="button" disabled={Boolean(busyAction)} onClick={() => void performReview('edit')}>{busyAction === 'edit' ? 'Saving…' : 'Save edits'}</button><button className="button button-secondary button-small" type="button" disabled={Boolean(busyAction)} onClick={() => { setEditing(false); setDetailError('') }}>Cancel edit</button></> : <><button className="button button-secondary button-small" type="button" disabled={Boolean(busyAction)} onClick={() => setEditing(true)}>Edit</button><button className="button button-secondary button-small" type="button" disabled={Boolean(busyAction)} onClick={() => void performReview('defer')}>{busyAction === 'defer' ? 'Saving…' : 'Defer'}</button><button className="button button-destructive button-small" type="button" disabled={Boolean(busyAction)} onClick={() => void performReview('reject')}>{busyAction === 'reject' ? 'Rejecting…' : 'Reject'}</button>{confirmApproval && <span className="ai-knowledge-confirm-copy">Approve this current, source-checked explanation?</span>}<button className="button button-primary button-small" type="button" disabled={Boolean(busyAction)} onClick={() => void performReview('approve')}>{busyAction === 'approve' ? 'Approving…' : confirmApproval ? 'Confirm approval' : 'Approve'}</button></>)}
                {selectedTopic?.status === 'stale' && <><span className="ai-knowledge-confirm-copy">Re-review queues a new pending candidate; approval is still required.</span><button className="button button-primary button-small" type="button" disabled={Boolean(busyAction)} onClick={() => void queueRevalidation()}>{busyAction === 'revalidate' ? 'Queueing…' : 'Queue for re-review'}</button></>}
                {selectedTopic?.status === 'verified' && <><span className="ai-knowledge-confirm-copy">If this approved explanation is outdated or incorrect, mark it stale. It will stop appearing in answers and remain in review history.</span><label className="ai-knowledge-invalidate-reason">Reason for review<textarea value={invalidationReason} onChange={(event) => setInvalidationReason(event.target.value.slice(0, 300))} maxLength={300} rows={2} placeholder="Briefly describe the conflicting or outdated fact." /></label><button className="button button-destructive button-small" type="button" disabled={Boolean(busyAction) || invalidationReason.trim().length < 8} onClick={() => void invalidateTopic()}>{busyAction === 'invalidate' ? 'Marking stale…' : 'Mark as stale'}</button></>}
              </footer>
            </>}
      </section>
    </div>}
  </section>
}

export function AIKnowledgePage() {
  const access = useOutletContext<MaintainerAccess>()
  const { status: authStatus, signOut } = useAuth()
  const navigate = useNavigate()
  const signOutStarted = useRef(false)

  useEffect(() => {
    if (access.status === 'expired' && authStatus === 'signed-in' && !signOutStarted.current) {
      signOutStarted.current = true
      void signOut().finally(() => navigate('/auth', { replace: true }))
    }
  }, [access.status, authStatus, signOut, navigate])

  if (authStatus === 'loading' || access.status === 'checking' || access.status === 'expired') return <div className="ai-knowledge-route-state" role="status">Checking maintainer access…</div>
  if (authStatus !== 'signed-in') return <Navigate to="/auth" replace />
  if (access.status === 'denied' || access.status === 'signed-out') return <section className="ai-knowledge-route-state" role="alert"><h1>Access denied</h1><p>This account is not authorized to manage AI Help knowledge.</p><button className="button button-secondary button-small" onClick={() => navigate('/')} type="button">Return to ProgressTracker</button></section>
  if (access.status === 'error') return <section className="ai-knowledge-route-state" role="alert"><h1>Access check unavailable</h1><p>{access.message ?? 'Maintainer access could not be checked.'}</p><button className="button button-secondary button-small" onClick={access.refresh} type="button">Try again</button></section>
  return <KnowledgeWorkspace />
}
