import { createClient } from 'npm:@supabase/supabase-js@2'
import { validatePushEndpoint, validatePushSubscription } from '../_shared/pushSubscriptionValidation.ts'

const MAX_BODY_BYTES = 16 * 1024

function allowedOrigins(): Set<string> {
  return new Set((Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((value) => {
    try { return new URL(value.trim()).origin } catch { return '' }
  }).filter(Boolean))
}

function response(status: number, body: Record<string, unknown>, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  } })
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_BODY_BYTES) throw new RequestError(413, 'Request is too large.')
  if (!request.body) throw new RequestError(400, 'Invalid request.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new RequestError(413, 'Request is too large.')
    }
    chunks.push(value)
  }
  try {
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new RequestError(400, 'Invalid request.')
  }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

Deno.serve(async (request) => {
  const originHeader = request.headers.get('origin')
  const origins = allowedOrigins()
  let origin = ''
  try { origin = originHeader ? new URL(originHeader).origin : '' } catch { /* Invalid origin is rejected below. */ }
  if (!origin || !origins.has(origin)) return new Response('Forbidden', { status: 403, headers: { 'Vary': 'Origin' } })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  } })
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' }, origin)
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return response(415, { error: 'Content-Type must be application/json.' }, origin)
  }

  try {
    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) return response(401, { error: 'Sign in before managing device notifications.' }, origin)

    const body = await readBoundedJson(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'Invalid request.')
    const input = body as Record<string, unknown>
    if (Object.keys(input).some((key) => !['action', 'subscription'].includes(key))) throw new RequestError(400, 'Invalid request.')
    if (input.action !== 'register' && input.action !== 'revoke') throw new RequestError(400, 'Invalid action.')
    if (!input.subscription || typeof input.subscription !== 'object' || Array.isArray(input.subscription)) throw new RequestError(400, 'Invalid subscription.')

    const subscription = input.subscription as Record<string, unknown>
    const endpoint = validatePushEndpoint(subscription.endpoint)
    if (!endpoint) throw new RequestError(400, 'Invalid subscription endpoint.')
    let registration: ReturnType<typeof validatePushSubscription> = null
    if (input.action === 'register') {
      registration = validatePushSubscription(subscription)
      if (!registration) throw new RequestError(400, 'The browser subscription is invalid or expired. Enable notifications again to renew it.')
    } else if (Object.keys(subscription).some((key) => key !== 'endpoint')) {
      throw new RequestError(400, 'Invalid revocation request.')
    }

    const url = Deno.env.get('SUPABASE_URL')
    const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !publishableKey || !serviceRoleKey) return response(503, { error: 'Device registration is not configured on the server.' }, origin)

    const verifier = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: identity, error: identityError } = await verifier.auth.getUser(token)
    const userId = identity.user?.id
    if (identityError || !userId) return response(401, { error: 'Your sign-in session is invalid or expired. Sign in again.' }, origin)

    const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { error } = await admin.rpc('manage_notification_device', {
      p_user_id: userId,
      p_action: input.action,
      p_endpoint: endpoint,
      p_p256dh: registration?.keys.p256dh ?? null,
      p_auth_secret: registration?.keys.auth ?? null,
      p_user_agent: request.headers.get('user-agent')?.slice(0, 512) ?? null,
      p_expires_at: registration?.expirationTime ? new Date(registration.expirationTime).toISOString() : null,
    })
    if (error?.code === '23505') return response(409, { error: 'This device subscription is already registered to another account. Disable it from that account before using it here.' }, origin)
    if (error?.code === 'P0001' || error?.code === '54000') return response(429, { error: 'Too many device registration requests. Wait a minute and retry.' }, origin)
    if (error?.code === '22023') return response(400, { error: 'The subscription request is invalid or expired.' }, origin)
    if (error) return response(503, { error: 'The subscription could not be saved. Retry when the connection is available.' }, origin)
    return response(200, { status: input.action === 'register' ? 'registered' : 'revoked' }, origin)
  } catch (error) {
    if (error instanceof RequestError) return response(error.status, { error: error.message }, origin)
    // Deliberately omit exception details: they may contain subscription data.
    return response(500, { error: 'Device registration could not be completed.' }, origin)
  }
})
