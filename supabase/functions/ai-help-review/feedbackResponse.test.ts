import { describe, expect, it } from 'vitest'
import { buildAnswerFeedbackListPayload } from './feedbackResponse'

describe('AI Help answer feedback response', () => {
  it('returns a versioned empty list with valid counts and paging metadata', () => {
    expect(buildAnswerFeedbackListPayload({
      knowledgeVersion: 'bundle-v2', feedback: [], pendingCount: null, reviewedCount: 0, resolvedCount: 1, limit: 50, offset: 0,
    })).toEqual({
      current_knowledge_version: 'bundle-v2', feedback: [],
      counts: { pending: 0, reviewed: 0, resolved: 1 },
      page: { limit: 50, offset: 0, has_more: false },
    })
  })

  it('sets has_more when the current page is full', () => {
    const feedback = [{ id: 'one' }, { id: 'two' }]
    expect(buildAnswerFeedbackListPayload({
      knowledgeVersion: 'bundle-v2', feedback, pendingCount: 2, reviewedCount: 0, resolvedCount: 0, limit: 2, offset: 4,
    })).toMatchObject({ feedback, page: { limit: 2, offset: 4, has_more: true } })
  })
})
