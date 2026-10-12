export function buildAnswerFeedbackListPayload<T>(input: {
  knowledgeVersion: string
  candidateSourceRefs: string[]
  feedback: T[]
  pendingCount: number | null
  reviewedCount: number | null
  resolvedCount: number | null
  limit: number
  offset: number
}) {
  return {
    current_knowledge_version: input.knowledgeVersion,
    candidate_source_refs: input.candidateSourceRefs,
    feedback: input.feedback,
    counts: {
      pending: input.pendingCount ?? 0,
      reviewed: input.reviewedCount ?? 0,
      resolved: input.resolvedCount ?? 0,
    },
    page: { limit: input.limit, offset: input.offset, has_more: input.feedback.length === input.limit },
  }
}

export type AnswerFeedbackIdentity = { display_name: string | null; email: string | null }

/** Explicit maintainer DTO: internal account keys never leave this mapper. */
export function buildMaintainerAnswerFeedback(input: {
  row: {
    id: string
    user_id: string
    response_id: string
    category: string
    explanation: string | null
    topic: string
    knowledge_version: string
    status: string
    created_at: string
    reviewed_at: string | null
    share_identity: boolean
    knowledge_decision: string
    knowledge_candidate_id: string | null
    reviewer_id?: string | null
    share_email?: boolean
  }
  identity: AnswerFeedbackIdentity | null
  currentPreference: boolean
  candidate?: { id: string; title: string; status: string } | null
}) {
  const { row, identity } = input
  const discloseIdentity = row.share_identity && input.currentPreference
  return {
    id: row.id,
    category: row.category,
    explanation: row.explanation,
    topic: row.topic,
    knowledge_version: row.knowledge_version,
    status: row.status,
    knowledge_decision: row.knowledge_decision,
    candidate: input.candidate ?? null,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    identity: discloseIdentity ? identity ?? { display_name: null, email: null } : null,
    ...(discloseIdentity ? { response_id: row.response_id } : {}),
  }
}
