import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'

const workdir = '/private/tmp/progresstracker-v8-sql-review-run2'
const repoRoot = process.cwd()
const apiUrl = 'http://127.0.0.1:65481'
const project = 'ptv8r2'
const containers = [`supabase_db_${project}`, `supabase_auth_${project}`, `supabase_kong_${project}`, `supabase_rest_${project}`]
const excludes = 'studio,realtime,storage-api,imgproxy,mailpit,postgres-meta,edge-runtime,logflare,vector,supavisor'
const diagnosticLines = []

function command(binary, args, timeout = 8_000) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${binary} exited ${result.status}`).trim())
  return (result.stdout ?? '').trim()
}

function redacted(value) {
  return value.replace(/("(?:ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|SECRET_KEY|PUBLISHABLE_KEY|DB_PASSWORD)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
}

function localResourceBudget() {
  const limit = Number(command('docker', ['info', '--format', '{{.MemTotal}}']))
  const stats = command('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}'])
  const usedMiB = stats.split(/\r?\n/).reduce((total, line) => {
    const amount = line.split('/')[0]?.trim() ?? ''
    const parsed = amount.match(/^([\d.]+)\s*(MiB|GiB|MB|GB)$/)
    if (!parsed) return total
    const value = Number(parsed[1])
    return total + value * (parsed[2] === 'GiB' || parsed[2] === 'GB' ? 1024 : 1)
  }, 0)
  const remainingMiB = Math.floor(limit / 1_048_576 - usedMiB)
  diagnosticLines.push(`Docker VM allocation: ${Math.floor(limit / 1_073_741_824 * 100) / 100} GiB; running container RSS: ${Math.round(usedMiB)} MiB; estimated VM headroom: ${remainingMiB} MiB.`)
  if (remainingMiB < 700) throw new Error(`Insufficient Docker VM headroom (${remainingMiB} MiB; require 700 MiB before adding this four-service stack).`)
}

async function prepareIsolatedSchema() {
  const migrationsDir = `${workdir}/supabase/migrations`
  const testsDir = `${workdir}/supabase/tests`
  await mkdir(migrationsDir, { recursive: true })
  await mkdir(testsDir, { recursive: true })
  await copyFile(`${repoRoot}/supabase/migrations/20261114000100_positive_value_streak_rule_comparisons.sql`, `${migrationsDir}/20261114000100_positive_value_streak_rule_comparisons.sql`)
  await copyFile(`${repoRoot}/supabase/migrations/20261114000200_validate_required_rule_kind_and_operator.sql`, `${migrationsDir}/20261114000200_validate_required_rule_kind_and_operator.sql`)
  await copyFile(`${repoRoot}/supabase/tests/progression_positive_value_streak_rule.test.sql`, `${testsDir}/progression_positive_value_streak_rule.test.sql`)
  diagnosticLines.push('Copied both forward migrations and the positive-value SQL regression into the dedicated ptv8r2 workdir.')
}

function extractSupabaseEnv(output) {
  for (const line of output.split(/\r?\n/)) {
    const start = line.indexOf('{')
    if (start < 0) continue
    try {
      const parsed = JSON.parse(line.slice(start))
      if (parsed.API_URL && parsed.ANON_KEY) return parsed
    } catch { /* Supabase also prints human-readable startup lines. */ }
  }
  throw new Error('Supabase start returned no local API credentials; captured output was redacted.')
}

async function waitFor(name, check, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs
  let last = 'not ready'
  let consecutive = 0
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result === true) {
        consecutive += 1
        if (consecutive === 2) {
          diagnosticLines.push(`${name}: ready (two consecutive probes).`)
          return
        }
      } else {
        last = String(result)
        consecutive = 0
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
      consecutive = 0
      if (error && typeof error === 'object' && 'permanent' in error) throw error
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750)
  }
  throw new Error(`${name} did not become ready within ${timeoutMs}ms; last probe: ${last}`)
}

function probeSql() {
  const result = spawnSync('docker', ['exec', containers[0], 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT current_database();'], { encoding: 'utf8', timeout: 5_000 })
  if (result.error) return String(result.error.message)
  return result.status === 0 && result.stdout.trim() === 'postgres' ? true : (result.stderr || result.stdout || `psql exited ${result.status}`).trim()
}

async function probeHttp(path, headers = {}) {
  try {
    const response = await fetch(`${apiUrl}${path}`, { headers, signal: AbortSignal.timeout(4_000) })
    if (response.ok) return true
    if (response.status >= 500) return `HTTP ${response.status}`
    const body = await response.text()
    try {
      const payload = JSON.parse(body)
      if (response.status === 401 && payload.code === '42501') return true
    } catch { /* Preserve a short response detail for other permanent HTTP errors. */ }
    const detail = body.slice(0, 240).replace(/[\r\n]+/g, ' ')
    const failure = new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    Object.assign(failure, { permanent: true })
    throw failure
  } catch (error) {
    if (error && typeof error === 'object' && 'permanent' in error) throw error
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}

async function saveServiceLogs(reason) {
  const parts = [`Local v8 Playwright service diagnostics\nReason: ${reason}\n${diagnosticLines.join('\n')}\n`]
  for (const name of containers) {
    const result = spawnSync('docker', ['logs', '--tail', '250', name], { encoding: 'utf8', timeout: 8_000 })
    parts.push(`\n===== ${name} =====\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  const path = `/private/tmp/ptv8r2-playwright-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
  await writeFile(path, redacted(parts.join('\n')), { mode: 0o600 })
  await chmod(path, 0o600)
  return path
}

function stopOwnStack() {
  const result = spawnSync('docker', ['stop', '--timeout', '5', ...containers], { encoding: 'utf8', timeout: 15_000 })
  if (result.error) diagnosticLines.push(`Could not stop only the ptv8r2 containers: ${result.error.message}`)
  else if (result.status !== 0) diagnosticLines.push(`Could not stop only the ptv8r2 containers: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`)
  else diagnosticLines.push('Stopped only the four ptv8r2 containers; preserved supabase_db_ptv8r2 volume.')
}

async function main() {
  await prepareIsolatedSchema()
  localResourceBudget()
  const started = spawnSync('supabase', ['start', '--workdir', workdir, '--exclude', excludes, '--ignore-health-check'], {
    encoding: 'utf8', timeout: 90_000, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  })
  const startupOutput = `${started.stdout ?? ''}\n${started.stderr ?? ''}`
  if (started.error || started.status !== 0) throw new Error(`Isolated Supabase startup failed: ${started.error?.message ?? redacted(startupOutput).slice(-2500)}`)
  const supabaseEnv = extractSupabaseEnv(startupOutput)
  if (supabaseEnv.API_URL !== apiUrl) throw new Error(`Refusing unexpected Supabase API URL ${supabaseEnv.API_URL}.`)
  diagnosticLines.push('Supabase CLI completed startup for the dedicated ptv8r2 workdir.')

  await waitFor('Postgres SQL', probeSql)
  await waitFor('Kong gateway process', () => {
    const result = spawnSync('docker', ['exec', containers[2], 'kong', 'health'], { encoding: 'utf8', timeout: 5_000 })
    return result.status === 0 ? true : (result.stderr || result.stdout || `kong health exited ${result.status}`).trim()
  })
  await waitFor('Auth through Kong', () => probeHttp('/auth/v1/health'))
  const restHeaders = { apikey: supabaseEnv.ANON_KEY, authorization: `Bearer ${supabaseEnv.ANON_KEY}` }
  await waitFor('PostgREST route through Kong', () => probeHttp('/rest/v1/trackers?select=id&limit=0', restHeaders))
  const migrations = spawnSync('supabase', ['migration', 'up', '--local', '--workdir', workdir], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  })
  const migrationOutput = `${migrations.stdout ?? ''}${migrations.stderr ?? ''}`
  if (migrations.error || migrations.status !== 0) throw new Error(`Isolated local Supabase migration failed: ${migrations.error?.message ?? redacted(migrationOutput).slice(-4000)}`)
  diagnosticLines.push('Applied pending migrations to the isolated local database with --local; no linked project is used.')
  const sqlTests = spawnSync('supabase', ['test', 'db', '--local', '--workdir', workdir], {
    encoding: 'utf8', timeout: 180_000, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  })
  const sqlOutput = `${sqlTests.stdout ?? ''}${sqlTests.stderr ?? ''}`
  if (sqlTests.error || sqlTests.status !== 0) {
    const failures = sqlOutput.split(/\r?\n/).filter((line) => /^\s*not ok\b|\b(?:ERROR|FAIL(?:ED)?)\b/i.test(line))
    const details = failures.length ? failures.join('\n') : redacted(sqlOutput).slice(-4000)
    throw new Error(`Local Supabase SQL regression suite failed: ${sqlTests.error?.message ?? details}`)
  }
  diagnosticLines.push('Local Supabase migration applied; the full database pgTAP suite passed.')
  process.stdout.write(`${diagnosticLines.join('\n')}\n`)

  const playwright = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.streak-rules-local.config.ts', ...process.argv.slice(2)], {
    stdio: 'inherit', env: {
      ...process.env,
      PROGRESSION_TEST_API_URL: apiUrl,
      PROGRESSION_TEST_ANON_KEY: supabaseEnv.ANON_KEY,
      PROGRESSION_TEST_DB_CONTAINER: containers[0],
      PROGRESSION_TEST_FIXTURE_PATH: '/private/tmp/progresstracker-v8-sql-review-run2-auth.json',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/private/tmp/progression-playwright-browsers',
    },
  })
  if (playwright.error || playwright.status !== 0) {
    const logs = await saveServiceLogs(`Playwright exited ${playwright.status ?? 'with an error'}`)
    process.stderr.write(`Isolated service diagnostics saved to ${logs}\n`)
  }
  stopOwnStack()
  process.exitCode = playwright.status ?? 1
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`v8 local browser preflight failed: ${message}\n`)
  try {
    const logs = await saveServiceLogs(message)
    process.stderr.write(`Isolated service diagnostics saved to ${logs}\n`)
  } catch (logError) {
    process.stderr.write(`Could not collect service logs: ${logError instanceof Error ? logError.message : String(logError)}\n`)
  }
  stopOwnStack()
  process.exitCode = 1
})
