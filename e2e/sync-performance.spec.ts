import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('local-first and batched synchronization stay responsive offline and on a slow connection', async ({ page, context }) => {
  const fixture = JSON.parse(readFileSync('/private/tmp/progression-playwright-auth.json', 'utf8')) as { userId: string; email: string; password: string }
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  const calls: Array<{ path: string; status?: number; elapsedMs: number; failed?: boolean }> = []
  const started = new Map<string, number>()
  let measuring = false
  page.on('request', (request) => {
    if (!measuring) return
    const path = new URL(request.url()).pathname
    if (/\/(?:auth\/v1\/user|rest\/v1)(?:\/|$)/.test(path)) started.set(request.url(), performance.now())
  })
  page.on('requestfinished', async (request) => {
    const at = started.get(request.url())
    if (at === undefined) return
    const response = await request.response()
    calls.push({ path: new URL(request.url()).pathname, status: response?.status(), elapsedMs: Math.round(performance.now() - at) })
    started.delete(request.url())
  })
  page.on('requestfailed', (request) => {
    const at = started.get(request.url())
    if (at === undefined) return
    calls.push({ path: new URL(request.url()).pathname, elapsedMs: Math.round(performance.now() - at), failed: true })
    started.delete(request.url())
  })
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  await page.goto('/#/auth')
  await page.getByRole('button', { name: 'Use password' }).click()
  await page.getByLabel('Email address').last().fill(fixture.email)
  await page.getByLabel('Password').fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 50_000 })
  await page.getByRole('link', { name: 'Today', exact: true }).first().click()
  await page.getByRole('link', { name: 'Trackers', exact: true }).first().click()
  await page.getByRole('link', { name: /Create tracker/ }).first().click()
  await page.getByLabel('What habit do you want to build?').fill('Sync performance fixture')
  const trackerStartDate = await page.evaluate(async () => {
    const dates = await import('/ProgressTracker/src/features/shared/localDates.ts')
    return dates.shiftCalendarDate(dates.localCalendarDate(new Date(), 'UTC'), -3)
  })
  await page.getByLabel('Start date').fill(trackerStartDate)
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: 'Sync performance fixture' })).toBeVisible()
  const trackerId = await page.evaluate(async () => (await (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository.listTrackers()).find((item) => item.name === 'Sync performance fixture')!.id)
  await expect.poll(async () => page.evaluate(async (id) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const { data: { session } } = await client.auth.getSession()
    const { data, error } = await client.from('trackers').select('id').eq('user_id', session!.user.id).eq('id', id).maybeSingle()
    if (error) throw new Error(`Initial tracker sync check failed (${error.code ?? 'unknown'}).`)
    return Boolean(data?.id)
  }, trackerId), { timeout: 30_000 }).toBe(true)
  await expect(page.locator('.topbar-sync-state')).toHaveAttribute('aria-label', /Synced/, { timeout: 30_000 })
  await page.getByRole('link', { name: 'Today', exact: true }).first().click()
  await page.getByRole('button', { name: /Open Sync performance fixture/ }).click()
  await expect(page.getByRole('button', { name: 'Save check-in' })).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  const localStartedAt = performance.now()
  await page.getByRole('button', { name: 'Save check-in' }).click()
  await expect(page.getByText(/Saved on this device/)).toBeVisible()
  const localCheckInMs = Math.round(performance.now() - localStartedAt)
  await page.getByRole('button', { name: 'Close check-in details' }).click()

  const localData = await page.evaluate(async () => {
    const repository = await import('/ProgressTracker/src/db/localRepository.ts')
    const dates = await import('/ProgressTracker/src/features/shared/localDates.ts')
    const tracker = (await repository.localRepository.listTrackers()).find((item) => item.name === 'Sync performance fixture')!
    const date = dates.localCalendarDate(new Date(), 'UTC')
    const metricId = tracker.metrics[0]!.id
    for (let offset = -1; offset >= -3; offset -= 1) {
      await repository.localRepository.saveTrackerEntry({ trackerId: tracker.id, date: dates.shiftCalendarDate(date, offset), outcome: 'recorded', values: { [metricId]: true }, note: 'offline performance fixture' })
    }
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const { data: { session } } = await client.auth.getSession()
    const database = await import('/ProgressTracker/src/db/database.ts')
    const pending = await database.db.syncOperations.where('ownerUserId').equals(session!.user.id).filter((operation) => operation.status === 'pending').count()
    return { trackerId: tracker.id, userId: session!.user.id, pending }
  })
  expect(localData.userId).toBe(fixture.userId)
  // Four check-ins remain queued while offline; the tracker was confirmed first.
  expect(localData.pending).toBe(4)

  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const response = await route.fetch()
    await route.fulfill({ response })
  })
  calls.length = 0
  measuring = true
  const slowStartedAt = performance.now()
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('.topbar-sync-state')).toHaveAttribute('aria-label', /Synced/, { timeout: 60_000 })
  const slowSyncMs = Math.round(performance.now() - slowStartedAt)
  measuring = false
  await page.unrouteAll({ behavior: 'wait' })

  const synced = await page.evaluate(async (trackerId) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const { data: { session } } = await client.auth.getSession()
    const [{ data, error }, { data: awards, error: awardError }] = await Promise.all([
      client.from('tracker_entries').select('id,entry_date').eq('user_id', session!.user.id).eq('tracker_id', trackerId),
      client.from('progression_achievement_events').select('id,achievement_id,event_type,recorded_at').eq('user_id', session!.user.id).eq('event_type', 'unlocked'),
    ])
    if (error) throw new Error(`Synced entry verification failed (${error.code ?? 'unknown'}).`)
    if (awardError) throw new Error(`Award history verification failed (${awardError.code ?? 'unknown'}).`)
    const database = await import('/ProgressTracker/src/db/database.ts')
    const pending = await database.db.syncOperations.where('ownerUserId').equals(session!.user.id).filter((operation) => operation.status === 'pending').count()
    return { serverEntries: data?.length ?? 0, distinctDates: new Set((data ?? []).map((item) => item.entry_date)).size, pending, awards: awards ?? [] }
  }, localData.trackerId)
  expect(synced.serverEntries).toBe(4)
  expect(synced.distinctDates).toBe(4)
  expect(synced.pending).toBe(0)
  expect(synced.awards.some((award) => award.achievement_id === 'first-step')).toBe(true)
  // This includes the sync's initial and per-table checks plus the independent
  // badge monitor's account checks. One extra account refresh can occur during
  // AppShell startup, so keep a small bounded allowance across four uploads.
  expect(calls.filter((call) => call.path === '/auth/v1/user').length).toBeLessThanOrEqual(8)
  expect(calls.some((call) => call.failed)).toBe(false)
  expect(consoleErrors).toEqual([])
  console.log(`SYNC_PERF_SCENARIO ${JSON.stringify({ localCheckInMs, offlinePendingOperations: localData.pending, injectedRestDelayMs: 150, slowSyncMs, networkRequestCount: calls.length, authUserRequests: calls.filter((call) => call.path === '/auth/v1/user').length, serverEntries: synced.serverEntries, pendingAfterSync: synced.pending, confirmedAwardCount: synced.awards.length, requests: calls })}`)

  const dialog = page.getByRole('dialog')
  if (await dialog.count()) {
    const dismissRemaining = dialog.getByRole('button', { name: 'Dismiss remaining' })
    if (await dismissRemaining.count()) await dismissRemaining.click()
    else await dialog.getByRole('button', { name: 'Finish' }).click()
  }
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('link', { name: 'Insights', exact: true }).first().click()
  await page.getByRole('link', { name: 'Wins', exact: true }).click()
  const winCard = page.getByRole('button', { name: /First Step, earned|Perfect Day, earned/i }).first()
  await expect(winCard).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await page.getByRole('link', { name: 'Insights', exact: true }).first().click()
  await page.getByRole('link', { name: 'Wins', exact: true }).click()
  await expect(page.getByRole('button', { name: /First Step, earned|Perfect Day, earned/i }).first()).toBeVisible({ timeout: 30_000 })
})
