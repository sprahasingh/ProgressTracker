import { defineConfig, devices } from '@playwright/test'

const apiUrl = process.env.PROGRESSION_TEST_API_URL
const projectId = process.env.PROGRESSION_RULE_HISTORY_PROJECT_ID
const databaseContainer = process.env.PROGRESSION_TEST_DB_CONTAINER
const anonKey = process.env.PROGRESSION_TEST_ANON_KEY
const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH
const outputDir = process.env.PROGRESSION_RULE_HISTORY_OUTPUT_DIR
const reportPath = process.env.PROGRESSION_RULE_HISTORY_RESULT_PATH

if (!apiUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl)
  || !projectId || projectId.length > 40 || !/^rule-history-[a-z0-9-]+$/.test(projectId)
  || databaseContainer !== `supabase_db_${projectId}`
  || !anonKey || !fixturePath?.startsWith('/private/tmp/')
  || !outputDir?.startsWith('/private/tmp/') || !reportPath?.startsWith('/private/tmp/')) {
  throw new Error('The versioned rule history browser suite requires the dedicated isolated local Supabase runner.')
}

process.env.SUPABASE_DB_CONTAINER = databaseContainer
process.env.PROGRESSION_TEST_DB_CONTAINER = databaseContainer
process.env.PROGRESSION_TEST_API_URL = apiUrl
process.env.PROGRESSION_TEST_FIXTURE_PATH = fixturePath
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/private/tmp/progression-playwright-browsers'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['versioned-rule-history-v10.spec.ts', 'xp-history.spec.ts'],
  globalSetup: './e2e/globalSetup.ts',
  globalTeardown: './e2e/globalTeardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['line'], ['json', { outputFile: reportPath }]],
  outputDir,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4179/ProgressTracker/',
    viewport: { width: 1280, height: 900 },
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/ProgressTracker/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_SUPABASE_URL: apiUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
      VITE_ENABLE_PROGRESSION_UI: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V6: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V7: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V8: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V9: 'true',
      VITE_ENABLE_TRACKER_SCHEMA_V10: 'true',
    },
  },
})
