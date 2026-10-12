import { createClient } from 'npm:@supabase/supabase-js@2'
import { PUBLIC_SUPPORT_EMAIL } from '../_shared/supportContact.ts'
import { validateFeedbackSubmission } from './feedbackCore.ts'
import { deliverPendingSupportEmail } from '../_shared/supportFeedbackDelivery.ts'

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

async function recordSupportOutcome(admin: ReturnType<typeof createClient>, submission: { category: string }, event: 'support_query_accepted' | 'support_query_failed' | 'support_query_uncertain') {
  if (submission.category !== 'help_support') return
  try {
    const { error } = await admin.rpc('record_ai_help_metric', { p_event: event, p_feature_category: 'other' })
    if (error) console.error('SUPPORT_QUERY_METRIC_WRITE_FAILED', JSON.stringify({ event, databaseCode: error.code ?? 'unknown' }))
  } catch { console.error('SUPPORT_QUERY_METRIC_WRITE_FAILED', JSON.stringify({ event, databaseCode: 'unavailable' })) }
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
  const brevoKey = Deno.env.get('BREVO_API_KEY') ?? ''
  const fromEmail = Deno.env.get('FEEDBACK_FROM_EMAIL') ?? ''
  if (!url || !publishableKey || !serviceRoleKey) return json(503, { error: 'Feedback could not be saved right now. Please retry shortly.' }, origin)

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
  const category = submission.category === 'help_support' ? 'support_query' : submission.category
  const source = submission.source ?? 'settings'
  const subject = submission.subject ?? (submission.message.split('\n')[0]!.slice(0, 160) || 'ProgressTracker feedback')
  const { data: saved, error: saveError } = await admin.rpc('submit_unified_support_feedback', {
    p_user_id: identity.user.id, p_request_id: submission.requestId, p_category: category,
    p_source: source, p_subject: subject, p_message: submission.message, p_share_email: submission.shareEmail ?? true,
  })
  if (saveError || !saved?.feedback_id) {
    if (saveError?.code === 'P4290') return json(429, { accepted: false, error: 'You have sent several feedback messages recently. Please wait a little before trying again.', retryAfterSeconds: 900 }, origin)
    console.error('SUPPORT_FEEDBACK_PERSISTENCE_FAILED', JSON.stringify({ databaseCode: saveError?.code ?? 'empty_response' }))
    return json(503, { error: 'Feedback could not be saved right now. Your message is still here; please retry.' }, origin)
  }
  let deliveryStatus: string = saved.email_status ?? 'pending'
  try {
    deliveryStatus = await deliverPendingSupportEmail(admin, saved.feedback_id, { userId: identity.user.id, email: identity.user.email_confirmed_at ? identity.user.email ?? null : null }, {
      apiKey: brevoKey, from: fromEmail, to: PUBLIC_SUPPORT_EMAIL,
      appVersion: Deno.env.get('SUPPORT_FEEDBACK_APP_VERSION') ?? '0.1.0',
    })
  } catch (error) {
    console.error('SUPPORT_FEEDBACK_DELIVERY_FAILED', JSON.stringify({ code: error instanceof Error ? error.message : 'unknown' }))
  }
  const metric = deliveryStatus === 'accepted' ? 'support_query_accepted' : deliveryStatus === 'uncertain' ? 'support_query_uncertain' : 'support_query_failed'
  await recordSupportOutcome(admin, submission, metric)
  return json(200, { accepted: true, duplicate: saved.duplicate === true, feedbackId: saved.feedback_id, deliveryStatus }, origin)
})
