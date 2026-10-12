import type { SupabaseClient } from '@supabase/supabase-js'

export type GeneralFeedbackCategory = 'bug_report' | 'feature_request' | 'general_feedback' | 'help_support'
export type GeneralFeedbackInput = { category: GeneralFeedbackCategory; message: string; requestId: string; source?: 'settings' | 'ai_help_support' | 'other'; subject?: string; shareEmail?: boolean }
export type GeneralFeedbackResult = { feedbackId?: string; deliveryStatus: 'accepted' | 'pending' | 'failed' | 'uncertain' | 'not_required' }

export class FeedbackSubmissionError extends Error {
  constructor(message: string, readonly status = 0, readonly retryAfterSeconds?: number, readonly uncertain = false, readonly retryable = true) { super(message) }
}

export async function submitGeneralFeedback(client: SupabaseClient | null, input: GeneralFeedbackInput): Promise<GeneralFeedbackResult> {
  if (!client) throw new FeedbackSubmissionError('Sign in to send feedback. You can email support directly below.', 401)
  const { data, error: sessionError } = await client.auth.getSession()
  const token = data.session?.access_token
  if (sessionError || !token) throw new FeedbackSubmissionError('Sign in again to send feedback. You can email support directly below.', 401)
  const { data: result, error } = await client.functions.invoke<{ accepted?: boolean; error?: string; retryAfterSeconds?: number; uncertain?: boolean; retryable?: boolean; feedbackId?: string; deliveryStatus?: GeneralFeedbackResult['deliveryStatus'] }>('send-feedback', {
    body: { category: input.category, message: input.message, request_id: input.requestId, source: input.source ?? 'settings', share_email: input.shareEmail ?? true, ...(input.subject ? { subject: input.subject } : {}) },
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!error && result?.accepted === true) return {
    ...(typeof result.feedbackId === 'string' ? { feedbackId: result.feedbackId } : {}),
    deliveryStatus: result.deliveryStatus ?? 'pending',
  }
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
    if (!message) {
      if (status === 401) message = 'Your sign-in expired. Sign in again to send feedback.'
      else if (status === 400) message = 'Check the feedback form and try again.'
      else if (status === 429) message = 'You have sent several feedback messages recently. Please wait before trying again.'
      else if (status === 404) message = 'Feedback is temporarily unavailable in this app version. Please try again shortly.'
      else if (status >= 500) message = 'Feedback could not be saved right now. Your message is still here; please retry.'
    }
  } else if (error) {
    status = 0
    message = 'Could not connect to Feedback & Support. Check your connection and retry.'
  }
  throw new FeedbackSubmissionError(message || "Couldn't send your feedback right now. You can email us directly instead.", status, retryAfterSeconds, uncertain, retryable)
}
