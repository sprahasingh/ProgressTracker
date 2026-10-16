import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FullConfig } from '@playwright/test'

const container = process.env.PROGRESSION_TEST_DB_CONTAINER ?? 'supabase_db_progression-live-api-isolated-20261014'
const expectedApiUrl = process.env.PROGRESSION_TEST_API_URL ?? 'http://127.0.0.1:61421'
const email = 'browser-achievement-e2e@progress-tracker.invalid'
const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progression-playwright-auth.json'

function sql(query: string): string {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return execFileSync('docker', ['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', query], { encoding: 'utf8', timeout: 8_000 }).trim()
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? `${error.message}\n${'stderr' in error ? String(error.stderr) : ''}` : String(error)
      const transient = /timed out|ETIMEDOUT|connection refused|database system is starting up|temporarily unavailable/i.test(message)
      if (!transient || attempt === 2) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (attempt + 1))
    }
  }
  throw lastError
}

async function fetchReady(url: string, init: RequestInit = {}, timeoutMs = 5_000) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (response.status < 502 || attempt === 2) return response
      lastError = new Error(`Transient HTTP ${response.status}`)
    } catch (error) {
      lastError = error
      if (attempt === 2) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
  }
  throw lastError
}

export default async function globalSetup(_config: FullConfig) {
  const apiUrl = process.env.PROGRESSION_TEST_API_URL
  const anonKey = process.env.PROGRESSION_TEST_ANON_KEY
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(expectedApiUrl) || apiUrl !== expectedApiUrl || !anonKey) throw new Error(`Isolated Supabase preflight refused: expected only ${expectedApiUrl}.`)

  const dbStart = Date.now()
  const databaseName = sql('SELECT current_database();')
  const authHealth = await fetchReady(`${apiUrl}/auth/v1/health`)
  const restHealth = await fetchReady(`${apiUrl}/rest/v1/trackers?select=id&limit=0`, { headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` } })
  let expectedAnonymousDenial = false
  if (restHealth.status === 401) {
    const body = await restHealth.clone().json().catch(() => ({})) as { code?: string }
    expectedAnonymousDenial = body.code === '42501'
  }
  if (databaseName !== 'postgres' || !authHealth.ok || (!restHealth.ok && !expectedAnonymousDenial)) {
    throw new Error(`Isolated Supabase preflight failed: db=${databaseName}, auth=${authHealth.status}, rest=${restHealth.status}.`)
  }

  const otherUsers = sql(`SELECT count(*) FROM auth.users WHERE email <> '${email}';`)
  if (otherUsers !== '0') throw new Error(`Isolated E2E database contains ${otherUsers} unrelated Auth user(s); refusing to alter them.`)
  sql(`DELETE FROM auth.users WHERE email='${email}';`)
  const password = randomBytes(24).toString('base64url')
  const userId = sql(`WITH created AS (INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current, phone_change_token, reauthentication_token, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${email}', extensions.crypt('${password}', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), false, false) RETURNING id, email) INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at) SELECT gen_random_uuid(), id, jsonb_build_object('sub', id::text, 'email', email), 'email', email, now(), now() FROM created RETURNING user_id;`)
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Isolated Auth preflight could not create the disposable account.')

  try {
  await mkdir(dirname(fixturePath), { recursive: true })
  await writeFile(fixturePath, JSON.stringify({ userId, email, password }), { mode: 0o600 })
  await chmod(fixturePath, 0o600)

  const authStart = Date.now()
  let authResponse: Response
  try {
    authResponse = await fetchReady(`${apiUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }, 8_000)
  } catch (error) {
    throw new Error(`Isolated password authentication did not respond after bounded retries (${error instanceof Error ? error.message : String(error)}). DB/Auth/REST readiness had passed.`)
  }
  const authBody = await authResponse.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; user?: { id?: string }; error_description?: string; msg?: string }
  if (!authResponse.ok || authBody.user?.id !== userId || !authBody.access_token || !authBody.refresh_token) {
    throw new Error(`Isolated password authentication failed with HTTP ${authResponse.status} after ${Date.now() - authStart}ms: ${authBody.error_description ?? authBody.msg ?? 'response identity/token mismatch'}.`)
  }

  const historyStart = Date.now()
  const history = await fetchReady(`${apiUrl}/rest/v1/progression_achievement_events?select=id&user_id=eq.${userId}&limit=1`, {
    headers: { apikey: anonKey, authorization: `Bearer ${authBody.access_token}` },
  })
  if (!history.ok) throw new Error(`Authenticated RLS history preflight failed with HTTP ${history.status}.`)

  const repeatedProbeTimes: number[] = []
  for (let probe = 1; probe <= 3; probe += 1) {
    const probeStart = Date.now()
    const repeatedAuth = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(5_000),
    })
    const repeatedAuthBody = await repeatedAuth.json().catch(() => ({})) as { access_token?: string; user?: { id?: string } }
    if (!repeatedAuth.ok || repeatedAuthBody.user?.id !== userId || !repeatedAuthBody.access_token) {
      throw new Error(`Repeated authenticated readiness probe ${probe}/3 failed at Auth with HTTP ${repeatedAuth.status}.`)
    }
    const repeatedHistory = await fetch(`${apiUrl}/rest/v1/progression_achievement_events?select=id&user_id=eq.${userId}&limit=1`, {
      headers: { apikey: anonKey, authorization: `Bearer ${repeatedAuthBody.access_token}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!repeatedHistory.ok) throw new Error(`Repeated authenticated readiness probe ${probe}/3 failed at REST with HTTP ${repeatedHistory.status}.`)
    repeatedProbeTimes.push(Date.now() - probeStart)
  }

  await writeFile(fixturePath, JSON.stringify({ userId, email, password, accessToken: authBody.access_token, refreshToken: authBody.refresh_token }), { mode: 0o600 })
  await chmod(fixturePath, 0o600)
  process.env.SUPABASE_DB_CONTAINER = container
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/private/tmp/progression-playwright-browsers'
  process.stdout.write(`Isolated Supabase preflight passed: DB=${databaseName}, Auth=${authResponse.status} (${Date.now() - authStart}ms), scoped history=${history.status} (${Date.now() - historyStart}ms), repeated Auth+RLS probes=3/3 (${repeatedProbeTimes.join(',')}ms), Auth users=${sql('SELECT count(*) FROM auth.users;')}; setup=${Date.now() - dbStart}ms.\n`)
  } catch (error) {
    try {
      sql(`DELETE FROM auth.users WHERE id='${userId}' AND email='${email}';`)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Isolated E2E setup failed and the named test account could not be cleaned. Fixture record: ${fixturePath}`)
    }
    await rm(fixturePath, { force: true })
    throw error
  }
}
