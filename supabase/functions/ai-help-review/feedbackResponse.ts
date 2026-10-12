export function buildAnswerFeedbackListPayload<T>(input: {
  knowledgeVersion: string
  feedback: T[]
  pendingCount: number | null
  reviewedCount: number | null
  resolvedCount: number | null
  limit: number
  offset: number
}) {
  return {
    current_knowledge_version: input.knowledgeVersion,
    feedback: input.feedback,
    counts: {
      pending: input.pendingCount ?? 0,
      reviewed: input.reviewedCount ?? 0,
      resolved: input.resolvedCount ?? 0,
    },
    page: { limit: input.limit, offset: input.offset, has_more: input.feedback.length === input.limit },
  }
}
