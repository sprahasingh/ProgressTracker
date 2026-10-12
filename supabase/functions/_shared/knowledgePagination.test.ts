import { describe, expect, it } from 'vitest'
import { mergeKnowledgePage } from './knowledgePagination'

describe('AI Help knowledge list pagination', () => {
  it('merges candidate and verified rows in newest-first order and advances each cursor', () => {
    const result = mergeKnowledgePage({
      candidates: [
        { id: 'candidate-1', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z', reviewed_at: null },
        { id: 'candidate-2', created_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:00:00Z', reviewed_at: null },
      ],
      verified: [
        { topic_id: 'topic.one', reviewed_at: '2026-10-09T00:00:00Z' },
        { topic_id: 'topic.two', reviewed_at: '2026-10-07T00:00:00Z' },
      ],
      limit: 3, candidateOffset: 4, verifiedOffset: 2, sort: 'newest',
    })
    expect(result.candidates.map((row) => row.id)).toEqual(['candidate-1', 'candidate-2'])
    expect(result.verified.map((row) => row.topic_id)).toEqual(['topic.one'])
    expect(result).toMatchObject({ nextCandidateOffset: 6, nextVerifiedOffset: 3, hasMore: true })
  })

  it('handles an empty list without claiming more results', () => {
    expect(mergeKnowledgePage({ candidates: [], verified: [], limit: 50, candidateOffset: 0, verifiedOffset: 0, sort: 'newest' }))
      .toEqual({ candidates: [], verified: [], nextCandidateOffset: 0, nextVerifiedOffset: 0, hasMore: false })
  })
})
