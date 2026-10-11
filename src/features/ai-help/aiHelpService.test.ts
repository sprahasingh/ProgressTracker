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

  it('does not submit a remote request while offline or signed out', async () => {
    const invoke = vi.fn()
    const client = { functions: { invoke } } as never
    await expect(askAssistant(client, 'Tell me about the widgets.', [], 'other', false, true)).rejects.toMatchObject({ kind: 'offline' })
    await expect(askAssistant(client, 'Tell me about the widgets.', [], 'other', true, false)).rejects.toBeInstanceOf(HelpRequestError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('bounds conversation history and preserves route context in the request', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { answer: 'A grounded answer.' }, error: null })
    const client = { functions: { invoke } } as never
    const history = Array.from({ length: 10 }, (_, index) => ({ id: String(index), role: 'user' as const, content: 'x'.repeat(2500) }))
    await askAssistant(client, 'What is a goal?', history, 'goals', true, true)
    const body = invoke.mock.calls[0]?.[1]?.body
    expect(body.pageContext).toBe('goals')
    expect(body.history).toHaveLength(6)
    expect(body.history[0].content).toHaveLength(2000)
    expect(body).not.toHaveProperty('tracker')
  })

  it('maps provider rate limits to a friendly retryable state', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: null, error: { context: { status: 429 } } })
    await expect(askAssistant({ functions: { invoke } } as never, 'Question?', [], 'other', true, true)).rejects.toMatchObject({ kind: 'rate-limit' })
  })

  it('uses a locally verified answer when a remote request fails', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: null, error: new Error('offline') })
    await expect(askAssistant({ functions: { invoke } } as never, 'How are streaks calculated?', [], 'today', true, true)).resolves.toMatchObject({ answer: expect.stringContaining('scheduled') })
  })
})
