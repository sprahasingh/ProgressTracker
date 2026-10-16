import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = process.cwd()
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
const nonce = randomBytes(3).toString('hex')
const projectId = `rule-history-${stamp}-${nonce}`
const workdir = `/private/tmp/${projectId}`
const fixturePath = `/private/tmp/${projectId}-playwright-auth.json`
const outputDir = `/private/tmp/${projectId}-playwright-artifacts`
const resultPath = `/private/tmp/${projectId}-playwright-results.json`
const logPath = `/private/tmp/${projectId}-services.log`
const startupLogPath = `/private/tmp/${projectId}-startup.log`
const databaseContainer = `supabase_db_${projectId}`
const containers = [`supabase_db_${projectId}`, `supabase_auth_${projectId}`, `supabase_kong_${projectId}`, `supabase_rest_${projectId}`]
const excludes = 'studio,realtime,storage-api,imgproxy,mailpit,postgres-meta,edge-runtime,logflare,vector,supavisor'
const diagnostics = []
let apiPort
let dbPort
let stackAttempted = false
let stackStopped = false
let networkReleased = false

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 15_000,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', ...options.env },
    stdio: options.stdio ?? 'pipe',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${binary} exited ${result.status}`).trim())
  return result.stdout ?? ''
}

function redact(value) {
  return value.replace(/("(?:ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|SECRET_KEY|PUBLISHABLE_KEY|DB_PASSWORD)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
}

function dockerMemoryHeadroom() {
  const totalBytes = Number(run('docker', ['info', '--format', '{{.MemTotal}}']).trim())
  const stats = run('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}'])
  const usedMiB = stats.split(/\r?\n/).reduce((sum, line) => {
    const amount = line.split('/')[0]?.trim() ?? ''
    const parsed = amount.match(/^([\d.]+)\s*(MiB|GiB|MB|GB)$/)
    if (!parsed) return sum
    return sum + Number(parsed[1]) * (parsed[2] === 'GiB' || parsed[2] === 'GB' ? 1024 : 1)
  }, 0)
  const remainingMiB = Math.floor(totalBytes / 1_048_576 - usedMiB)
  diagnostics.push(`Docker VM ${Math.floor(totalBytes / 1_073_741_824 * 100) / 100} GiB; container RSS ${Math.round(usedMiB)} MiB; estimated headroom ${remainingMiB} MiB.`)
  if (remainingMiB < 700) throw new Error(`Refusing to add a local stack with only ${remainingMiB} MiB Docker VM headroom; at least 700 MiB is required.`)
}

function assertContainerNamesUnused() {
  const names = run('docker', ['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/).filter(Boolean)
  const collisions = containers.filter((name) => names.includes(name))
  if (collisions.length) throw new Error(`Refusing to reuse existing containers: ${collisions.join(', ')}`)
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function allocatePortSet(start) {
  for (let offset = 0; offset < 200; offset += 1) {
    const api = start + offset
    const ports = [api - 1, api, api + 1, api + 2]
    const availability = await Promise.all(ports.map(portIsFree))
    if (availability.every(Boolean)) return { api, db: api + 1, shadow: api - 1, studio: api + 2 }
  }
  throw new Error(`Could not find four consecutive free local ports starting at ${start}.`)
}

async function prepareIsolatedProject() {
  const ports = await allocatePortSet(60800)
  apiPort = ports.api
  dbPort = ports.db
  const supabaseDir = join(workdir, 'supabase')
  await mkdir(join(supabaseDir, 'migrations'), { recursive: true })
  await mkdir(join(supabaseDir, 'tests'), { recursive: true })

  const migrationFiles = (await readdir(join(repoRoot, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort()
  const testFiles = (await readdir(join(repoRoot, 'supabase/tests'))).filter((name) => name.endsWith('.sql')).sort()
  if (!migrationFiles.length || !testFiles.length) throw new Error('The repository Supabase migration or pgTAP directory is unexpectedly empty.')
  for (const name of migrationFiles) await cp(join(repoRoot, 'supabase/migrations', name), join(supabaseDir, 'migrations', name), { errorOnExist: true })
  for (const name of testFiles) await cp(join(repoRoot, 'supabase/tests', name), join(supabaseDir, 'tests', name), { errorOnExist: true })

  const functionConfig = await readFile(join(repoRoot, 'supabase/config.toml'), 'utf8')
  const config = `project_id = "${projectId}"

[api]
enabled = true
port = ${apiPort}
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = ${dbPort}
shadow_port = ${ports.shadow}
health_timeout = "2m"
major_version = 17

[db.pooler]
enabled = false

[db.migrations]
enabled = true

[db.seed]
enabled = false

[studio]
enabled = true
port = ${ports.studio}
api_url = "http://127.0.0.1"

${functionConfig.replace(/^project_id\s*=.*(?:\r?\n|$)/m, '')}`
  await writeFile(join(supabaseDir, 'config.toml'), config, { mode: 0o600, flag: 'wx' })
  diagnostics.push(`Prepared a fresh temporary Supabase project with ${migrationFiles.length} migrations, ${testFiles.length} pgTAP files, API ${apiPort}, and DB ${dbPort}.`)
}

function parseSupabaseEnv(output) {
  for (const line of output.split(/\r?\n/)) {
    const start = line.indexOf('{')
    if (start < 0) continue
    try {
      const parsed = JSON.parse(line.slice(start))
      if (parsed.API_URL && parsed.ANON_KEY) return parsed
    } catch { /* The CLI also prints readable progress lines. */ }
  }
  throw new Error('Supabase startup did not return local API credentials.')
}

async function waitFor(label, check, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs
  let last = 'not ready'
  let passes = 0
  while (Date.now() < until) {
    try {
      const result = await check()
      if (result === true) {
        passes += 1
        if (passes === 2) { diagnostics.push(`${label}: ready on two probes.`); return }
      } else { last = String(result); passes = 0 }
    } catch (error) { last = error instanceof Error ? error.message : String(error); passes = 0 }
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new Error(`${label} did not become ready; last probe: ${last}`)
}

async function httpOk(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(4_000) })
  if (response.ok) return true
  if (response.status >= 500) return `HTTP ${response.status}`
  const detail = (await response.text()).slice(0, 180).replace(/[\r\n]+/g, ' ')
  return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`
}

async function postgrestReady(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(4_000) })
  if (response.ok) return true
  if (response.status >= 500) return `HTTP ${response.status}`
  if (response.status === 401) {
    const body = await response.json().catch(() => ({}))
    if (body.code === '42501') return true
  }
  const detail = (await response.text().catch(() => '')).slice(0, 180).replace(/[\r\n]+/g, ' ')
  return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`
}

function querySql(query) {
  return run('docker', ['exec', databaseContainer, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', query], { timeout: 10_000 }).trim()
}

function assertEmptyDedicatedDatabase() {
  const counts = querySql(`select jsonb_build_object(
    'auth_users',(select count(*) from auth.users),
    'trackers',(select count(*) from public.trackers),
    'entries',(select count(*) from public.tracker_entries),
    'progression_events',(select count(*) from public.progression_events),
    'achievement_events',(select count(*) from public.progression_achievement_events)
  )::text;`)
  const parsed = JSON.parse(counts)
  if (Object.values(parsed).some((count) => Number(count) !== 0)) throw new Error(`The new local database was not empty after migrations; refusing browser setup: ${counts}`)
  diagnostics.push('Empty-data preflight passed for Auth users, trackers, entries, XP events, and achievement events.')
}

async function saveDiagnostics(reason) {
  const output = [`Versioned tracker rule history local test diagnostics\nReason: ${reason}\n${diagnostics.join('\n')}\n`]
  for (const container of containers) {
    const result = spawnSync('docker', ['logs', '--tail', '250', container], { encoding: 'utf8', timeout: 10_000 })
    if (result.status === 0) output.push(`\n===== ${container} =====\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  await writeFile(logPath, redact(output.join('\n')), { mode: 0o600 })
  diagnostics.push(`Service log saved to ${logPath}`)
}

function stopOwnContainers() {
  if (!stackAttempted || stackStopped) return
  const result = spawnSync('docker', ['stop', '--timeout', '8', ...containers], { encoding: 'utf8', timeout: 20_000 })
  if (result.status === 0) {
    stackStopped = true
    diagnostics.push(`Stopped only this run's four containers; its Docker volume was preserved.`)
  }
  else diagnostics.push(`Could not stop the named stack cleanly: ${(result.stderr || result.stdout || result.error?.message || 'unknown Docker error').trim()}`)
}

function releaseOwnNetwork() {
  if (networkReleased) return
  const network = `supabase_network_${projectId}`
  const inspected = spawnSync('docker', ['network', 'inspect', '--format', '{{len .Containers}}', network], { encoding: 'utf8', timeout: 10_000 })
  if (inspected.status !== 0) {
    networkReleased = true
    diagnostics.push(`The isolated run network ${network} was already absent.`)
    return
  }
  if (inspected.stdout.trim() !== '0') {
    diagnostics.push(`Preserved the isolated network ${network} because Docker still reports attached containers.`)
    return
  }
  const removed = spawnSync('docker', ['network', 'rm', network], { encoding: 'utf8', timeout: 10_000 })
  if (removed.status === 0) {
    networkReleased = true
    diagnostics.push(`Removed only this run's empty network ${network}; its Docker volume was preserved.`)
  } else diagnostics.push(`Could not remove the empty isolated network ${network}: ${(removed.stderr || removed.stdout || removed.error?.message || 'unknown Docker error').trim()}`)
}

async function main() {
  if (projectId.length > 40) throw new Error(`Refusing project ID longer than Supabase's 40-character container name limit: ${projectId}`)
  dockerMemoryHeadroom()
  assertContainerNamesUnused()
  await prepareIsolatedProject()
  const apiUrl = `http://127.0.0.1:${apiPort}`
  stackAttempted = true
  const started = spawnSync('supabase', ['start', '--workdir', workdir, '--exclude', excludes, '--ignore-health-check', '--debug'], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  })
  const startupOutput = `${started.stdout ?? ''}\n${started.stderr ?? ''}`
  await writeFile(startupLogPath, redact(startupOutput), { mode: 0o600 })
  if (started.error || started.status !== 0) throw new Error(`Dedicated local Supabase startup failed; full redacted startup output is ${startupLogPath}: ${started.error?.message ?? redact(startupOutput).slice(-3000)}`)
  const supabaseEnv = parseSupabaseEnv(startupOutput)
  if (supabaseEnv.API_URL !== apiUrl) throw new Error(`Refusing API URL outside this run's loopback port: ${supabaseEnv.API_URL}`)
  diagnostics.push(`Supabase CLI started the unique local project ${projectId}.`)

  await waitFor('Postgres', () => querySql('select current_database();') === 'postgres')
  await waitFor('Auth', () => httpOk(`${apiUrl}/auth/v1/health`))
  const headers = { apikey: supabaseEnv.ANON_KEY, authorization: `Bearer ${supabaseEnv.ANON_KEY}` }
  await waitFor('PostgREST', () => postgrestReady(`${apiUrl}/rest/v1/trackers?select=id&limit=0`, headers))

  const migrationResult = spawnSync('supabase', ['migration', 'up', '--local', '--workdir', workdir], {
    encoding: 'utf8', timeout: 180_000, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  })
  const migrationText = `${migrationResult.stdout ?? ''}${migrationResult.stderr ?? ''}`
  await writeFile(`/private/tmp/${projectId}-migrations.log`, redact(migrationText), { mode: 0o600 })
  if (migrationResult.error || migrationResult.status !== 0) throw new Error(`Local migration failed: ${migrationResult.error?.message ?? redact(migrationText).slice(-5000)}`)
  diagnostics.push('All forward migrations applied locally with --local; no linked project is used.')

  const pgTapResult = spawnSync('supabase', ['test', 'db', '--local', '--workdir', workdir], {
    encoding: 'utf8', timeout: 240_000, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  })
  const pgTapText = `${pgTapResult.stdout ?? ''}${pgTapResult.stderr ?? ''}`
  const pgTapPath = `/private/tmp/${projectId}-pgtap.log`
  await writeFile(pgTapPath, redact(pgTapText), { mode: 0o600 })
  if (pgTapResult.error || pgTapResult.status !== 0) {
    const failures = pgTapText.split(/\r?\n/).filter((line) => /^\s*not ok\b|\b(?:ERROR|FAIL(?:ED)?)\b/i.test(line))
    throw new Error(`Local pgTAP suite failed (${failures.join('\n') || pgTapPath}).`)
  }
  diagnostics.push(`Full local pgTAP suite passed; captured output is ${pgTapPath}.`)
  assertEmptyDedicatedDatabase()

  const env = {
    ...process.env,
    PROGRESSION_TEST_API_URL: apiUrl,
    PROGRESSION_TEST_ANON_KEY: supabaseEnv.ANON_KEY,
    PROGRESSION_TEST_DB_CONTAINER: databaseContainer,
    PROGRESSION_TEST_FIXTURE_PATH: fixturePath,
    PROGRESSION_RULE_HISTORY_PROJECT_ID: projectId,
    PROGRESSION_RULE_HISTORY_OUTPUT_DIR: outputDir,
    PROGRESSION_RULE_HISTORY_RESULT_PATH: resultPath,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/private/tmp/progression-playwright-browsers',
  }
  const browserResult = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.rule-history-local.config.ts', ...process.argv.slice(2)], {
    encoding: 'utf8', timeout: 600_000, stdio: 'inherit', env,
  })
  if (browserResult.error || browserResult.status !== 0) throw new Error(`Focused versioned-rule Playwright suite exited ${browserResult.status ?? 'with an error'}${browserResult.error ? `: ${browserResult.error.message}` : ''}.`)
  const report = JSON.parse(await readFile(resultPath, 'utf8'))
  const stats = report.stats ?? {}
  diagnostics.push(`Playwright counts: passed ${stats.expected ?? 0}, failed ${stats.unexpected ?? 0}, flaky ${stats.flaky ?? 0}, skipped ${stats.skipped ?? 0}, interrupted ${stats.interrupted ?? 0}.`)
  diagnostics.push(`Playwright JSON report: ${resultPath}; browser artifacts: ${outputDir}.`)
  stopOwnContainers()
  releaseOwnNetwork()
  process.stdout.write(`${diagnostics.join('\n')}\n`)
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Versioned rule history verification failed: ${message}\n`)
  try { await saveDiagnostics(message) } catch (logError) { process.stderr.write(`Could not write diagnostics: ${logError instanceof Error ? logError.message : String(logError)}\n`) }
  stopOwnContainers()
  releaseOwnNetwork()
  process.stderr.write(`${diagnostics.join('\n')}\n`)
  process.exitCode = 1
})
