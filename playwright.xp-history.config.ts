import { execFileSync } from 'node:child_process'
import { defineConfig, devices } from '@playwright/test'

const supabaseWorkdir = process.env.PROGRESSION_TEST_SUPABASE_WORKDIR ?? '/private/tmp/progression-xp-history-e2e'
const expectedApiUrl = process.env.PROGRESSION_TEST_API_URL ?? 'http://127.0.0.1:64421'
const databaseContainer = process.env.PROGRESSION_TEST_DB_CONTAINER ?? 'supabase_db_progression-xp-history-e2e'
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
  throw new Error(`The XP History browser suite requires its dedicated local Supabase project at ${expectedApiUrl}.`)
}

process.env.PROGRESSION_TEST_API_URL = apiUrl
process.env.PROGRESSION_TEST_ANON_KEY = anonKey
process.env.PROGRESSION_TEST_FIXTURE_PATH ??= '/private/tmp/progression-xp-history-playwright-auth.json'
process.env.SUPABASE_DB_CONTAINER = databaseContainer
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/private/tmp/progression-playwright-browsers'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['xp-history.spec.ts'],
  globalSetup: './e2e/globalSetup.ts',
  globalTeardown: './e2e/globalTeardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 12_000 },
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4187/ProgressTracker/',
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4187 --strictPort',
    url: 'http://127.0.0.1:4187/ProgressTracker/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_SUPABASE_URL: apiUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
      VITE_ENABLE_PROGRESSION_UI: 'true',
    },
  },
})
