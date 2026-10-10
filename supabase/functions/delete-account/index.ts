import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders })
}

function missingUser(error: { status?: number; code?: string } | null, user: unknown): boolean {
  return (!error && !user) || error?.status === 404 || error?.code === 'user_not_found'
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' })
  const token = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return response(401, { error: 'Sign in again before deleting your account.' })

  let body: unknown
  try { body = await request.json() } catch { return response(400, { error: 'Invalid request.' }) }
  if (!body || typeof body !== 'object' || (body as { confirmation?: unknown }).confirmation !== 'DELETE') {
    return response(400, { error: 'Type DELETE to confirm account deletion.' })
  }

  const url = Deno.env.get('SUPABASE_URL')
  const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !publishableKey || !serviceRoleKey) return response(501, { error: 'Account deletion is not configured on the server.' })

  const verifier = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  // Verify the JWT signature before trusting the subject or authentication time.
  const { data: verified, error: verifyError } = await verifier.auth.getClaims(token)
  const claims = verified?.claims
  const ownerId = typeof claims?.sub === 'string' ? claims.sub : null
  const issuedAt = typeof claims?.iat === 'number' ? claims.iat : null
  const expiresAt = typeof claims?.exp === 'number' ? claims.exp : null
  const methods = Array.isArray(claims?.amr) ? claims.amr : []
  const authenticatedAt = methods.reduce((latest, method) => {
    if (!method || typeof method !== 'object') return latest
    const record = method as { method?: unknown; timestamp?: unknown }
    if (!['password', 'otp', 'magiclink', 'oauth', 'totp', 'sso/saml', 'recovery'].includes(String(record.method))) return latest
    return typeof record.timestamp === 'number' ? Math.max(latest, record.timestamp) : latest
  }, 0)
  if (verifyError || !ownerId || !issuedAt || !expiresAt || expiresAt <= Date.now() / 1000) {
    return response(401, { error: 'Your sign-in session is invalid or expired. Sign in again.' })
  }

  const { data: initialLookup, error: initialLookupError } = await admin.auth.admin.getUserById(ownerId)
  if (initialLookupError && !missingUser(initialLookupError, initialLookup.user)) {
    return response(503, { error: 'Could not verify the account deletion state. Retry when the connection is available.' })
  }
  // A still-valid, cryptographically verified token for an already absent Auth
  // user is an idempotent retry after deletion or a lost HTTP response.
  if (missingUser(initialLookupError, initialLookup.user)) return response(200, { deleted: true })

  const { data: liveIdentity, error: liveIdentityError } = await verifier.auth.getUser(token)
  if (liveIdentityError || liveIdentity.user?.id !== ownerId) {
    const { data: recheck, error: recheckError } = await admin.auth.admin.getUserById(ownerId)
    if (missingUser(recheckError, recheck.user)) return response(200, { deleted: true })
    if (recheckError) return response(503, { error: 'Could not verify the account deletion state. Retry when the connection is available.' })
    return response(401, { error: 'Your current sign-in could not be verified. Sign in again.' })
  }

  const now = Math.floor(Date.now() / 1000)
  if (issuedAt > now + 30 || authenticatedAt > now + 30 || now - authenticatedAt > 5 * 60) {
    return response(401, { error: 'For your security, complete a fresh email sign-in before deleting this account.' })
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(ownerId)
  if (!deleteError) return response(200, { deleted: true })

  // Concurrent/replayed requests are safe: only the first call removes the Auth
  // user; every retry confirms absence rather than repeating a partial cleanup.
  const { data: finalLookup, error: finalLookupError } = await admin.auth.admin.getUserById(ownerId)
  if (missingUser(finalLookupError, finalLookup.user)) return response(200, { deleted: true })
  if (finalLookupError) return response(503, { error: 'The deletion result could not be checked. Retry to confirm its status.' })
  return response(422, { error: 'The account was not deleted. Your local workspace remains available; retry after reviewing the error.' })
})
