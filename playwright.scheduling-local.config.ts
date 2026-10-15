import { execFileSync } from 'node:child_process'
import { defineConfig, devices } from '@playwright/test'

const supabaseWorkdir = '/private/tmp/progresstracker-scheduling-pre-release'
const expectedApiUrl = 'http://127.0.0.1:65421'
const databaseContainer = 'supabase_db_progresstracker-scheduling-pre-release-2'
const statusOutput = execFileSync('supabase', ['status', '--workdir', supabaseWorkdir, '--output', 'env'], {
  encoding: 'utf8',
  env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: 'true' },
})
const status = Object.fromEntries(statusOutput.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^([A-Z_]+)="(.*)"$/)
  return match ? [[match[1]!, match[2]!]] : []
})) as Record<string, string>

if (status.API_URL !== expectedApiUrl || !status.ANON_KEY) {
  throw new Error(`Scheduling E2E requires the isolated local API at ${expectedApiUrl}.`)
}

process.env.SUPABASE_DB_CONTAINER = databaseContainer
process.env.PROGRESSION_TEST_SUPABASE_WORKDIR = supabaseWorkdir
process.env.PROGRESSION_TEST_DB_CONTAINER = databaseContainer
process.env.PROGRESSION_TEST_API_URL = expectedApiUrl
process.env.PROGRESSION_TEST_FIXTURE_PATH = '/private/tmp/progresstracker-scheduling-pre-release-auth.json'
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/private/tmp/progression-playwright-browsers'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'scheduling-pre-release.spec.ts',
  globalSetup: './e2e/globalSetup.ts',
  globalTeardown: './e2e/globalTeardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 12_000 },
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4179/ProgressTracker/',
    viewport: { width: 390, height: 844 },
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/ProgressTracker/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_SUPABASE_URL: expectedApiUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY,
      VITE_ENABLE_TRACKER_SCHEMA_V6: 'true',
    },
  },
})
