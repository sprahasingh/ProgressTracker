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
}
export type ReviewCounts = { pending: number; approved: number; stale: number; rejected: number }
export type ReviewList = {
  knowledge_version: string
  candidates: KnowledgeCandidate[]
  verified_knowledge: VerifiedTopic[]
  metrics: Array<{ metric_date: string; event: string; feature_category: string; event_count: number }>
  counts: ReviewCounts
  page: { limit: number; offset: number; has_more: boolean }
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
  constructor(readonly status: number, message: string) { super(message) }
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
  if (context instanceof Response) {
    status = context.status
    try {
      const payload = await context.clone().json() as { error?: unknown }
      if (typeof payload.error === 'string') message = payload.error
    } catch { /* Use a stable user-facing fallback for empty gateway responses. */ }
  }
  if (status === 401) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('progress-tracker:ai-knowledge-session-expired'))
    throw new ReviewApiError(401, 'Your session has expired. Sign in again.')
  }
  if (status === 403) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('progress-tracker:ai-knowledge-access-revoked'))
    throw new ReviewApiError(403, 'This account is not authorized to manage AI Knowledge.')
  }
  if (status === 404) throw new ReviewApiError(404, message || 'That knowledge entry could not be found. Refresh the list.')
  if (status === 409) throw new ReviewApiError(409, message || 'This entry changed during review. Refresh it before trying again.')
  if (status === 429) throw new ReviewApiError(429, message || 'The review service is busy. Wait briefly, then retry.')
  if (status >= 500) throw new ReviewApiError(status, message || 'The review service is temporarily unavailable. Try again.')
  throw new ReviewApiError(status || 0, message || 'The review request could not be completed.')
}

export async function checkMaintainerAccess(client?: SupabaseClient): Promise<boolean> {
  const result = await invokeReview<{ authorized: boolean }>({ action: 'whoami' }, client)
  return result.authorized === true
}

export function listKnowledge(input: { status: ReviewStatus; search?: string; sort?: ReviewSort; limit?: number; offset?: number }, client?: SupabaseClient) {
  return invokeReview<ReviewList>({ action: 'list', ...input }, client)
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
