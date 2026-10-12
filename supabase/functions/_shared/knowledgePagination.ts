export type KnowledgePageSort = 'newest' | 'oldest' | 'reviewed'

type CandidatePageRow = { id: string; created_at: string; updated_at: string; reviewed_at: string | null }
type VerifiedPageRow = { topic_id: string; reviewed_at: string }
type KnowledgePageItem = { kind: 'candidate'; value: CandidatePageRow } | { kind: 'topic'; value: VerifiedPageRow }

function pageDate(item: KnowledgePageItem, sort: KnowledgePageSort): string | null {
  if (sort === 'reviewed' && item.kind === 'candidate') return item.value.reviewed_at
  return item.kind === 'topic' ? item.value.reviewed_at : item.value.created_at
}

function pageKey(item: KnowledgePageItem) {
  return item.kind === 'candidate' ? `candidate:${item.value.id}` : `topic:${item.value.topic_id}`
}

function compareItems(left: KnowledgePageItem, right: KnowledgePageItem, sort: KnowledgePageSort) {
  const leftDate = pageDate(left, sort)
  const rightDate = pageDate(right, sort)
  if (sort === 'reviewed' && (leftDate === null || rightDate === null)) {
    if (leftDate === null && rightDate !== null) return 1
    if (rightDate === null && leftDate !== null) return -1
  }
  const leftTime = leftDate ? Date.parse(leftDate) : 0
  const rightTime = rightDate ? Date.parse(rightDate) : 0
  const direction = sort === 'oldest' ? 1 : -1
  return direction * (leftTime - rightTime) || pageKey(left).localeCompare(pageKey(right))
}

/** Merge two bounded source queries into one globally ordered page without skipping either source. */
export function mergeKnowledgePage<C extends CandidatePageRow, V extends VerifiedPageRow>(input: {
  candidates: C[]
  verified: V[]
  limit: number
  candidateOffset: number
  verifiedOffset: number
  sort: KnowledgePageSort
}) {
  const merged: KnowledgePageItem[] = [
    ...input.candidates.map((value) => ({ kind: 'candidate' as const, value })),
    ...input.verified.map((value) => ({ kind: 'topic' as const, value })),
  ].sort((left, right) => compareItems(left, right, input.sort))
  const selected = merged.slice(0, input.limit)
  const candidates = selected.filter((item): item is { kind: 'candidate'; value: C } => item.kind === 'candidate').map((item) => item.value)
  const verified = selected.filter((item): item is { kind: 'topic'; value: V } => item.kind === 'topic').map((item) => item.value)
  return {
    candidates,
    verified,
    nextCandidateOffset: input.candidateOffset + candidates.length,
    nextVerifiedOffset: input.verifiedOffset + verified.length,
    hasMore: input.candidates.length > candidates.length || input.verified.length > verified.length,
  }
}
