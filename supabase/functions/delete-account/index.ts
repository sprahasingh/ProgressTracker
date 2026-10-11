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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hashAuthorization(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(digest))
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' })
  const token = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return response(401, { error: 'Sign in again before deleting your account.' })

  let body: unknown
  try { body = await request.json() } catch { return response(400, { error: 'Invalid request.' }) }
  if (!body || typeof body !== 'object') return response(400, { error: 'Invalid request.' })
  const input = body as { action?: unknown; password?: unknown; confirmation?: unknown; authorization?: unknown }
  const action = input.action
  if (!['verify-password', 'delete', 'status'].includes(String(action))) return response(400, { error: 'Choose a supported account deletion action.' })

  const url = Deno.env.get('SUPABASE_URL')
  const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !publishableKey || !serviceRoleKey) return response(501, { error: 'Account deletion is not configured on the server.' })

  const verifier = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: verified, error: verifyError } = await verifier.auth.getClaims(token)
  const claims = verified?.claims
  const ownerId = typeof claims?.sub === 'string' ? claims.sub : null
  const issuedAt = typeof claims?.iat === 'number' ? claims.iat : null
  const expiresAt = typeof claims?.exp === 'number' ? claims.exp : null
  if (verifyError || !ownerId || !issuedAt || !expiresAt || expiresAt <= Date.now() / 1000) {
    return response(401, { error: 'Your sign-in session is invalid or expired. Sign in again.' })
  }

  const { data: account, error: accountError } = await admin.auth.admin.getUserById(ownerId)
  if (accountError && !missingUser(accountError, account.user)) {
    return response(503, { error: 'Could not verify the account deletion state. Retry when the connection is available.' })
  }
  // A valid signed token can confirm a completed deletion even if the original
  // response was lost after Supabase removed the Auth user.
  if (missingUser(accountError, account.user)) {
    return action === 'verify-password'
      ? response(401, { error: 'This account is no longer active.' })
      : response(200, { deleted: true })
  }
  if (action === 'status') return response(200, { deleted: false })

  const { data: liveIdentity, error: liveIdentityError } = await verifier.auth.getUser(token)
  if (liveIdentityError || liveIdentity.user?.id !== ownerId) {
    const { data: recheck, error: recheckError } = await admin.auth.admin.getUserById(ownerId)
    if (missingUser(recheckError, recheck.user)) return response(200, { deleted: true })
    if (recheckError) return response(503, { error: 'Could not verify the account deletion state. Retry when the connection is available.' })
    return response(401, { error: 'Your current sign-in could not be verified. Sign in again.' })
  }

  if (action === 'verify-password') {
    if (typeof input.password !== 'string' || input.password.length === 0 || input.password.length > 4096) {
      return response(400, { code: 'password_required', error: 'Enter your current account password.' })
    }

    const { data: attemptAllowed, error: limitError } = await admin.rpc('reserve_account_deletion_password_attempt', { p_user_id: ownerId })
    if (limitError) return response(503, { error: 'Password verification is temporarily unavailable. Try again shortly.' })
    if (!attemptAllowed) return response(429, { code: 'password_rate_limited', error: 'Too many password checks. Wait 15 minutes before trying again.' })

    const accountEmail = liveIdentity.user.email
    if (!accountEmail) return response(400, { error: 'This account does not have an email address for password verification.' })
    const passwordClient = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: passwordSession, error: passwordError } = await passwordClient.auth.signInWithPassword({ email: accountEmail, password: input.password })
    if (passwordError || passwordSession.user?.id !== ownerId) {
      return response(401, {
        code: 'password_not_verified',
        error: 'The password could not be verified. If you normally use email links, set a password first in Settings → Sync & Data → Set or change password.',
      })
    }

    const authorizationBytes = crypto.getRandomValues(new Uint8Array(32))
    const authorization = bytesToHex(authorizationBytes)
    const tokenHash = await hashAuthorization(authorization)
    const { error: issueError } = await admin.rpc('issue_account_deletion_authorization', { p_user_id: ownerId, p_token_hash: tokenHash })
    if (issueError) return response(503, { error: 'Password was verified, but deletion authorization could not be prepared. Try again.' })
    return response(200, { authorized: true, authorization, expires_in: 300 })
  }

  if (input.confirmation !== 'DELETE') return response(400, { error: 'Type DELETE to confirm account deletion.' })
  if (typeof input.authorization !== 'string' || !/^[0-9a-f]{64}$/.test(input.authorization)) {
    return response(401, { code: 'authorization_invalid', error: 'Verify your password again before deleting this account.' })
  }

  const tokenHash = await hashAuthorization(input.authorization)
  const { data: authorizationConsumed, error: consumeError } = await admin.rpc('consume_account_deletion_authorization', {
    p_user_id: ownerId,
    p_token_hash: tokenHash,
  })
  if (consumeError) return response(503, { error: 'Password authorization could not be checked. Verify your password again.' })
  if (!authorizationConsumed) return response(401, { code: 'authorization_invalid', error: 'Password verification expired or was already used. Verify your password again.' })

  const { error: deleteError } = await admin.auth.admin.deleteUser(ownerId)
  if (!deleteError) return response(200, { deleted: true })

  const { data: finalLookup, error: finalLookupError } = await admin.auth.admin.getUserById(ownerId)
  if (missingUser(finalLookupError, finalLookup.user)) return response(200, { deleted: true })
  if (finalLookupError) return response(503, { error: 'The deletion result could not be checked. Retry to confirm its status.' })
  return response(422, { error: 'The account was not deleted. Your local workspace remains available; retry after reviewing the error.' })
})
