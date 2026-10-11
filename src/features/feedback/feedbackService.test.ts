import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FeedbackSubmissionError, submitGeneralFeedback } from './feedbackService'

function client(session: unknown, invokeResult: unknown) {
  const backend = {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }) },
    functions: { invoke: vi.fn().mockResolvedValue(invokeResult) },
  }
  return backend as unknown as SupabaseClient & typeof backend
}

const input = { category: 'bug_report' as const, message: 'The save button did not respond.', requestId: 'd9b71367-a20f-4ef1-b409-8b3cb7810c17' }

describe('submitGeneralFeedback', () => {
  it('sends only the user-entered category, message, and request ID with the current session token', async () => {
    const backend = client({ access_token: 'session-token' }, { data: { accepted: true }, error: null })
    await expect(submitGeneralFeedback(backend, input)).resolves.toBeUndefined()
    expect(backend.functions.invoke).toHaveBeenCalledWith('send-feedback', {
      body: { category: input.category, message: input.message, request_id: input.requestId },
      headers: { Authorization: 'Bearer session-token' },
    })
  })

  it('rejects missing sessions before calling the function', async () => {
    const backend = client(null, { data: null, error: null })
    await expect(submitGeneralFeedback(backend, input)).rejects.toMatchObject({ status: 401 })
    expect(backend.functions.invoke).not.toHaveBeenCalled()
  })

  it('preserves provider, rate-limit, and gateway failure messages for the form fallback', async () => {
    const response = new Response(JSON.stringify({ error: 'We could not confirm acceptance.', retryAfterSeconds: 75, uncertain: true, retryable: false }), { status: 503 })
    const backend = client({ access_token: 'session-token' }, { data: null, error: { context: response } })
    await expect(submitGeneralFeedback(backend, input)).rejects.toMatchObject({ status: 503, retryAfterSeconds: 75, uncertain: true, retryable: false } satisfies Partial<FeedbackSubmissionError>)
    await expect(submitGeneralFeedback(backend, input)).rejects.toThrow('We could not confirm acceptance.')
  })
})
