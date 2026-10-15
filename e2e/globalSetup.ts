import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FullConfig } from '@playwright/test'

const workdir = process.env.PROGRESSION_TEST_SUPABASE_WORKDIR ?? '/private/tmp/progression-live-api'
const container = process.env.PROGRESSION_TEST_DB_CONTAINER ?? 'supabase_db_progression-live-api-isolated-20261014'
const expectedApiUrl = process.env.PROGRESSION_TEST_API_URL ?? 'http://127.0.0.1:61421'
const email = 'browser-achievement-e2e@progress-tracker.invalid'
const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progression-playwright-auth.json'

function sql(query: string): string {
  return execFileSync('docker', ['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', query], { encoding: 'utf8', timeout: 90_000 }).trim()
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 8_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

export default async function globalSetup(_config: FullConfig) {
  const output = execFileSync('supabase', ['status', '--workdir', workdir, '--output', 'env'], { encoding: 'utf8', env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: 'true' } })
  const env = Object.fromEntries(output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z_]+)="(.*)"$/)
    return match ? [[match[1]!, match[2]!]] : []
  }))
  const apiUrl = env.API_URL
  const anonKey = env.ANON_KEY
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(expectedApiUrl) || apiUrl !== expectedApiUrl || !anonKey) throw new Error(`Isolated Supabase preflight refused: expected only ${expectedApiUrl}.`)

  const dbStart = Date.now()
  const databaseName = sql('SELECT current_database();')
  const authHealth = await fetchWithTimeout(`${apiUrl}/auth/v1/health`)
  const restHealth = await fetchWithTimeout(`${apiUrl}/rest/v1/`)
  if (databaseName !== 'postgres' || !authHealth.ok || !restHealth.ok) {
    throw new Error(`Isolated Supabase preflight failed: db=${databaseName}, auth=${authHealth.status}, rest=${restHealth.status}.`)
  }

  const otherUsers = sql(`SELECT count(*) FROM auth.users WHERE email <> '${email}';`)
  if (otherUsers !== '0') throw new Error(`Isolated E2E database contains ${otherUsers} unrelated Auth user(s); refusing to alter them.`)
  sql(`DELETE FROM auth.users WHERE email='${email}';`)
  const password = randomBytes(24).toString('base64url')
  const userId = sql(`WITH created AS (INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current, phone_change_token, reauthentication_token, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${email}', extensions.crypt('${password}', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), false, false) RETURNING id, email) INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at) SELECT gen_random_uuid(), id, jsonb_build_object('sub', id::text, 'email', email), 'email', email, now(), now() FROM created RETURNING user_id;`)
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Isolated Auth preflight could not create the disposable account.')

  const authStart = Date.now()
  let authResponse: Response
  try {
    authResponse = await fetchWithTimeout(`${apiUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }, 45_000)
  } catch (error) {
    throw new Error(`Isolated password authentication did not respond within 45 seconds (${error instanceof Error ? error.message : String(error)}). DB/Auth/REST health had passed.`)
  }
  const authBody = await authResponse.json().catch(() => ({})) as { access_token?: string; user?: { id?: string }; error_description?: string; msg?: string }
  if (!authResponse.ok || authBody.user?.id !== userId || !authBody.access_token) {
    throw new Error(`Isolated password authentication failed with HTTP ${authResponse.status} after ${Date.now() - authStart}ms: ${authBody.error_description ?? authBody.msg ?? 'response identity/token mismatch'}.`)
  }

  const historyStart = Date.now()
  const history = await fetchWithTimeout(`${apiUrl}/rest/v1/progression_achievement_events?select=id&user_id=eq.${userId}&limit=1`, {
    headers: { apikey: anonKey, authorization: `Bearer ${authBody.access_token}` },
  }, 15_000)
  if (!history.ok) throw new Error(`Authenticated RLS history preflight failed with HTTP ${history.status}.`)

  await mkdir(dirname(fixturePath), { recursive: true })
  await writeFile(fixturePath, JSON.stringify({ userId, email, password }), { mode: 0o600 })
  await chmod(fixturePath, 0o600)
  process.env.SUPABASE_DB_CONTAINER = container
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/private/tmp/progression-playwright-browsers'
  process.stdout.write(`Isolated Supabase preflight passed: DB=${databaseName}, Auth=${authResponse.status} (${Date.now() - authStart}ms), scoped history=${history.status} (${Date.now() - historyStart}ms), Auth users=${sql('SELECT count(*) FROM auth.users;')}; setup=${Date.now() - dbStart}ms.\n`)
}
