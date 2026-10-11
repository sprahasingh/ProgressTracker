import type { SupabaseClient } from '@supabase/supabase-js'

export type GeneralFeedbackCategory = 'bug_report' | 'feature_request' | 'general_feedback' | 'help_support'
export type GeneralFeedbackInput = { category: GeneralFeedbackCategory; message: string; requestId: string }

export class FeedbackSubmissionError extends Error {
  constructor(message: string, readonly status = 0, readonly retryAfterSeconds?: number, readonly uncertain = false, readonly retryable = true) { super(message) }
}

export async function submitGeneralFeedback(client: SupabaseClient | null, input: GeneralFeedbackInput): Promise<void> {
  if (!client) throw new FeedbackSubmissionError('Sign in to send feedback. You can email support directly below.', 401)
  const { data, error: sessionError } = await client.auth.getSession()
  const token = data.session?.access_token
  if (sessionError || !token) throw new FeedbackSubmissionError('Sign in again to send feedback. You can email support directly below.', 401)
  const { data: result, error } = await client.functions.invoke<{ accepted?: boolean; error?: string; retryAfterSeconds?: number; uncertain?: boolean; retryable?: boolean }>('send-feedback', {
    body: { category: input.category, message: input.message, request_id: input.requestId },
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!error && result?.accepted === true) return
  let message = result?.error ?? ''
  let status = 0
  let retryAfterSeconds: number | undefined
  let uncertain = result?.uncertain === true
  let retryable = result?.retryable ?? true
  if (error?.context instanceof Response) {
    const response = error.context
    status = response.status
    const header = Number(response.headers.get('retry-after'))
    if (Number.isFinite(header) && header > 0) retryAfterSeconds = Math.ceil(header)
    try {
      const payload = await response.clone().json() as { error?: unknown; retryAfterSeconds?: unknown; uncertain?: unknown; retryable?: unknown }
      if (typeof payload.error === 'string') message = payload.error
      if (typeof payload.retryAfterSeconds === 'number' && payload.retryAfterSeconds > 0) retryAfterSeconds = Math.ceil(payload.retryAfterSeconds)
      if (payload.uncertain === true) uncertain = true
      if (typeof payload.retryable === 'boolean') retryable = payload.retryable
    } catch { /* Keep a stable fallback for non-JSON gateway failures. */ }
  }
  throw new FeedbackSubmissionError(message || "Couldn't send your feedback right now. You can email us directly instead.", status, retryAfterSeconds, uncertain, retryable)
}
