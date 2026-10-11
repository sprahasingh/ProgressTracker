import { describe, expect, it, vi } from 'vitest'
import { askAssistant, getHelpRoute, getLocalHelpAnswer, HelpRequestError } from './aiHelpService'

describe('AI Help knowledge helpers', () => {
  it('maps known application routes to safe feature identifiers', () => {
    expect(getHelpRoute('/trackers/new')).toBe('trackers')
    expect(getHelpRoute('/dashboard/history')).toBe('analytics')
    expect(getHelpRoute('/history')).toBe('history')
    expect(getHelpRoute('/unexpected/path')).toBe('other')
  })

  it('answers common questions from the local FAQ without a backend', async () => {
    expect(getLocalHelpAnswer('How are streaks calculated?')).toContain('scheduled')
    await expect(askAssistant(null, 'Can I change a saved measure?', [], 'trackers', false, false)).resolves.toHaveProperty('answer')
  })

  it('distinguishes definitions, supported measure types, and legacy checkbox follow-ups', () => {
    const first = 'What are measures?'
    const definition = getLocalHelpAnswer(first)
    expect(definition).toContain('one value')
    const history = [
      { id: '1', role: 'user' as const, content: first },
      { id: '2', role: 'assistant' as const, content: definition! },
    ]
    expect(getLocalHelpAnswer('Are there only two types?', history)).toContain('Yes/No or Quantity')
    expect(getLocalHelpAnswer('What about checkbox measures?', [...history, { id: '3', role: 'user', content: 'Are there only two types?' }])).toContain('legacy measure type')
    expect(getLocalHelpAnswer('What about checkbox measures?')).toContain('not available when creating')
  })

  it('does not submit a remote request while offline or signed out', async () => {
    const invoke = vi.fn()
    const client = { functions: { invoke } } as never
    await expect(askAssistant(client, 'Tell me about the widgets.', [], 'other', false, true)).rejects.toMatchObject({ kind: 'offline' })
    await expect(askAssistant(client, 'Tell me about the widgets.', [], 'other', true, false)).rejects.toBeInstanceOf(HelpRequestError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('bounds conversation history and preserves route context in the request', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { answer: 'A grounded answer.', followUps: ['How do goals work?', 'How do goals work?', { unsafe: true }], links: [{ href: '/trackers/new', label: 'Wrong label' }, { href: 'https://unsafe.example', label: 'Unsafe' }] }, error: null })
    const client = { functions: { invoke } } as never
    const history = Array.from({ length: 10 }, (_, index) => ({ id: String(index), role: 'user' as const, content: 'x'.repeat(2500) }))
    await askAssistant(client, 'What is a goal?', history, 'goals', true, true)
    const body = invoke.mock.calls[0]?.[1]?.body
    expect(body.pageContext).toBe('goals')
    expect(body.history).toHaveLength(6)
    expect(body.history[0].content).toHaveLength(2000)
    expect(body).not.toHaveProperty('tracker')
    await expect(askAssistant(client, 'What is a goal?', [], 'goals', true, true)).resolves.toMatchObject({
      followUps: ['How do goals work?'], links: [{ href: '/trackers/new', label: 'Create a tracker' }],
    })
  })

  it('maps provider rate limits to a friendly retryable state', async () => {
    const context = new Response(JSON.stringify({ code: 'provider_rate_limit', retryAfterSeconds: 17 }), { status: 429, headers: { 'Retry-After': '17' } })
    const invoke = vi.fn().mockResolvedValue({ data: null, error: { context } })
    await expect(askAssistant({ functions: { invoke } } as never, 'How are streaks calculated?', [], 'other', true, true)).rejects.toMatchObject({ kind: 'provider-rate-limit', retryAfterSeconds: 17 })
  })

  it('distinguishes application limits and malformed model responses', async () => {
    const client = (context: Response) => ({ functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: { context } }) } }) as never
    await expect(askAssistant(client(new Response(JSON.stringify({ code: 'application_rate_limit', retryAfterSeconds: 23 }), { status: 429 })), 'How are streaks calculated?', [], 'other', true, true)).rejects.toMatchObject({ kind: 'application-rate-limit', retryAfterSeconds: 23 })
    await expect(askAssistant(client(new Response(JSON.stringify({ code: 'invalid_model_response' }), { status: 502 })), 'Unknown question?', [], 'other', true, true)).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('distinguishes provider outages, provider cooldowns, configuration, and Edge failures', async () => {
    const client = (status: number, code: string, retryAfterSeconds?: number) => ({ functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: { context: new Response(JSON.stringify({ code, retryAfterSeconds }), { status }) } }) } }) as never
    await expect(askAssistant(client(503, 'provider_unavailable'), 'Unknown system question?', [], 'other', true, true)).rejects.toMatchObject({ kind: 'provider-unavailable' })
    await expect(askAssistant(client(503, 'provider_cooldown', 12), 'Unknown system question?', [], 'other', true, true)).rejects.toMatchObject({ kind: 'provider-cooldown', retryAfterSeconds: 12 })
    await expect(askAssistant(client(503, 'configuration_missing'), 'Unknown system question?', [], 'other', true, true)).rejects.toMatchObject({ kind: 'configuration' })
    await expect(askAssistant(client(500, 'internal_error'), 'Unknown system question?', [], 'other', true, true)).rejects.toMatchObject({ kind: 'edge-error' })
  })

  it('uses a locally verified answer when a remote request fails', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: null, error: new Error('offline') })
    await expect(askAssistant({ functions: { invoke } } as never, 'How are streaks calculated?', [], 'today', true, true)).resolves.toMatchObject({ answer: expect.stringContaining('scheduled') })
  })
})
