import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync('/private/tmp/progression-playwright-auth.json', 'utf8')) as { userId: string; email: string; password: string }

test('isolated password Auth establishes a scoped progression session in AppShell', async ({ page }, testInfo) => {
  const requests: Array<{ path: string; status?: number; elapsedMs: number; failure?: string }> = []
  const started = new Map<string, number>()
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/auth/v1/')) started.set(request.url(), Date.now())
  })
  page.on('requestfinished', async (request) => {
    if (!new URL(request.url()).pathname.startsWith('/auth/v1/')) return
    const response = await request.response()
    requests.push({ path: new URL(request.url()).pathname, status: response?.status(), elapsedMs: Date.now() - (started.get(request.url()) ?? Date.now()) })
    started.delete(request.url())
  })
  page.on('requestfailed', (request) => {
    if (!new URL(request.url()).pathname.startsWith('/auth/v1/')) return
    requests.push({ path: new URL(request.url()).pathname, elapsedMs: Date.now() - (started.get(request.url()) ?? Date.now()), failure: request.failure()?.errorText ?? 'request failed' })
    started.delete(request.url())
  })

  await page.goto('/#/auth')
  await page.getByRole('button', { name: 'Use password' }).click()
  await page.getByLabel('Email address').last().fill(fixture.email)
  await page.getByLabel('Password').fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  try {
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 50_000 })
  } catch (error) {
    await testInfo.attach('auth-diagnostics.json', { body: JSON.stringify({ requests, pending: [...started.keys()].map((url) => new URL(url).pathname), body: await page.locator('body').innerText().catch(() => '') }, null, 2), contentType: 'application/json' })
    throw new Error(`Isolated browser password sign-in failed to establish AppShell: ${JSON.stringify(requests)}; pending=${[...started.keys()].map((url) => new URL(url).pathname).join(',') || 'none'}; ${error instanceof Error ? error.message : String(error)}`)
  }
  const state = await page.evaluate(async () => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const { data: { session }, error: sessionError } = await client.auth.getSession()
    if (!session?.user) return { userId: null, sessionError: sessionError?.message ?? null, historyStatus: null }
    const { data, error } = await client.from('progression_achievement_events').select('id').eq('user_id', session.user.id).limit(1)
    return { userId: session.user.id, sessionError: sessionError?.message ?? null, historyStatus: error ? error.code : 'ok', rows: data?.length ?? 0 }
  })
  expect(state.userId).toBe(fixture.userId)
  expect(state.historyStatus).toBe('ok')
  expect(requests.some((request) => request.path === '/auth/v1/token' && request.status === 200)).toBe(true)
})
