import { createClient } from 'npm:@supabase/supabase-js@2'
import { PUBLIC_SUPPORT_EMAIL } from '../_shared/supportContact.ts'
import { deliverFeedbackEmail, validateFeedbackSubmission } from './feedbackCore.ts'

const allowedOrigins = new Set((Deno.env.get('SUPPORT_FEEDBACK_ALLOWED_ORIGINS') ?? Deno.env.get('AI_HELP_ALLOWED_ORIGINS') ?? '').split(',').map((value) => {
  try { return new URL(value.trim()).origin } catch { return '' }
}).filter(Boolean))

function json(status: number, payload: Record<string, unknown>, origin: string) {
  return new Response(JSON.stringify(payload), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  } })
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body || Number(request.headers.get('content-length') ?? 0) > 12_000) throw new RangeError()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 12_000) { await reader.cancel(); throw new RangeError() }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

Deno.serve(async (request) => {
  let origin = ''
  try { origin = request.headers.get('origin') ? new URL(request.headers.get('origin')!).origin : '' } catch { /* Rejected below. */ }
  if (!origin || !allowedOrigins.has(origin)) return new Response('Forbidden', { status: 403, headers: { Vary: 'Origin' } })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Max-Age': '3600', Vary: 'Origin',
  } })
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' }, origin)
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json(415, { error: 'Content-Type must be application/json.' }, origin)

  const url = Deno.env.get('SUPABASE_URL')
  const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const brevoKey = Deno.env.get('BREVO_API_KEY')
  const fromEmail = Deno.env.get('FEEDBACK_FROM_EMAIL')
  if (!url || !publishableKey || !serviceRoleKey || !brevoKey || !fromEmail) {
    console.error('SUPPORT_FEEDBACK_CONFIGURATION_MISSING', JSON.stringify({ supabase: Boolean(url && publishableKey && serviceRoleKey), provider: Boolean(brevoKey && fromEmail) }))
    return json(503, { error: 'Feedback sending is not configured yet. You can email support directly below.' }, origin)
  }

  let value: unknown
  try { value = await readBody(request) } catch (error) {
    return error instanceof RangeError ? json(413, { error: 'Your message is too large.' }, origin) : json(400, { error: 'Check your feedback form and try again.' }, origin)
  }
  const submission = validateFeedbackSubmission(value)
  if (!submission) return json(400, { error: 'Choose a feedback type and enter a 1–2,000 character message. Do not include passwords or access tokens.' }, origin)

  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return json(401, { error: 'Sign in before sending feedback.' }, origin)
  const verifier = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: identity, error: identityError } = await verifier.auth.getUser(token)
  if (identityError || !identity.user?.id) return json(401, { error: 'Your session expired. Sign in again to send feedback.' }, origin)

  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: reservation, error: reserveError } = await admin.rpc('begin_support_feedback_submission', {
    p_user_id: identity.user.id, p_request_id: submission.requestId,
  })
  if (reserveError || !reservation) {
    console.error('SUPPORT_FEEDBACK_RESERVATION_FAILED', JSON.stringify({ databaseCode: reserveError?.code ?? 'empty_response' }))
    return json(503, { error: 'Feedback could not be sent right now. Your message is still here; retry or email support directly.' }, origin)
  }
  if (reservation.accepted === true) return json(200, { accepted: true, duplicate: true }, origin)
  if (reservation.uncertain === true) return json(503, { error: 'We couldn’t confirm whether Brevo accepted this message. To avoid sending a duplicate, automatic retry is disabled. Please email support directly if you still need help.', uncertain: true, retryable: false }, origin)
  if (reservation.processing === true) return json(503, { error: 'This feedback request is still being processed. Its status is not confirmed yet, so automatic retry is paused to prevent a duplicate.', uncertain: true, retryable: false }, origin)
  if (reservation.allowed !== true) return json(429, { error: 'You have sent several feedback messages recently. Please wait a little before trying again.', retryAfterSeconds: reservation.retry_after_seconds, retryable: true }, origin)

  const result = await deliverFeedbackEmail(submission, { userId: identity.user.id, email: identity.user.email ?? null }, {
    apiKey: brevoKey,
    from: fromEmail,
    to: PUBLIC_SUPPORT_EMAIL,
    appVersion: Deno.env.get('SUPPORT_FEEDBACK_APP_VERSION') ?? '0.1.0',
  })
  if (!result.accepted) {
    const { error: outcomeError } = await admin.rpc('resolve_support_feedback_submission', {
      p_user_id: identity.user.id,
      p_request_id: submission.requestId,
      p_delivery_state: result.outcome,
    })
    if (outcomeError) {
      console.error('SUPPORT_FEEDBACK_OUTCOME_FAILED', JSON.stringify({ databaseCode: outcomeError.code ?? 'unknown', outcome: result.outcome }))
      return json(503, { error: 'Feedback status could not be saved. To avoid a duplicate, automatic retry is paused; please email support directly if needed.', uncertain: true, retryable: false }, origin)
    }
    console.error('SUPPORT_FEEDBACK_PROVIDER_FAILED', JSON.stringify({ status: result.status, retryable: result.retryable, category: submission.category }))
    return json(result.status === 429 ? 429 : 503, {
      error: result.outcome === 'uncertain'
        ? 'We couldn’t confirm whether Brevo accepted this message. To avoid sending a duplicate, automatic retry is disabled. Please email support directly if you still need help.'
        : 'Brevo rejected this feedback request. You can retry safely or email support directly.',
      uncertain: result.outcome === 'uncertain',
      retryable: result.retryable,
    }, origin)
  }

  const { error: completeError } = await admin.rpc('complete_support_feedback_submission', {
    p_user_id: identity.user.id, p_request_id: submission.requestId,
  })
  if (completeError) {
    console.error('SUPPORT_FEEDBACK_COMPLETION_FAILED', JSON.stringify({ databaseCode: completeError.code ?? 'unknown' }))
    return json(503, { error: 'The email provider accepted your message, but its status could not be confirmed. Retry safely or use email support.' }, origin)
  }
  return json(200, { accepted: true, duplicate: false, deliveryStatus: 'provider_accepted' }, origin)
})
