import { describe, expect, it, vi } from 'vitest'
import { checkMaintainerAccess, createAnswerFeedbackCandidate, invalidateVerifiedTopic, listAnswerFeedback, listKnowledge, reviewAnswerFeedback, ReviewApiError, setAnswerFeedbackKnowledgeDecision } from './aiKnowledgeApi'
import { buildAnswerFeedbackListPayload, buildMaintainerAnswerFeedback } from '../../../supabase/functions/ai-help-review/feedbackResponse.ts'

function clientFor({ token = 'session-token', result = { data: { authorized: true }, error: null } }: { token?: string; result?: { data: unknown; error: unknown } } = {}) {
  const invoke = vi.fn().mockResolvedValue(result)
  const client = {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: token } }, error: null }) },
    functions: { invoke },
  }
  return { client: client as never, invoke, auth: client.auth }
}

describe('AI Knowledge review API client', () => {
  it('checks maintainer access through the authenticated server endpoint', async () => {
    const { client, invoke, auth } = clientFor()
    await expect(checkMaintainerAccess(client)).resolves.toBe(true)
    expect(auth.getSession).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('ai-help-review', {
      body: { action: 'whoami' }, headers: { Authorization: 'Bearer session-token' },
    })
  })

  it('sends bounded list options without storing review credentials', async () => {
    const { client, invoke } = clientFor({ result: { data: { knowledge_version: 'v1', candidates: [], verified_knowledge: [], metrics: [], counts: { pending: 0, approved: 0, stale: 0, rejected: 0 }, page: { limit: 50, offset: 0, has_more: false } }, error: null } })
    await listKnowledge({ status: 'pending', search: 'habit', sort: 'newest', limit: 50, offset: 0 }, client)
    expect(invoke).toHaveBeenCalledWith('ai-help-review', expect.objectContaining({
      body: { action: 'list', status: 'pending', search: 'habit', sort: 'newest', limit: 50, offset: 0 },
    }))
    expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty('persistSession')
  })

  it('rejects malformed knowledge list responses with a recoverable error', async () => {
    const { client } = clientFor({ result: { data: { candidates: [] }, error: null } })
    await expect(listKnowledge({ status: 'pending' }, client)).rejects.toMatchObject({ status: 502, code: 'incompatible_response', message: expect.stringContaining('incompatible knowledge list') })
  })

  it('maps an authorization rejection to a safe access error', async () => {
    const response = new Response(JSON.stringify({ error: 'private backend detail' }), { status: 403 })
    const { client } = clientFor({ result: { data: null, error: { context: response } } })
    await expect(checkMaintainerAccess(client)).rejects.toMatchObject({ status: 403, message: 'This account is not authorized to manage AI Knowledge.' })
  })

  it('requires a current access token before sending requests', async () => {
    const { client, invoke } = clientFor({ token: '' })
    await expect(checkMaintainerAccess(client)).rejects.toBeInstanceOf(ReviewApiError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps feedback in its own authenticated dashboard action and supports status updates', async () => {
    const { client, invoke } = clientFor({ result: { data: { current_knowledge_version: 'v1', candidate_source_refs: [], feedback: [], counts: { pending: 0, reviewed: 0, resolved: 0 }, page: { limit: 100, offset: 0, has_more: false } }, error: null } })
    await listAnswerFeedback({ status: 'pending', category: 'wrong_contact', limit: 100, offset: 0 }, client)
    expect(invoke).toHaveBeenLastCalledWith('ai-help-review', {
      body: { action: 'feedback_list', status: 'pending', category: 'wrong_contact', limit: 100, offset: 0 },
      headers: { Authorization: 'Bearer session-token' },
    })
    await reviewAnswerFeedback('feedback-id', 'resolved', client)
    expect(invoke).toHaveBeenLastCalledWith('ai-help-review', {
      body: { action: 'feedback_review', id: 'feedback-id', status: 'resolved' },
      headers: { Authorization: 'Bearer session-token' },
    })
    await reviewAnswerFeedback('feedback-id', 'pending', client)
    expect(invoke).toHaveBeenLastCalledWith('ai-help-review', {
      body: { action: 'feedback_review', id: 'feedback-id', status: 'pending' },
      headers: { Authorization: 'Bearer session-token' },
    })
    await setAnswerFeedbackKnowledgeDecision('feedback-id', 'no_knowledge_change', client)
    expect(invoke).toHaveBeenLastCalledWith('ai-help-review', {
      body: { action: 'feedback_decision', id: 'feedback-id', decision: 'no_knowledge_change' },
      headers: { Authorization: 'Bearer session-token' },
    })
    const fields = { topic_id: 'settings.answer_guidance', title: 'Settings answer guidance', explanation: 'Settings guidance explains the supported preference behavior clearly.', detailed_explanation: null, feature_category: 'settings', source_refs: ['src/features/settings/UnifiedSettings.tsx'] }
    await createAnswerFeedbackCandidate('feedback-id', fields, client)
    expect(invoke).toHaveBeenLastCalledWith('ai-help-review', {
      body: { action: 'feedback_candidate_create', id: 'feedback-id', ...fields },
      headers: { Authorization: 'Bearer session-token' },
    })
  })

  it('matches the compact feedback status response returned by the Edge Function', async () => {
    const feedbackStatus = { id: 'feedback-id', status: 'pending', reviewed_at: null }
    const { client } = clientFor({ result: { data: { feedback: feedbackStatus }, error: null } })
    await expect(reviewAnswerFeedback('feedback-id', 'pending', client)).resolves.toEqual({ feedback: feedbackStatus })
  })

  it('rejects malformed answer feedback responses instead of interpreting them as an empty inbox', async () => {
    const { client } = clientFor({ result: { data: { feedback: [], counts: { pending: 0 } }, error: null } })
    await expect(listAnswerFeedback({ status: 'pending' }, client)).rejects.toMatchObject({ status: 502, code: 'incompatible_response', message: expect.stringContaining('incompatible answer feedback list') })
  })

  it('accepts the current Edge Function envelope and keeps anonymous feedback identity-free', async () => {
    const sourceRow = {
      id: 'feedback-1', user_id: 'private-user-id', response_id: 'private-response-id', category: 'outdated',
      explanation: 'This answer is outdated.', topic: 'settings', knowledge_version: 'bundle-v1', status: 'pending',
      created_at: '2026-10-12T00:00:00Z', reviewed_at: null, share_identity: false,
      reviewer_id: 'private-reviewer-id', share_email: true, knowledge_decision: 'not_decided', knowledge_candidate_id: null,
    }
    const anonymousDto = buildMaintainerAnswerFeedback({
      row: sourceRow,
      identity: { display_name: 'Private Name', email: 'private@example.com' },
      currentPreference: false,
    })
    const edgePayload = buildAnswerFeedbackListPayload({
      knowledgeVersion: 'bundle-current', candidateSourceRefs: ['src/features/settings/UnifiedSettings.tsx'], feedback: [anonymousDto],
      pendingCount: 1, reviewedCount: 2, resolvedCount: 3, limit: 100, offset: 0,
    })
    const { client } = clientFor({ result: { data: edgePayload, error: null } })

    const result = await listAnswerFeedback({ status: 'pending', category: 'outdated', limit: 100, offset: 0 }, client)

    expect(result).toMatchObject({
      current_knowledge_version: 'bundle-current',
      candidate_source_refs: ['src/features/settings/UnifiedSettings.tsx'],
      counts: { pending: 1, reviewed: 2, resolved: 3 },
      page: { limit: 100, offset: 0, has_more: false },
    })
    expect(result.feedback).toEqual([expect.objectContaining({ identity: null })])
    expect(result.feedback[0]).not.toHaveProperty('user_id')
    expect(result.feedback[0]).not.toHaveProperty('reviewer_id')
    expect(result.feedback[0]).not.toHaveProperty('share_identity')
    expect(result.feedback[0]).not.toHaveProperty('share_email')
    expect(result.feedback[0]).not.toHaveProperty('response_id')
    expect(JSON.stringify(result)).not.toContain('private@example.com')
    expect(JSON.stringify(result)).not.toContain('private-response-id')
  })

  it('rejects the legacy knowledge_version envelope and recommends the missing Edge Function update', async () => {
    const { client } = clientFor({ result: { data: {
      knowledge_version: 'bundle-v1', feedback: [], counts: { pending: 0, reviewed: 0, resolved: 0 },
      page: { limit: 100, offset: 0, has_more: false },
    }, error: null } })
    await expect(listAnswerFeedback({ status: 'pending' }, client)).rejects.toMatchObject({
      status: 502,
      code: 'incompatible_response',
      message: 'The review service returned an incompatible answer feedback list. Deploy the latest ai-help-review function, then retry.',
    })
  })

  it('identifies an outdated Edge Function action and records only non-sensitive diagnostics', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = new Response(JSON.stringify({ error: 'Unsupported review action.', code: 'unsupported_action', secret: 'must not be logged' }), { status: 400 })
    const { client } = clientFor({ result: { data: null, error: { context: response } } })
    await expect(listAnswerFeedback({ status: 'pending' }, client)).rejects.toMatchObject({
      status: 400, code: 'incompatible_function_version', message: expect.stringContaining('compatible ai-help-review function'),
    })
    expect(warn).toHaveBeenCalledWith('AI_KNOWLEDGE_REVIEW_REQUEST_FAILED', {
      action: 'feedback_list', status: 400, code: 'unsupported_action', errorName: 'unknown',
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('must not be logged')
  })

  it('distinguishes a review service connection failure from an empty successful result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // This is the shape returned by supabase-js: the wrapper carries the
    // FunctionsFetchError name, while the low-level TypeError is its context.
    const transport = Object.assign(new Error('Failed to send a request to the Edge Function'), {
      name: 'FunctionsFetchError', context: new TypeError('network details must not reach the UI or logs'),
    })
    const { client } = clientFor({ result: { data: null, error: transport } })
    await expect(listKnowledge({ status: 'pending' }, client)).rejects.toMatchObject({ status: 0, code: 'network_error', message: expect.stringContaining('Could not connect') })
    await expect(listAnswerFeedback({ status: 'pending' }, client)).rejects.toMatchObject({ status: 0, code: 'network_error', message: expect.stringContaining('Could not connect') })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('network details must not reach the UI or logs')
  })

  it('submits stale knowledge invalidation with its optimistic review timestamp and reason', async () => {
    const { client, invoke } = clientFor({ result: { data: { result: { status: 'stale' } }, error: null } })
    await invalidateVerifiedTopic({ topic_id: 'account.signin', reviewed_at: '2026-10-01T00:00:00Z' } as never, 'The sign-in flow changed.', client)
    expect(invoke).toHaveBeenCalledWith('ai-help-review', {
      body: { action: 'invalidate', topic_id: 'account.signin', expected_reviewed_at: '2026-10-01T00:00:00Z', reason: 'The sign-in flow changed.' },
      headers: { Authorization: 'Bearer session-token' },
    })
  })
})
