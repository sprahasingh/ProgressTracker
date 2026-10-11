import { describe, expect, it, vi } from 'vitest'
import { checkMaintainerAccess, listKnowledge, ReviewApiError } from './aiKnowledgeApi'

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
    const { client, invoke } = clientFor({ result: { data: { candidates: [] }, error: null } })
    await listKnowledge({ status: 'pending', search: 'habit', sort: 'newest', limit: 50, offset: 0 }, client)
    expect(invoke).toHaveBeenCalledWith('ai-help-review', expect.objectContaining({
      body: { action: 'list', status: 'pending', search: 'habit', sort: 'newest', limit: 50, offset: 0 },
    }))
    expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty('persistSession')
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
})
