import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../services/supabase/client'

export type ReviewStatus = 'pending' | 'verified' | 'stale' | 'rejected'
export type ReviewSort = 'newest' | 'oldest' | 'reviewed'
export type KnowledgeCandidate = {
  id: string
  topic_id: string
  title: string
  explanation: string
  detailed_explanation: string | null
  feature_category: string
  source_refs: string[]
  source_fingerprints: Record<string, string>
  knowledge_version: string
  status: ReviewStatus
  created_at: string
  updated_at: string
  reviewed_at: string | null
  reviewer_id: string | null
  possible_duplicates?: Array<{ topic_id: string; title: string; status: 'verified' | 'stale'; match: string }>
}
export type VerifiedTopic = {
  topic_id: string
  title: string
  explanation: string
  detailed_explanation: string | null
  feature_category: string
  source_refs: string[]
  source_fingerprints: Record<string, string>
  knowledge_version: string
  status: 'verified' | 'stale'
  reviewed_at: string
  stale_at: string | null
  reviewer_id: string | null
  current_evidence?: string
}
export type ReviewEvent = {
  action: string
  previous_status: string | null
  next_status: string | null
  reviewer_id: string | null
  created_at: string
  metadata?: Record<string, unknown>
}
export type ReviewCounts = { pending: number; approved: number; stale: number; rejected: number }
export type AnswerFeedbackCategory = 'helpful' | 'factually_incorrect' | 'outdated' | 'wrong_instructions' | 'wrong_contact' | 'other'
export type AnswerFeedbackStatus = 'pending' | 'reviewed' | 'resolved'
export type AnswerFeedbackKnowledgeDecision = 'not_decided' | 'create_candidate' | 'no_knowledge_change'
export type AnswerFeedbackCandidate = { id: string; title: string; status: ReviewStatus }
export type AnswerFeedback = {
  id: string; response_id?: string; category: AnswerFeedbackCategory; explanation: string | null
  topic: string; knowledge_version: string; status: AnswerFeedbackStatus; created_at: string; reviewed_at: string | null
  identity: { display_name: string | null; email: string | null } | null
  knowledge_decision: AnswerFeedbackKnowledgeDecision
  candidate: AnswerFeedbackCandidate | null
}
export type ReviewList = {
  knowledge_version: string
  candidates: KnowledgeCandidate[]
  verified_knowledge: VerifiedTopic[]
  metrics: Array<{ metric_date: string; event: string; feature_category: string; event_count: number }>
  counts: ReviewCounts
  page: { limit: number; offset: number; has_more: boolean; next_candidate_offset?: number; next_verified_offset?: number }
}
export type ReviewDetail = {
  knowledge_version: string
  candidate?: KnowledgeCandidate
  entry?: VerifiedTopic
  current_evidence: string
  comparison?: Array<Pick<VerifiedTopic, 'topic_id' | 'title' | 'explanation' | 'feature_category' | 'status' | 'source_refs' | 'knowledge_version' | 'reviewed_at' | 'stale_at'>>
  review_history: ReviewEvent[]
}

export class ReviewApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message) }
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const isStringArray = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string')
function isKnowledgeRow(value: unknown, kind: 'candidate' | 'verified') {
  if (!isObject(value)) return false
  const common = typeof value.topic_id === 'string' && typeof value.title === 'string' && typeof value.explanation === 'string'
    && (value.detailed_explanation === null || typeof value.detailed_explanation === 'string')
    && typeof value.feature_category === 'string' && isStringArray(value.source_refs)
    && isObject(value.source_fingerprints) && typeof value.knowledge_version === 'string'
  if (!common) return false
  if (kind === 'candidate') return typeof value.id === 'string' && ['pending', 'verified', 'stale', 'rejected'].includes(String(value.status))
    && typeof value.created_at === 'string' && typeof value.updated_at === 'string'
    && (value.reviewed_at === null || typeof value.reviewed_at === 'string')
    && (value.reviewer_id === null || typeof value.reviewer_id === 'string')
  return ['verified', 'stale'].includes(String(value.status)) && typeof value.reviewed_at === 'string'
    && (value.stale_at === null || typeof value.stale_at === 'string')
    && (value.reviewer_id === null || typeof value.reviewer_id === 'string')
}

function recordReviewFailure(action: string, status: number, code: string | undefined, errorName: string) {
  // These fields are operational metadata only: never log request bodies, tokens, or response text.
  console.warn('AI_KNOWLEDGE_REVIEW_REQUEST_FAILED', { action, status, code, errorName })
}

async function invokeReview<T>(action: Record<string, unknown>, suppliedClient?: SupabaseClient): Promise<T> {
  const client = suppliedClient ?? getSupabaseClient()
  if (!client) throw new ReviewApiError(503, 'AI Knowledge is unavailable because the account service is not configured.')
  const { data: sessionData, error: sessionError } = await client.auth.getSession()
  const token = sessionData.session?.access_token
  if (sessionError || !token) throw new ReviewApiError(401, 'Your session has expired. Sign in again.')
  const { data, error } = await client.functions.invoke<T>('ai-help-review', {
    body: action,
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!error) return data as T
  const context = error.context
  let message = ''
  let status = 0
  let code: string | undefined
  if (context instanceof Response) {
    status = context.status
    try {
      const payload = await context.clone().json() as { error?: unknown; code?: unknown }
      if (typeof payload.error === 'string') message = payload.error
      if (typeof payload.code === 'string') code = payload.code
    } catch { /* Use a stable user-facing fallback for empty gateway responses. */ }
  }
  // Supabase wraps fetch failures in FunctionsFetchError, with the underlying
  // TypeError in `context`. Prefer the wrapper name so transport failures do
  // not fall through to the generic request error.
  const errorName = error instanceof Error ? error.name : context instanceof Error ? context.name : ''
  recordReviewFailure(String(action.action ?? 'unknown'), status, code, errorName || 'unknown')
  if (!status && /FunctionsFetchError/.test(errorName)) throw new ReviewApiError(0, 'Could not connect to the AI Knowledge review service. Check your connection and confirm this app origin is allowed for the review function, then retry.', 'network_error')
  if (!status && /FunctionsRelayError/.test(errorName)) throw new ReviewApiError(502, 'The AI Knowledge review service could not complete the request. Retry, and contact support if it continues.', 'relay_error')
  if (!status && /FunctionsHttpError/.test(errorName)) throw new ReviewApiError(502, 'The AI Knowledge review service returned an unreadable response. Retry, and contact support if it continues.', 'http_error')
  if (status === 401) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('progress-tracker:ai-knowledge-session-expired'))
    throw new ReviewApiError(401, 'Your session has expired. Sign in again.', code ?? 'unauthorized')
  }
  if (status === 403) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('progress-tracker:ai-knowledge-access-revoked'))
    throw new ReviewApiError(403, 'This account is not authorized to manage AI Knowledge.', code ?? 'forbidden')
  }
  if (status === 400 && /unsupported.*action|unknown.*action/i.test(message)) {
    throw new ReviewApiError(400, 'This review service version does not support this request. Deploy the compatible ai-help-review function, then retry.', 'incompatible_function_version')
  }
  if (status === 404) throw new ReviewApiError(404, message || 'That knowledge entry could not be found. Refresh the list.')
  if (status === 409) throw new ReviewApiError(409, message || 'This entry changed during review. Refresh it before trying again.')
  if (status === 429) throw new ReviewApiError(429, message || 'The review service is busy. Wait briefly, then retry.')
  if (status >= 500) throw new ReviewApiError(status, code === 'unexpected_backend_failure' ? 'The review service encountered an unexpected backend error. Retry; if it continues, check the Edge Function logs for AI_HELP_REVIEW_UNEXPECTED_FAILURE.' : message || 'The review service is temporarily unavailable. Try again.', code ?? 'backend_error')
  throw new ReviewApiError(status || 0, message || 'The review request could not be completed.', code ?? 'request_failed')
}

export async function checkMaintainerAccess(client?: SupabaseClient): Promise<boolean> {
  const result = await invokeReview<{ authorized: boolean }>({ action: 'whoami' }, client)
  return result.authorized === true
}

export async function listKnowledge(input: { status: ReviewStatus; search?: string; sort?: ReviewSort; limit?: number; offset?: number; candidate_offset?: number; verified_offset?: number }, client?: SupabaseClient) {
  const result = await invokeReview<ReviewList>({ action: 'list', ...input }, client)
  if (!result || typeof result.knowledge_version !== 'string' || !Array.isArray(result.candidates) || !result.candidates.every((row) => isKnowledgeRow(row, 'candidate'))
    || !Array.isArray(result.verified_knowledge) || !result.verified_knowledge.every((row) => isKnowledgeRow(row, 'verified'))
    || !result.counts || !['pending', 'approved', 'stale', 'rejected'].every((key) => Number.isFinite(result.counts[key as keyof ReviewCounts]))
    || !result.page || !Number.isFinite(result.page.limit) || !Number.isFinite(result.page.offset) || typeof result.page.has_more !== 'boolean'
    || (result.page.next_candidate_offset !== undefined && !Number.isFinite(result.page.next_candidate_offset))
    || (result.page.next_verified_offset !== undefined && !Number.isFinite(result.page.next_verified_offset))) {
    recordReviewFailure('list', 502, 'incompatible_response', 'SchemaMismatch')
    throw new ReviewApiError(502, 'The review service returned an incompatible knowledge list. Deploy the matching ai-help-review function and database migrations, then retry.', 'incompatible_response')
  }
  return result
}

export function getCandidate(candidateId: string, client?: SupabaseClient) {
  return invokeReview<ReviewDetail>({ action: 'get', candidate_id: candidateId }, client)
}

export function getVerifiedTopic(topicId: string, client?: SupabaseClient) {
  return invokeReview<ReviewDetail>({ action: 'get', topic_id: topicId }, client)
}

export type CandidateFields = Pick<KnowledgeCandidate, 'topic_id' | 'title' | 'explanation' | 'detailed_explanation' | 'feature_category' | 'source_refs'>

export function reviewCandidate(action: 'approve' | 'reject' | 'defer' | 'edit', candidate: KnowledgeCandidate, fields?: CandidateFields, client?: SupabaseClient) {
  return invokeReview<{ result: unknown }>({
    action,
    candidate_id: candidate.id,
    expected_updated_at: candidate.updated_at,
    ...(fields ?? {}),
  }, client)
}

export function revalidateTopic(topic: VerifiedTopic, client?: SupabaseClient) {
  return invokeReview<{ result: unknown; requires_approval: true }>({
    action: 'revalidate', topic_id: topic.topic_id,
    title: topic.title, explanation: topic.explanation, detailed_explanation: topic.detailed_explanation,
    feature_category: topic.feature_category, source_refs: topic.source_refs,
  }, client)
}

export function listAnswerFeedback(input: { status?: AnswerFeedbackStatus | 'all'; category?: AnswerFeedbackCategory | 'all'; limit?: number; offset?: number }, client?: SupabaseClient) {
  return invokeReview<unknown>({ action: 'feedback_list', ...input }, client).then((value) => {
    const result = value as { current_knowledge_version?: unknown; candidate_source_refs?: unknown; feedback?: unknown; counts?: Record<string, unknown>; page?: { limit?: unknown; offset?: unknown; has_more?: unknown } } | null
    const validCategories = ['helpful', 'factually_incorrect', 'outdated', 'wrong_instructions', 'wrong_contact', 'other']
    const validRows = Array.isArray(result?.feedback) && result.feedback.every((row) => isObject(row)
      && typeof row.id === 'string'
      && validCategories.includes(String(row.category)) && (row.explanation === null || typeof row.explanation === 'string')
      && typeof row.topic === 'string' && typeof row.knowledge_version === 'string'
      && ['pending', 'reviewed', 'resolved'].includes(String(row.status)) && typeof row.created_at === 'string'
      && (row.reviewed_at === null || typeof row.reviewed_at === 'string')
      && ['not_decided', 'create_candidate', 'no_knowledge_change'].includes(String(row.knowledge_decision))
      && (row.candidate === null || (isObject(row.candidate) && typeof row.candidate.id === 'string'
        && typeof row.candidate.title === 'string' && ['pending', 'verified', 'stale', 'rejected'].includes(String(row.candidate.status))))
      && (row.identity === null || (isObject(row.identity)
        && (row.identity.display_name === null || typeof row.identity.display_name === 'string')
        && (row.identity.email === null || typeof row.identity.email === 'string')))
      && (row.response_id === undefined || (typeof row.response_id === 'string' && row.identity !== null))
      && !('user_id' in row) && !('reviewer_id' in row) && !('share_identity' in row) && !('share_email' in row))
    if (!result || typeof result.current_knowledge_version !== 'string' || !isStringArray(result.candidate_source_refs) || !validRows
      || !result.counts || !['pending', 'reviewed', 'resolved'].every((key) => Number.isFinite(result.counts?.[key]))
      || !result.page || !Number.isFinite(result.page.limit) || !Number.isFinite(result.page.offset) || typeof result.page.has_more !== 'boolean') {
      recordReviewFailure('feedback_list', 502, 'incompatible_response', 'SchemaMismatch')
      throw new ReviewApiError(502, 'The review service returned an incompatible answer feedback list. Deploy the latest ai-help-review function, then retry.', 'incompatible_response')
    }
    return result as { current_knowledge_version: string; candidate_source_refs: string[]; feedback: AnswerFeedback[]; counts: Record<AnswerFeedbackStatus, number>; page: { limit: number; offset: number; has_more: boolean } }
  })
}

export function reviewAnswerFeedback(id: string, status: AnswerFeedbackStatus, client?: SupabaseClient) {
  return invokeReview<{ feedback: Pick<AnswerFeedback, 'id' | 'status' | 'reviewed_at'> }>({ action: 'feedback_review', id, status }, client)
}

export function setAnswerFeedbackKnowledgeDecision(id: string, decision: AnswerFeedbackKnowledgeDecision, client?: SupabaseClient) {
  return invokeReview<{ feedback: { id: string; status: AnswerFeedbackStatus; knowledge_decision: AnswerFeedbackKnowledgeDecision; knowledge_candidate_id: string | null } }>(
    { action: 'feedback_decision', id, decision }, client,
  )
}

export function createAnswerFeedbackCandidate(id: string, fields: CandidateFields, client?: SupabaseClient) {
  return invokeReview<{ candidate_id: string; created: boolean; duplicate: boolean }>(
    { action: 'feedback_candidate_create', id, ...fields }, client,
  )
}

export function invalidateVerifiedTopic(topic: VerifiedTopic, reason: string, client?: SupabaseClient) {
  return invokeReview<{ result: unknown }>({ action: 'invalidate', topic_id: topic.topic_id, expected_reviewed_at: topic.reviewed_at, reason }, client)
}
