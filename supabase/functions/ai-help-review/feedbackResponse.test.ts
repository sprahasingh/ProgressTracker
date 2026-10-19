import { describe, expect, it } from 'vitest'
import { buildAnswerFeedbackListPayload, buildMaintainerAnswerFeedback } from './feedbackResponse'

describe('AI Help answer feedback response', () => {
  it('returns a versioned empty list with valid counts and paging metadata', () => {
    expect(buildAnswerFeedbackListPayload({
      knowledgeVersion: 'bundle-v2', candidateSourceRefs: ['src/app/AppShell.tsx'], feedback: [], pendingCount: null, reviewedCount: 0, resolvedCount: 1, limit: 50, offset: 0,
    })).toEqual({
      current_knowledge_version: 'bundle-v2', candidate_source_refs: ['src/app/AppShell.tsx'], feedback: [],
      counts: { pending: 0, reviewed: 0, resolved: 1 },
      page: { limit: 50, offset: 0, has_more: false },
    })
  })

  it('sets has_more when the current page is full', () => {
    const feedback = [{ id: 'one' }, { id: 'two' }]
    expect(buildAnswerFeedbackListPayload({
      knowledgeVersion: 'bundle-v2', candidateSourceRefs: [], feedback, pendingCount: 2, reviewedCount: 0, resolvedCount: 0, limit: 2, offset: 4,
    })).toMatchObject({ feedback, page: { limit: 2, offset: 4, has_more: true } })
  })

  it('strips account and response identifiers from anonymous maintainer DTOs', () => {
    const row = {
      id: 'feedback-1', user_id: 'account-secret', response_id: 'response-secret', category: 'outdated',
      explanation: 'The instructions have changed.', topic: 'settings', knowledge_version: 'bundle-1',
      status: 'pending', created_at: '2026-10-12T00:00:00Z', reviewed_at: null, share_identity: false,
      reviewer_id: 'maintainer-secret', share_email: true, knowledge_decision: 'not_decided', knowledge_candidate_id: null,
    }
    const dto = buildMaintainerAnswerFeedback({ row, identity: { display_name: 'Should be ignored', email: 'private@example.com' } })
    expect(dto).toEqual({
      id: 'feedback-1', category: 'outdated', explanation: 'The instructions have changed.', topic: 'settings',
      knowledge_version: 'bundle-1', status: 'pending', created_at: row.created_at, reviewed_at: null, identity: null,
      knowledge_decision: 'not_decided', candidate: null,
    })
    expect(dto).not.toHaveProperty('user_id')
    expect(dto).not.toHaveProperty('response_id')
    expect(dto).not.toHaveProperty('reviewer_id')
  })

  it('returns only consented profile fields for opted-in reports', () => {
    const row = {
      id: 'feedback-1', user_id: 'account-secret', response_id: 'response-1', category: 'outdated',
      explanation: null, topic: 'settings', knowledge_version: 'bundle-1', status: 'pending',
      created_at: '2026-10-12T00:00:00Z', reviewed_at: null, share_identity: true,
      knowledge_decision: 'create_candidate', knowledge_candidate_id: 'candidate-1',
    }
    expect(buildMaintainerAnswerFeedback({ row, currentPreference: true, identity: { display_name: 'Ada User', email: 'ada@example.com' }, candidate: { id: 'candidate-1', title: 'Settings answer guidance', status: 'pending' } })).toMatchObject({
      identity: { display_name: 'Ada User', email: 'ada@example.com' }, response_id: 'response-1',
      knowledge_decision: 'create_candidate', candidate: { id: 'candidate-1', status: 'pending' },
    })
    expect(buildMaintainerAnswerFeedback({ row, currentPreference: true, identity: null }).identity).toEqual({ display_name: null, email: null })
    expect(buildMaintainerAnswerFeedback({ row, currentPreference: true, identity: { display_name: 'Ada', email: null } }).identity)
      .toEqual({ display_name: 'Ada', email: null })
    expect(buildMaintainerAnswerFeedback({ row, currentPreference: true, identity: { display_name: null, email: 'confirmed-address' } }).identity)
      .toEqual({ display_name: null, email: 'confirmed-address' })
  })

  it('withdraws disclosure when the current account preference is off or missing', () => {
    const row = {
      id: 'feedback-1', user_id: 'account-secret', response_id: 'response-secret', category: 'outdated',
      explanation: null, topic: 'settings', knowledge_version: 'bundle-1', status: 'pending',
      created_at: '2026-10-12T00:00:00Z', reviewed_at: null, share_identity: true,
      knowledge_decision: 'not_decided', knowledge_candidate_id: null,
    }
    for (const currentPreference of [false, undefined]) {
      const dto = buildMaintainerAnswerFeedback({ row, identity: { display_name: 'Ada', email: 'ada@example.com' }, currentPreference: currentPreference === true })
      expect(dto.identity).toBeNull()
      expect(dto).not.toHaveProperty('response_id')
    }
  })

  it('keeps historical anonymous submissions anonymous after a later opt-in', () => {
    const row = {
      id: 'feedback-old', user_id: 'account-secret', response_id: 'response-secret', category: 'outdated',
      explanation: null, topic: 'settings', knowledge_version: 'bundle-1', status: 'pending',
      created_at: '2026-10-12T00:00:00Z', reviewed_at: null, share_identity: false,
      knowledge_decision: 'not_decided', knowledge_candidate_id: null,
    }
    const dto = buildMaintainerAnswerFeedback({ row, currentPreference: true, identity: { display_name: 'Ada', email: 'confirmed-address' } })
    expect(dto.identity).toBeNull()
    expect(dto).not.toHaveProperty('response_id')
  })
})
