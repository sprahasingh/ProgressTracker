import { execFileSync } from 'node:child_process'
import { defineConfig, devices } from '@playwright/test'

const supabaseWorkdir = process.env.PROGRESSION_TEST_SUPABASE_WORKDIR ?? '/private/tmp/progression-tracker-edit-e2e'
const expectedApiUrl = process.env.PROGRESSION_TEST_API_URL ?? 'http://127.0.0.1:55481'
const databaseContainer = process.env.PROGRESSION_TEST_DB_CONTAINER ?? 'supabase_db_progression-tracker-edit-e2e'
const statusOutput = execFileSync('supabase', ['status', '--workdir', supabaseWorkdir, '--output', 'env'], {
  encoding: 'utf8',
  env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
})
const status = Object.fromEntries(statusOutput.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^([A-Z_]+)="(.*)"$/)
  return match ? [[match[1]!, match[2]!]] : []
})) as Record<string, string>
const apiUrl = status.API_URL
const anonKey = status.ANON_KEY

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(expectedApiUrl) || apiUrl !== expectedApiUrl || !anonKey) {
  throw new Error(`The Tracker Edit browser suite requires its dedicated local Supabase project at ${expectedApiUrl}.`)
}

process.env.PROGRESSION_TEST_API_URL = apiUrl
process.env.PROGRESSION_TEST_ANON_KEY = anonKey
process.env.PROGRESSION_TEST_FIXTURE_PATH ??= '/private/tmp/progression-tracker-edit-playwright-auth.json'
process.env.SUPABASE_DB_CONTAINER = databaseContainer
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/private/tmp/progression-playwright-browsers'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['tracker-edit.spec.ts'],
  globalSetup: './e2e/globalSetup.ts',
  globalTeardown: './e2e/globalTeardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    timezoneId: 'Asia/Calcutta',
    baseURL: 'http://127.0.0.1:4188/ProgressTracker/',
    viewport: { width: 390, height: 844 },
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4188 --strictPort',
    url: 'http://127.0.0.1:4188/ProgressTracker/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_SUPABASE_URL: apiUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
      VITE_ENABLE_TRACKER_SCHEMA_V4: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V5: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V6: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V7: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V8: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V9: 'true',
    },
  },
})
