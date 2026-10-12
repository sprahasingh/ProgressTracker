import { createClient } from 'npm:@supabase/supabase-js@2'
import { evidenceFingerprints, sourcePaths, sourceVersion } from '../ai-help/_generated/sourceBundle.ts'
import { sourceIndex } from '../ai-help/_generated/sourceIndex.ts'
import { candidateHasEvidenceOverlap, createKnowledgeFingerprint, isMaintainer, normalizeMaintainerEmails, validateReviewEdits } from '../ai-help/learningCore.ts'

const ORIGINS = new Set((Deno.env.get('AI_HELP_REVIEW_ALLOWED_ORIGINS') ?? Deno.env.get('AI_HELP_ALLOWED_ORIGINS') ?? '').split(',').map((item) => {
  try { return new URL(item.trim()).origin } catch { return '' }
}).filter(Boolean))
const MAX_REVIEW_BODY_BYTES = 16 * 1024

async function readReviewBody(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_REVIEW_BODY_BYTES) throw new RangeError('oversized')
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_REVIEW_BODY_BYTES) {
      await reader.cancel()
      throw new RangeError('oversized')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function json(status: number, body: Record<string, unknown>, origin = '') {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  } })
}

function currentEvidence(paths: string[]) {
  const unique = [...new Set(paths)]
  if (unique.some((path) => !sourcePaths.includes(path as never))) throw new Error('One or more source references are no longer available.')
  let remaining = 9000
  return unique.flatMap((path) => sourceIndex.filter((entry) => entry.path === path).slice(0, 2).map((entry) => {
    const content = `SOURCE ${entry.path} · ${entry.kind} · ${entry.symbol} · lines ${entry.startLine}-${entry.endLine}\n${entry.content}`.slice(0, remaining)
    remaining -= content.length
    return content
  })).filter(Boolean).join('\n\n')
}

async function safeMetric(admin: ReturnType<typeof createClient>, event: string) {
  try { await admin.rpc('record_ai_help_metric', { p_event: event, p_feature_category: 'other' }) } catch { /* Do not expose metric storage errors. */ }
}

Deno.serve(async (request) => {
  const originHeader = request.headers.get('origin')
  let origin = ''
  try { origin = originHeader ? new URL(originHeader).origin : '' } catch { /* Reject invalid origins below. */ }
  if (originHeader && (!origin || !ORIGINS.has(origin))) return new Response('Forbidden', { status: 403, headers: { Vary: 'Origin' } })
  if (request.method === 'OPTIONS') {
    if (!origin || !ORIGINS.has(origin)) return new Response('Forbidden', { status: 403, headers: { Vary: 'Origin' } })
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Max-Age': '3600', Vary: 'Origin',
    } })
  }
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' }, origin)
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json(415, { error: 'Content-Type must be application/json.' }, origin)

  try {
    let raw: string
    try { raw = await readReviewBody(request) } catch (error) {
      if (error instanceof RangeError) return json(413, { error: 'Review request is too large.' }, origin)
      throw error
    }
    let body: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      body = value as Record<string, unknown>
    } catch { return json(400, { error: 'Invalid review request.' }, origin) }

    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    const url = Deno.env.get('SUPABASE_URL')
    const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!token || !url || !publishableKey || !serviceRoleKey) return json(401, { error: 'Maintainer sign-in is required.' }, origin)

    const verifier = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await verifier.auth.getUser(token)
    const user = data.user
    if (error || !user?.email || !user.email_confirmed_at || !isMaintainer(user.email, normalizeMaintainerEmails(Deno.env.get('AI_HELP_MAINTAINER_EMAILS')))) {
      return json(403, { error: 'This account is not authorized to review AI Help knowledge.' }, origin)
    }
    if (body.action === 'whoami') return json(200, { authorized: true }, origin)

    const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    if (body.action === 'feedback_list') {
      const allowedStatuses = ['pending', 'reviewed', 'resolved']
      const status = typeof body.status === 'string' ? body.status : 'pending'
      const categories = ['helpful', 'factually_incorrect', 'outdated', 'wrong_instructions', 'wrong_contact', 'other']
      const category = typeof body.category === 'string' ? body.category : 'all'
      if (status !== 'all' && !allowedStatuses.includes(status)) return json(400, { error: 'Unsupported feedback status.' }, origin)
      if (category !== 'all' && !categories.includes(category)) return json(400, { error: 'Unsupported feedback category.' }, origin)
      const limit = typeof body.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(body.limit))) : 50
      const offset = typeof body.offset === 'number' ? Math.max(0, Math.min(10000, Math.floor(body.offset))) : 0
      try { await admin.from('ai_help_answer_feedback').delete().lte('expires_at', new Date().toISOString()) } catch { /* Feedback remains reviewable if retention cleanup is temporarily unavailable. */ }
      let query = admin.from('ai_help_answer_feedback')
        .select('id,user_id,response_id,category,explanation,topic,knowledge_version,status,created_at,reviewed_at,reviewer_id')
      if (status !== 'all') query = query.eq('status', status)
      if (category !== 'all') query = query.eq('category', category)
      query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1)
      const [rows, pending, reviewed, resolved] = await Promise.all([
        query,
        admin.from('ai_help_answer_feedback').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        admin.from('ai_help_answer_feedback').select('id', { count: 'exact', head: true }).eq('status', 'reviewed'),
        admin.from('ai_help_answer_feedback').select('id', { count: 'exact', head: true }).eq('status', 'resolved'),
      ])
      if (rows.error || pending.error || reviewed.error || resolved.error) return json(503, { error: 'Answer feedback is temporarily unavailable.' }, origin)
      return json(200, { current_knowledge_version: knowledgeVersion, feedback: rows.data ?? [], counts: { pending: pending.count ?? 0, reviewed: reviewed.count ?? 0, resolved: resolved.count ?? 0 }, page: { limit, offset, has_more: (rows.data?.length ?? 0) === limit } }, origin)
    }

    if (body.action === 'feedback_review') {
      if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id) || (body.status !== 'reviewed' && body.status !== 'resolved')) return json(400, { error: 'Choose a feedback report and review status.' }, origin)
      const { error: updateError } = await admin.rpc('review_unified_ai_answer_feedback', { p_legacy_id: body.id, p_status: body.status, p_reviewer_id: user.id })
      if (updateError) return json(updateError.code === 'P0002' ? 404 : updateError.code === '40001' ? 409 : 503, { error: updateError.code === 'P0002' ? 'Feedback report not found.' : updateError.code === '40001' ? 'Feedback report changed. Refresh and retry.' : 'The feedback status could not be updated. Try again.' }, origin)
      const { data, error: readError } = await admin.from('ai_help_answer_feedback')
        .select('id,user_id,response_id,category,explanation,topic,knowledge_version,status,created_at,reviewed_at,reviewer_id').eq('id', body.id).maybeSingle()
      if (readError || !data) return json(503, { error: 'The feedback report was saved, but its latest status could not be loaded.' }, origin)
      return json(200, { feedback: data }, origin)
    }

    const { error: freshnessError } = await admin.rpc('reconcile_ai_knowledge', { p_current_fingerprints: evidenceFingerprints, p_knowledge_version: sourceVersion })
    if (freshnessError) return json(503, { error: 'Knowledge freshness could not be checked. Try again later.' }, origin)

    if (body.action === 'invalidate') {
      if (typeof body.topic_id !== 'string' || typeof body.expected_reviewed_at !== 'string' || typeof body.reason !== 'string' || body.reason.trim().length < 8 || body.reason.trim().length > 300) {
        return json(400, { error: 'Select an approved topic and provide a short reason for marking it stale.' }, origin)
      }
      const { data: result, error: invalidateError } = await admin.rpc('invalidate_ai_verified_knowledge', {
        p_topic_id: body.topic_id,
        p_reviewer_id: user.id,
        p_expected_reviewed_at: body.expected_reviewed_at,
        p_reason: body.reason.trim(),
      })
      if (invalidateError) return json(invalidateError.code === '40001' ? 409 : invalidateError.code === 'P0002' ? 404 : 400, { error: invalidateError.code === '40001' ? 'This topic changed during review. Refresh and try again.' : invalidateError.code === 'P0002' ? 'Verified topic not found.' : 'The topic could not be marked stale. Check the reason and try again.' }, origin)
      return json(200, { result }, origin)
    }

    if (body.action === 'list') {
      const status = typeof body.status === 'string' ? body.status : 'pending'
      const allowedStatuses = ['pending', 'stale', 'verified', 'rejected']
      if (status !== 'all' && !allowedStatuses.includes(status)) return json(400, { error: 'Unsupported review status.' }, origin)
      const limit = typeof body.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(body.limit))) : 50
      const offset = typeof body.offset === 'number' ? Math.max(0, Math.min(10000, Math.floor(body.offset))) : 0
      const search = typeof body.search === 'string' ? body.search.trim().slice(0, 80).replace(/[,%()\\]/g, ' ').replace(/\s+/g, ' ') : ''
      const sort = body.sort === 'oldest' || body.sort === 'reviewed' ? body.sort : 'newest'
      const ascending = sort === 'oldest'
      const searchFilter = `topic_id.ilike.%${search}%,title.ilike.%${search}%,explanation.ilike.%${search}%`
      // Stale and all views span two tables. Split their page window evenly so
      // the UI can advance using the combined number of rows without skipping
      // the second table's records.
      const combinedStatus = status === 'stale' || status === 'all'
      const tableLimit = combinedStatus ? Math.ceil(limit / 2) : limit
      const tableOffset = combinedStatus ? Math.floor(offset / 2) : offset

      let candidateQuery = admin.from('ai_knowledge_candidates')
        .select('id,topic_id,title,explanation,detailed_explanation,feature_category,source_refs,source_fingerprints,knowledge_version,status,created_at,updated_at,reviewed_at,reviewer_id')
        .not('topic_id', 'is', null)
      if (status === 'all') candidateQuery = candidateQuery.in('status', ['pending', 'stale', 'rejected'])
      else if (status === 'pending' || status === 'stale' || status === 'rejected') candidateQuery = candidateQuery.eq('status', status)
      else candidateQuery = candidateQuery.eq('id', '00000000-0000-0000-0000-000000000000')
      if (search) candidateQuery = candidateQuery.or(searchFilter)
      candidateQuery = candidateQuery.order(sort === 'reviewed' ? 'reviewed_at' : sort === 'oldest' ? 'created_at' : 'updated_at', { ascending, nullsFirst: false })
        .range(tableOffset, tableOffset + tableLimit - 1)

      let verifiedQuery = admin.from('ai_verified_knowledge')
        .select('topic_id,title,explanation,detailed_explanation,feature_category,source_refs,source_fingerprints,knowledge_version,status,reviewed_at,stale_at,reviewer_id')
      if (status === 'verified' || status === 'stale') verifiedQuery = verifiedQuery.eq('status', status)
      else if (status !== 'all') verifiedQuery = verifiedQuery.eq('topic_id', '__no_matching_topic__')
      if (search) verifiedQuery = verifiedQuery.or(searchFilter)
      verifiedQuery = verifiedQuery.order(sort === 'oldest' ? 'reviewed_at' : 'reviewed_at', { ascending, nullsFirst: false })
        .range(tableOffset, tableOffset + tableLimit - 1)

      const [candidateResult, verifiedResult, metricQuery, pendingCount, approvedCount, staleCount, rejectedCount] = await Promise.all([
        candidateQuery,
        verifiedQuery,
        admin.from('ai_help_learning_metrics').select('metric_date,event,feature_category,event_count').order('metric_date', { ascending: false }).limit(300),
        admin.from('ai_knowledge_candidates').select('id', { count: 'exact', head: true }).eq('status', 'pending').not('topic_id', 'is', null),
        admin.from('ai_verified_knowledge').select('id', { count: 'exact', head: true }).eq('status', 'verified'),
        admin.from('ai_verified_knowledge').select('id', { count: 'exact', head: true }).eq('status', 'stale'),
        admin.from('ai_knowledge_candidates').select('id', { count: 'exact', head: true }).eq('status', 'rejected').not('topic_id', 'is', null),
      ])
      const candidateRows = { data: candidateResult.data, error: candidateResult.error }
      const verifiedQueryResult = { data: verifiedResult.data, error: verifiedResult.error }
      if (candidateRows.error || verifiedQueryResult.error || metricQuery.error || pendingCount.error || approvedCount.error || staleCount.error || rejectedCount.error) return json(503, { error: 'Review data is temporarily unavailable.' }, origin)
      const verified = (verifiedQueryResult.data ?? []).map((entry) => {
        const refs = Array.isArray(entry.source_refs) ? entry.source_refs.filter((ref): ref is string => typeof ref === 'string') : []
        const currentRefs = refs.filter((ref) => Boolean(evidenceFingerprints[ref]) && sourcePaths.includes(ref as never))
        return { ...entry, current_evidence: entry.status === 'stale' && currentRefs.length ? currentEvidence(currentRefs) : '' }
      })
      const candidates = (candidateRows.data ?? []).map((candidate) => {
        const refs = Array.isArray(candidate.source_refs) ? candidate.source_refs.filter((ref): ref is string => typeof ref === 'string') : []
        const possibleDuplicates = verified.filter((entry) => entry.topic_id === candidate.topic_id
          || (Array.isArray(entry.source_refs) && refs.some((ref) => entry.source_refs.includes(ref))))
          .slice(0, 3).map((entry) => ({ topic_id: entry.topic_id, title: entry.title, status: entry.status, match: entry.topic_id === candidate.topic_id ? 'same_topic' : 'shared_source' }))
        return { ...candidate, possible_duplicates: possibleDuplicates }
      })
      return json(200, { knowledge_version: sourceVersion, candidates, verified_knowledge: verified, metrics: metricQuery.data ?? [], counts: {
        pending: pendingCount.count ?? 0, approved: approvedCount.count ?? 0, stale: staleCount.count ?? 0, rejected: rejectedCount.count ?? 0,
      }, page: { limit, offset, has_more: (candidateResult.data?.length ?? 0) === tableLimit || (verifiedResult.data?.length ?? 0) === tableLimit } }, origin)
    }

    if (body.action === 'get') {
      if (typeof body.candidate_id === 'string') {
        const { data: candidate, error: candidateError } = await admin.from('ai_knowledge_candidates')
          .select('id,topic_id,title,explanation,detailed_explanation,feature_category,source_refs,source_fingerprints,knowledge_version,status,created_at,updated_at,reviewed_at,reviewer_id')
          .eq('id', body.candidate_id).maybeSingle()
        if (candidateError || !candidate || !candidate.topic_id) return json(404, { error: 'Candidate not found.' }, origin)
        const refs = Array.isArray(candidate.source_refs) ? candidate.source_refs.filter((ref): ref is string => typeof ref === 'string') : []
        const currentRefs = refs.filter((ref) => Boolean(evidenceFingerprints[ref]) && sourcePaths.includes(ref as never))
        const { data: related, error: relatedError } = await admin.from('ai_verified_knowledge').select('topic_id,title,explanation,feature_category,status,source_refs,knowledge_version,reviewed_at,stale_at').or(`topic_id.eq.${candidate.topic_id},status.eq.stale`).order('reviewed_at', { ascending: false }).limit(20)
        const { data: reviewHistory, error: reviewHistoryError } = await admin.from('ai_knowledge_review_events').select('action,previous_status,next_status,reviewer_id,created_at,metadata').eq('candidate_id', candidate.id).order('created_at', { ascending: false }).limit(30)
        if (relatedError || reviewHistoryError) return json(503, { error: 'Review history is temporarily unavailable.' }, origin)
        return json(200, { knowledge_version: sourceVersion, candidate, current_evidence: currentRefs.length ? currentEvidence(currentRefs) : '', comparison: related ?? [], review_history: reviewHistory ?? [] }, origin)
      }
      if (typeof body.topic_id === 'string') {
        const { data: entry, error: entryError } = await admin.from('ai_verified_knowledge').select('topic_id,title,explanation,detailed_explanation,feature_category,source_refs,source_fingerprints,knowledge_version,status,reviewed_at,stale_at,reviewer_id').eq('topic_id', body.topic_id).maybeSingle()
        if (entryError || !entry) return json(404, { error: 'Verified knowledge not found.' }, origin)
        const refs = Array.isArray(entry.source_refs) ? entry.source_refs.filter((ref): ref is string => typeof ref === 'string') : []
        const currentRefs = refs.filter((ref) => Boolean(evidenceFingerprints[ref]) && sourcePaths.includes(ref as never))
        const { data: reviewHistory, error: reviewHistoryError } = await admin.from('ai_knowledge_review_events').select('action,previous_status,next_status,reviewer_id,created_at,metadata').eq('topic_id', entry.topic_id).order('created_at', { ascending: false }).limit(30)
        if (reviewHistoryError) return json(503, { error: 'Review history is temporarily unavailable.' }, origin)
        return json(200, { knowledge_version: sourceVersion, entry, current_evidence: currentRefs.length ? currentEvidence(currentRefs) : '', review_history: reviewHistory ?? [] }, origin)
      }
      return json(400, { error: 'Choose a candidate or verified topic.' }, origin)
    }

    if (body.action === 'revalidate') {
      if (typeof body.topic_id !== 'string') return json(400, { error: 'Choose a stale knowledge topic to revalidate.' }, origin)
      const { data: staleEntry, error: staleError } = await admin.from('ai_verified_knowledge').select('topic_id,status').eq('topic_id', body.topic_id).eq('status', 'stale').maybeSingle()
      if (staleError || !staleEntry) return json(404, { error: 'Stale verified knowledge was not found.' }, origin)
      const paths = Array.isArray(body.source_refs) ? body.source_refs.filter((ref): ref is string => typeof ref === 'string') : []
      if (!paths.length || paths.some((path) => !sourcePaths.includes(path as never))) return json(400, { error: 'Select current indexed source files.' }, origin)
      let evidence: string
      let edits: ReturnType<typeof validateReviewEdits>
      try {
        evidence = currentEvidence(paths)
        edits = validateReviewEdits(body, new Set(sourcePaths), evidenceFingerprints, evidence)
      } catch { return json(400, { error: 'Edit the candidate using current source evidence and valid topic fields.' }, origin) }
      if (edits.topicId !== staleEntry.topic_id) return json(400, { error: 'Revalidation must keep the existing stable topic identifier.' }, origin)
      if (!candidateHasEvidenceOverlap(`${edits.title} ${edits.explanation} ${edits.detailedExplanation ?? ''}`, evidence)) return json(400, { error: 'The edited explanation does not match the selected current source evidence.' }, origin)
      const fingerprint = await createKnowledgeFingerprint(edits)
      const { data: queued, error: queueError } = await admin.rpc('submit_ai_knowledge_candidate', {
        p_topic_id: edits.topicId, p_title: edits.title, p_explanation: edits.explanation,
        p_detailed_explanation: edits.detailedExplanation, p_feature_category: edits.featureCategory,
        p_source_refs: edits.sourceRefs, p_source_fingerprints: Object.fromEntries(edits.sourceRefs.map((ref) => [ref, evidenceFingerprints[ref]])),
        p_knowledge_version: sourceVersion, p_candidate_fingerprint: fingerprint,
      })
      if (queueError) return json(400, { error: 'The revalidation candidate could not be queued.' }, origin)
      return json(200, { result: queued, requires_approval: true }, origin)
    }

    if (!['edit', 'approve', 'reject', 'defer'].includes(String(body.action)) || typeof body.candidate_id !== 'string') {
      return json(400, { error: 'Choose a candidate and a supported review action.' }, origin)
    }
    if (typeof body.expected_updated_at !== 'string') return json(400, { error: 'Refresh the candidate before reviewing it.' }, origin)
    const { data: existing, error: candidateError } = await admin.from('ai_knowledge_candidates')
      .select('id,topic_id,source_refs,updated_at,status').eq('id', body.candidate_id).maybeSingle()
    if (candidateError || !existing) return json(404, { error: 'Candidate not found.' }, origin)

    let edits: ReturnType<typeof validateReviewEdits> | null = null
    let fingerprint: string | null = null
    let fingerprints: Record<string, string> = {}
    if (body.action === 'edit' || body.action === 'approve') {
      const paths = Array.isArray(body.source_refs) ? body.source_refs.filter((ref): ref is string => typeof ref === 'string') : []
      if (!paths.length || paths.some((path) => !sourcePaths.includes(path as never))) return json(400, { error: 'Select current indexed source files.' }, origin)
      let evidence: string
      try {
        evidence = currentEvidence(paths)
        edits = validateReviewEdits(body, new Set(sourcePaths), evidenceFingerprints, evidence)
      } catch { return json(400, { error: 'Edit the candidate using current source evidence and valid topic fields.' }, origin) }
      if (!candidateHasEvidenceOverlap(`${edits.title} ${edits.explanation} ${edits.detailedExplanation ?? ''}`, evidence)) {
        return json(400, { error: 'The edited explanation does not match the selected current source evidence.' }, origin)
      }
      fingerprints = Object.fromEntries(edits.sourceRefs.map((ref) => [ref, evidenceFingerprints[ref]]))
      fingerprint = await createKnowledgeFingerprint(edits)
    }

    const { data: review, error: reviewError } = await admin.rpc('review_ai_knowledge_candidate', {
      p_candidate_id: existing.id,
      p_reviewer_id: user.id,
      p_action: body.action,
      p_expected_updated_at: typeof body.expected_updated_at === 'string' ? body.expected_updated_at : null,
      p_topic_id: edits?.topicId ?? null,
      p_title: edits?.title ?? null,
      p_explanation: edits?.explanation ?? null,
      p_detailed_explanation: edits?.detailedExplanation ?? null,
      p_feature_category: edits?.featureCategory ?? null,
      p_source_refs: edits?.sourceRefs ?? null,
      p_source_fingerprints: edits ? fingerprints : null,
      p_knowledge_version: edits ? sourceVersion : null,
      p_candidate_fingerprint: fingerprint,
    })
    if (reviewError) return json(reviewError.code === '40001' ? 409 : 400, { error: reviewError.code === '40001' ? 'Candidate changed during review. Refresh and retry.' : 'The review could not be saved. Check the candidate fields and try again.' }, origin)
    return json(200, { result: review }, origin)
  } catch {
    return json(500, { error: 'The review request could not be completed.' }, origin)
  }
})
