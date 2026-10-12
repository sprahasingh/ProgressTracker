import { createClient } from 'npm:@supabase/supabase-js@2'
import { validateFeedbackExplanation } from './feedbackCore.ts'
import { deliverPendingSupportEmail } from '../_shared/supportFeedbackDelivery.ts'
import { PUBLIC_SUPPORT_EMAIL } from '../_shared/supportContact.ts'

const origins = new Set((Deno.env.get('AI_HELP_ALLOWED_ORIGINS') ?? '').split(',').map((value) => {
  try { return new URL(value.trim()).origin } catch { return '' }
}).filter(Boolean))
const categories = new Set(['helpful', 'factually_incorrect', 'outdated', 'wrong_instructions', 'wrong_contact', 'other'])
const topics = new Set(['core', 'trackers', 'goals', 'schedules', 'history', 'analytics', 'sync', 'privacy', 'account', 'notifications', 'settings', 'other'])

function json(status: number, body: Record<string, unknown>, origin = '') {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  } })
}

async function readBoundedBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('empty_request')
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 4_096) { await reader.cancel(); throw new RangeError('too_large') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

Deno.serve(async (request) => {
  const originHeader = request.headers.get('origin')
  let origin = ''
  try { origin = originHeader ? new URL(originHeader).origin : '' } catch { /* invalid origin */ }
  if (!origin || !origins.has(origin)) return new Response('Forbidden', { status: 403, headers: { Vary: 'Origin' } })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '3600', Vary: 'Origin',
  } })
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' }, origin)
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json(415, { error: 'Content-Type must be application/json.' }, origin)

  try {
    let body: unknown
    try { body = await readBoundedBody(request) } catch (error) {
      return error instanceof RangeError
        ? json(413, { error: 'Feedback is too long.' }, origin)
        : json(400, { error: 'Invalid feedback request.' }, origin)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid feedback request.' }, origin)
    const value = body as Record<string, unknown>
    if (Object.keys(value).some((key) => !['response_id', 'category', 'explanation', 'topic', 'knowledge_version'].includes(key))) return json(400, { error: 'Invalid feedback request.' }, origin)
    if (typeof value.response_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.response_id)
      || typeof value.category !== 'string' || !categories.has(value.category)
      || typeof value.topic !== 'string' || !topics.has(value.topic)
      || typeof value.knowledge_version !== 'string' || value.knowledge_version.length < 1 || value.knowledge_version.length > 100) {
      return json(400, { error: 'Choose a valid feedback category and try again.' }, origin)
    }
    const checkedExplanation = validateFeedbackExplanation(value.explanation)
    if (checkedExplanation.error === 'sensitive_content') {
      return json(400, { error: 'Remove email addresses, passwords, and access tokens from the explanation.' }, origin)
    }
    if (checkedExplanation.error === 'too_long') return json(400, { error: 'Keep the optional explanation under 400 characters.' }, origin)
    const explanation = checkedExplanation.explanation
    if (value.category === 'helpful' && explanation) return json(400, { error: 'Helpful feedback does not need an explanation.' }, origin)

    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    const url = Deno.env.get('SUPABASE_URL')
    const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!token || !url || !publishableKey || !serviceRoleKey) return json(401, { error: 'Sign in to send feedback.' }, origin)
    const verifier = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: identity, error: identityError } = await verifier.auth.getUser(token)
    if (identityError || !identity.user?.id) return json(401, { error: 'Your session expired. Sign in again to send feedback.' }, origin)

    const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await admin.rpc('submit_unified_ai_answer_feedback', {
      p_user_id: identity.user.id,
      p_response_id: value.response_id,
      p_category: value.category,
      p_explanation: explanation,
      p_topic: value.topic,
      p_knowledge_version: value.knowledge_version,
    })
    if (error) {
      try { await admin.rpc('record_ai_help_metric', { p_event: 'feedback_failed', p_feature_category: value.topic }) } catch { /* Aggregate diagnostics never alter feedback response. */ }
      if (error.code === 'P4290') return json(429, { error: 'Too many feedback reports. Try again later.' }, origin)
      return json(503, { error: 'Feedback could not be saved right now. Try again shortly.' }, origin)
    }
    if (data?.rate_limited) return json(429, { error: 'Too many feedback reports. Try again later.' }, origin)
    let deliveryStatus = data?.category === 'helpful' ? 'not_required' : 'pending'
    if (typeof data?.unified_feedback_id === 'string') {
      try {
        deliveryStatus = await deliverPendingSupportEmail(admin, data.unified_feedback_id, { userId: identity.user.id, email: identity.user.email ?? null }, {
          apiKey: Deno.env.get('BREVO_API_KEY') ?? '', from: Deno.env.get('FEEDBACK_FROM_EMAIL') ?? '',
          to: PUBLIC_SUPPORT_EMAIL, appVersion: Deno.env.get('SUPPORT_FEEDBACK_APP_VERSION') ?? '0.1.0',
        })
      } catch (deliveryError) {
        console.error('AI_HELP_FEEDBACK_DELIVERY_FAILED', JSON.stringify({ code: deliveryError instanceof Error ? deliveryError.message : 'unknown' }))
      }
    }
    return json(200, { accepted: data?.accepted === true, duplicate: data?.duplicate === true, feedbackId: data?.unified_feedback_id, deliveryStatus }, origin)
  } catch {
    return json(500, { error: 'Feedback could not be submitted. Try again shortly.' }, origin)
  }
})
