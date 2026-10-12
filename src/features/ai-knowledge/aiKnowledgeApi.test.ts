import { describe, expect, it, vi } from 'vitest'
import { checkMaintainerAccess, invalidateVerifiedTopic, listAnswerFeedback, listKnowledge, reviewAnswerFeedback, ReviewApiError } from './aiKnowledgeApi'

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
    const { client, invoke } = clientFor({ result: { data: { current_knowledge_version: 'v1', feedback: [], counts: { pending: 0, reviewed: 0, resolved: 0 }, page: { limit: 100, offset: 0, has_more: false } }, error: null } })
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
  })

  it('rejects malformed answer feedback responses instead of interpreting them as an empty inbox', async () => {
    const { client } = clientFor({ result: { data: { feedback: [], counts: { pending: 0 } }, error: null } })
    await expect(listAnswerFeedback({ status: 'pending' }, client)).rejects.toMatchObject({ status: 502, code: 'incompatible_response', message: expect.stringContaining('incompatible answer feedback list') })
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
    const transport = Object.assign(new Error('network failed'), { name: 'FunctionsFetchError' })
    const { client } = clientFor({ result: { data: null, error: { context: transport } } })
    await expect(checkMaintainerAccess(client)).rejects.toMatchObject({ status: 0, message: expect.stringContaining('Could not connect') })
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
