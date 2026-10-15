import { defineConfig } from '@playwright/test'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/private/tmp/progression-playwright-browsers'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'goals-planning-local.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4182/ProgressTracker/',
    browserName: 'chromium',
    isMobile: true,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4182 --strictPort',
    url: 'http://127.0.0.1:4182/ProgressTracker/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
