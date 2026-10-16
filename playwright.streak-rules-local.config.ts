import { defineConfig, devices } from '@playwright/test'

const expectedApiUrl = 'http://127.0.0.1:65481'
const databaseContainer = 'supabase_db_ptv8r2'
const apiUrl = process.env.PROGRESSION_TEST_API_URL
const anonKey = process.env.PROGRESSION_TEST_ANON_KEY

if (apiUrl !== expectedApiUrl || !anonKey) {
  throw new Error(`Run npm run test:e2e:streak-rules-local to start and verify the isolated API at ${expectedApiUrl}.`)
}

process.env.SUPABASE_DB_CONTAINER = databaseContainer
process.env.PROGRESSION_TEST_DB_CONTAINER = databaseContainer
process.env.PROGRESSION_TEST_API_URL = expectedApiUrl
process.env.PROGRESSION_TEST_FIXTURE_PATH = '/private/tmp/progresstracker-v8-sql-review-run2-auth.json'
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/private/tmp/progression-playwright-browsers'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['streak-rules-v8.spec.ts', 'typed-milestones-v9.spec.ts'],
  globalSetup: './e2e/globalSetup.ts',
  globalTeardown: './e2e/globalTeardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
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
      VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
      VITE_ENABLE_TRACKER_SCHEMA_V6: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V7: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V8: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V9: 'true',
    },
  },
})
