import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const projectId = 'progression-tracker-edit-e2e'
const projectRoot = '/private/tmp/progression-tracker-edit-e2e'
const markerPath = join(projectRoot, 'TRACKER_EDIT_E2E_LOCAL_ONLY')
const configPath = join(projectRoot, 'supabase', 'config.toml')
const migrationsPath = join(projectRoot, 'supabase', 'migrations')
const sourceMigrationsPath = resolve('supabase/migrations')
const expectedConfig = `project_id = "${projectId}"

[api]
enabled = true
port = 55481
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 55482
shadow_port = 55480
major_version = 17
health_timeout = "2m"

[db.pooler]
enabled = false
port = 55489

[db.migrations]
enabled = true
schema_paths = []

[db.seed]
enabled = false
sql_paths = ["./seed.sql"]

[studio]
enabled = false

[local_smtp]
enabled = false

[storage]
enabled = false

[realtime]
enabled = false

[analytics]
enabled = false

[edge_runtime]
enabled = false

[auth]
enabled = true
site_url = "http://127.0.0.1:4188/ProgressTracker/"
enable_signup = true

[auth.email]
enable_confirmations = false
`

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function prepareProject() {
  if (existsSync(projectRoot)) {
    if (lstatSync(projectRoot).isSymbolicLink()) fail(`Refusing to use a symlink for the isolated Supabase workdir: ${projectRoot}`)
    if (!existsSync(markerPath) || readFileSync(markerPath, 'utf8') !== `${projectId}\n`) {
      fail(`Refusing to overwrite the pre-existing Supabase workdir at ${projectRoot}; it has no matching local-only marker.`)
    }
    if (!existsSync(configPath) || readFileSync(configPath, 'utf8') !== expectedConfig) {
      fail(`The marked Tracker Edit Supabase config at ${configPath} differs from this runner; no files or volumes were changed.`)
    }
  } else {
    mkdirSync(join(projectRoot, 'supabase'), { recursive: true })
    writeFileSync(configPath, expectedConfig, { flag: 'wx' })
    writeFileSync(markerPath, `${projectId}\n`, { flag: 'wx', mode: 0o600 })
  }

  mkdirSync(migrationsPath, { recursive: true })
  for (const name of readdirSync(sourceMigrationsPath).filter((item) => item.endsWith('.sql')).sort()) {
    const source = join(sourceMigrationsPath, name)
    const target = join(migrationsPath, name)
    if (existsSync(target)) {
      if (!readFileSync(source).equals(readFileSync(target))) fail(`Migration ${target} differs from the repository copy; refusing to overwrite a migration in the isolated database workdir.`)
    } else {
      writeFileSync(target, readFileSync(source), { flag: 'wx' })
    }
  }
}

prepareProject()

const start = spawnSync('supabase', ['start', '--workdir', projectRoot], {
  encoding: 'utf8',
  env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
})
const redactedStartOutput = `${start.stdout ?? ''}${start.stderr ?? ''}`.replace(/"(DB_URL|PUBLISHABLE_KEY|SECRET_KEY|JWT_SECRET|ANON_KEY|SERVICE_ROLE_KEY)":"[^"]*"/g, '"$1":"[redacted]"')
if (redactedStartOutput) process.stdout.write(redactedStartOutput)
if (start.status !== 0) fail(`Could not start the dedicated local Tracker Edit Supabase project (exit ${start.status ?? 'unknown'}). Existing projects and volumes were left untouched.`)

const result = spawnSync('./node_modules/.bin/playwright', ['test', '--config', 'playwright.tracker-edit.config.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SUPABASE_TELEMETRY_DISABLED: '1',
    PROGRESSION_TEST_SUPABASE_WORKDIR: projectRoot,
    PROGRESSION_TEST_API_URL: 'http://127.0.0.1:55481',
    PROGRESSION_TEST_DB_CONTAINER: 'supabase_db_progression-tracker-edit-e2e',
    PROGRESSION_TEST_FIXTURE_PATH: '/private/tmp/progression-tracker-edit-playwright-auth.json',
  },
  stdio: 'inherit',
})

if (result.error) {
  process.stderr.write(`Could not launch the focused Tracker Edit Playwright suite: ${result.error.message}\n`)
  process.exit(1)
}

process.exitCode = result.status ?? 1
