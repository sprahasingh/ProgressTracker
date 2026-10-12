import { describe, expect, it } from 'vitest'
import { mergeKnowledgePage } from '../../../supabase/functions/_shared/knowledgePagination'

describe('knowledge review pagination', () => {
  it('advances an imbalanced candidate-only stream without repeating or stalling', () => {
    const candidates = Array.from({ length: 9 }, (_, index) => ({
      id: `candidate-${index}`, created_at: `2026-10-${String(9 - index).padStart(2, '0')}T00:00:00.000Z`,
      updated_at: `2026-10-${String(9 - index).padStart(2, '0')}T00:00:00.000Z`, reviewed_at: null,
    }))
    const first = mergeKnowledgePage({ candidates: candidates.slice(0, 3), verified: [], limit: 2, candidateOffset: 0, verifiedOffset: 0, sort: 'newest' })
    expect(first.candidates.map((row) => row.id)).toEqual(['candidate-0', 'candidate-1'])
    expect(first.nextCandidateOffset).toBe(2)
    expect(first.nextVerifiedOffset).toBe(0)
    expect(first.hasMore).toBe(true)
    const second = mergeKnowledgePage({ candidates: candidates.slice(first.nextCandidateOffset, first.nextCandidateOffset + 3), verified: [], limit: 2, candidateOffset: first.nextCandidateOffset, verifiedOffset: first.nextVerifiedOffset, sort: 'newest' })
    expect(second.candidates.map((row) => row.id)).toEqual(['candidate-2', 'candidate-3'])
    expect(second.nextCandidateOffset).toBe(4)
  })

  it('merges two sources by display order and advances only consumed source cursors', () => {
    const candidates = [
      { id: 'candidate-new', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z', reviewed_at: null },
      { id: 'candidate-old', created_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:00:00Z', reviewed_at: null },
    ]
    const verified = [
      { topic_id: 'topic-middle', reviewed_at: '2026-10-09T00:00:00Z' },
      { topic_id: 'topic-old', reviewed_at: '2026-10-07T00:00:00Z' },
    ]
    const first = mergeKnowledgePage({ candidates, verified, limit: 2, candidateOffset: 0, verifiedOffset: 0, sort: 'newest' })
    expect(first.candidates.map((row) => row.id)).toEqual(['candidate-new'])
    expect(first.verified.map((row) => row.topic_id)).toEqual(['topic-middle'])
    expect(first.nextCandidateOffset).toBe(1)
    expect(first.nextVerifiedOffset).toBe(1)
    const second = mergeKnowledgePage({ candidates: candidates.slice(1), verified: verified.slice(1), limit: 2, candidateOffset: 1, verifiedOffset: 1, sort: 'newest' })
    expect(second.candidates.map((row) => row.id)).toEqual(['candidate-old'])
    expect(second.verified.map((row) => row.topic_id)).toEqual(['topic-old'])
    expect(second.hasMore).toBe(false)
  })
})
