import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FullConfig } from '@playwright/test'

const container = process.env.PROGRESSION_TEST_DB_CONTAINER ?? 'supabase_db_progression-live-api-isolated-20261014'
const expectedApiUrl = process.env.PROGRESSION_TEST_API_URL ?? 'http://127.0.0.1:61421'
type FixtureKey = 'primary' | 'retrospective'
const fixtureEmails: Partial<Record<FixtureKey, string>> = {
  primary: 'browser-achievement-e2e@progress-tracker.invalid',
  ...(process.env.PROGRESSION_RULE_HISTORY_PROJECT_ID ? { retrospective: 'browser-rule-history-retrospective@progress-tracker.invalid' } : {}),
}
const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progression-playwright-auth.json'

type FixtureUser = { userId: string; email: string; password: string; accessToken: string; refreshToken: string }

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

async function assertRequestSucceeded(label: string, response: Response): Promise<void> {
  if (response.ok) return
  const body = await response.clone().json().catch(() => ({})) as { code?: string; message?: string; details?: string }
  const code = body.code ? ` (${body.code})` : ''
  const message = body.message ?? body.details ?? `HTTP ${response.status}`
  throw new Error(`Isolated ${label} preflight failed${code}: ${message}.`)
}

export default async function globalSetup(_config: FullConfig) {
  const apiUrl = process.env.PROGRESSION_TEST_API_URL
  const anonKey = process.env.PROGRESSION_TEST_ANON_KEY
  // The rule-history browser suite pins both its browser and saved workspace
  // timezone to UTC. Other focused suites use Asia/Calcutta. Keep preflight's
  // write aligned with the suite contract so it cannot seed a conflicting
  // remote timezone before the browser signs in.
  const preflightTimeZone = process.env.PROGRESSION_RULE_HISTORY_PROJECT_ID ? 'UTC' : 'Asia/Calcutta'
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

  const emails = Object.values(fixtureEmails).filter((value): value is string => typeof value === 'string')
  const allowedEmails = emails.map((value) => `'${value}'`).join(', ')
  const otherUsers = sql(`SELECT count(*) FROM auth.users WHERE email NOT IN (${allowedEmails});`)
  if (otherUsers !== '0') throw new Error(`Isolated E2E database contains ${otherUsers} unrelated Auth user(s); refusing to alter them.`)
  for (const email of emails) sql(`DELETE FROM auth.users WHERE email='${email}';`)
  const createdUsers: Array<{ userId: string; email: string }> = []
  const fixtureUsers: Partial<Record<FixtureKey, FixtureUser>> = {}
  try {
  const repeatedProbeTimes: number[] = []
  const authStatuses: number[] = []
  const historyStatuses: number[] = []
  for (const key of Object.keys(fixtureEmails) as FixtureKey[]) {
    const email = fixtureEmails[key]!
    const password = randomBytes(24).toString('base64url')
    const userId = sql(`WITH created AS (INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current, phone_change_token, reauthentication_token, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${email}', extensions.crypt('${password}', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), false, false) RETURNING id, email) INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at) SELECT gen_random_uuid(), id, jsonb_build_object('sub', id::text, 'email', email), 'email', email, now(), now() FROM created RETURNING user_id;`)
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error(`Isolated Auth preflight could not create the ${key} disposable account.`)
    createdUsers.push({ userId, email })

    const authStart = Date.now()
    let authResponse: Response
    try {
      authResponse = await fetchReady(`${apiUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }, 8_000)
    } catch (error) {
      throw new Error(`Isolated ${key} password authentication did not respond after bounded retries (${error instanceof Error ? error.message : String(error)}). DB/Auth/REST readiness had passed.`)
    }
    const authBody = await authResponse.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; user?: { id?: string }; error_description?: string; msg?: string }
    if (!authResponse.ok || authBody.user?.id !== userId || !authBody.access_token || !authBody.refresh_token) {
      throw new Error(`Isolated ${key} password authentication failed with HTTP ${authResponse.status} after ${Date.now() - authStart}ms: ${authBody.error_description ?? authBody.msg ?? 'response identity/token mismatch'}.`)
    }
    authStatuses.push(authResponse.status)

    const historyStart = Date.now()
    const history = await fetchReady(`${apiUrl}/rest/v1/progression_achievement_events?select=id&user_id=eq.${userId}&limit=1`, {
      headers: { apikey: anonKey, authorization: `Bearer ${authBody.access_token}` },
    })
    if (!history.ok) throw new Error(`Authenticated ${key} RLS history preflight failed with HTTP ${history.status}.`)
    historyStatuses.push(history.status)

    const authHeaders = { apikey: anonKey, authorization: `Bearer ${authBody.access_token}` }
    const contract = await fetchReady(`${apiUrl}/rest/v1/rpc/tracker_edit_sync_guards_contract`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{}',
    })
    await assertRequestSucceeded(`${key} tracker-edit guard contract`, contract)
    if (await contract.json().catch(() => null) !== 'tracker-edit-sync-guards:v1') {
      throw new Error(`Authenticated ${key} tracker-edit guard probe returned an unsupported contract.`)
    }

    const settingsUrl = `${apiUrl}/rest/v1/app_settings?select=timezone,timezone_configured&user_id=eq.${userId}`
    const settingsRead = await fetchReady(settingsUrl, { headers: authHeaders })
    await assertRequestSucceeded(`${key} workspace timezone read`, settingsRead)
    const timezoneWrite = await fetchReady(`${apiUrl}/rest/v1/app_settings?on_conflict=user_id`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: 'general', user_id: userId, timezone: preflightTimeZone, timezone_configured: true }),
    })
    await assertRequestSucceeded(`${key} workspace timezone write`, timezoneWrite)
    const timezoneReadback = await fetchReady(settingsUrl, { headers: authHeaders })
    await assertRequestSucceeded(`${key} workspace timezone verification`, timezoneReadback)
    const savedSettings = await timezoneReadback.json().catch(() => []) as Array<{ timezone?: string; timezone_configured?: boolean }>
    if (savedSettings.length !== 1 || savedSettings[0]?.timezone !== preflightTimeZone || savedSettings[0]?.timezone_configured !== true) {
      throw new Error(`Authenticated ${key} workspace timezone write did not round-trip.`)
    }

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
        throw new Error(`Repeated ${key} authenticated readiness probe ${probe}/3 failed at Auth with HTTP ${repeatedAuth.status}.`)
      }
      const repeatedHistory = await fetch(`${apiUrl}/rest/v1/progression_achievement_events?select=id&user_id=eq.${userId}&limit=1`, {
        headers: { apikey: anonKey, authorization: `Bearer ${repeatedAuthBody.access_token}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!repeatedHistory.ok) throw new Error(`Repeated ${key} authenticated readiness probe ${probe}/3 failed at REST with HTTP ${repeatedHistory.status}.`)
      repeatedProbeTimes.push(Date.now() - probeStart)
    }
    fixtureUsers[key] = { userId, email, password, accessToken: authBody.access_token, refreshToken: authBody.refresh_token }
    process.stdout.write(`Isolated ${key} account: Auth=${authResponse.status} (${Date.now() - authStart}ms), scoped history=${history.status} (${Date.now() - historyStart}ms), repeated Auth+RLS probes=3/3.\n`)
  }
  await mkdir(dirname(fixturePath), { recursive: true })
  // Keep the original top-level primary fixture fields for the existing XP History
  // and tracker-edit specs while versioned-rule tests select either named account.
  await writeFile(fixturePath, JSON.stringify({ ...fixtureUsers.primary!, users: fixtureUsers }), { mode: 0o600 })
  await chmod(fixturePath, 0o600)
  process.env.SUPABASE_DB_CONTAINER = container
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/private/tmp/progression-playwright-browsers'
  if (sql('SELECT count(*) FROM auth.users;') !== String(emails.length)) throw new Error(`Isolated Auth preflight expected exactly its ${emails.length} named disposable account(s).`)
  process.stdout.write(`Isolated Supabase preflight passed: DB=${databaseName}, Auth=${authStatuses.join('/')}, scoped RLS=${historyStatuses.join('/')}, repeated Auth+RLS probes=6/6 (${repeatedProbeTimes.join(',')}ms), Auth users=${sql('SELECT count(*) FROM auth.users;')}; setup=${Date.now() - dbStart}ms.\n`)
  } catch (error) {
    const cleanupErrors: unknown[] = []
    for (const user of createdUsers) {
      try { sql(`DELETE FROM auth.users WHERE id='${user.userId}' AND email='${user.email}';`) }
      catch (cleanupError) { cleanupErrors.push(cleanupError) }
    }
    await rm(fixturePath, { force: true })
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], `Isolated E2E setup failed and one or more named disposable accounts could not be cleaned. Fixture record: ${fixturePath}`)
    throw error
  }
}
