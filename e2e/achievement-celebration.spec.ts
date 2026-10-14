import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const databaseContainer = process.env.SUPABASE_DB_CONTAINER!
const email = 'browser-achievement-e2e@progress-tracker.invalid'
const credentials = JSON.parse(readFileSync('/private/tmp/progression-playwright-auth.json', 'utf8')) as { userId: string; email: string; password: string }
const viewportMatrix = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const

const userId = credentials.userId

function runDatabase(sql: string): string {
  return execFileSync('docker', ['exec', databaseContainer, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', sql], { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 }).trim()
}

async function dismissCurrentCelebration(page: Page) {
  const dialog = page.getByRole('dialog', { name: /First Step|Perfect Day/i })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Continue' }).click()
}

async function confirmedAwardState(page: Page, achievementId: string) {
  return page.evaluate(async (id) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const { data: { session } } = await client.auth.getSession()
    if (!session?.user) return { userId: null, count: 0, pending: -1, failures: ['No authenticated session'] }
    const repository = await import('/ProgressTracker/src/services/supabase/progressionRepository.ts')
    const database = await import('/ProgressTracker/src/db/database.ts')
    const badge = (await repository.getEarnedAndLockedBadges(session.user.id)).find((item) => item.achievementId === id)
    const operations = await database.db.syncOperations.where('ownerUserId').equals(session.user.id).toArray()
    const outstanding = operations.filter((operation) => operation.status === 'pending')
    return {
      userId: session.user.id,
      count: badge?.validAwardCount ?? 0,
      pending: outstanding.length,
      failures: outstanding.filter((operation) => operation.attempts > 0 || operation.lastError).map((operation) => operation.lastError ?? `attempts=${operation.attempts}`),
    }
  }, achievementId)
}

async function waitForWinsData(page: Page) {
  const badge = page.getByRole('button', { name: /Perfect Day, earned/i })
  const alert = page.getByRole('alert').filter({ hasText: /Progression data could not be loaded|Supabase rejected a progression read|connected Supabase project does not expose/i })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect.poll(async () => (await badge.count()) > 0 || await alert.isVisible(), {
      timeout: 30_000,
      message: 'Wins should render confirmed badge history or a recoverable progression error',
    }).toBe(true)
    if (await badge.count()) {
      await expect(badge).toBeVisible()
      return
    }
    await expect(alert).toBeVisible()
    if (attempt === 1) {
      const details = alert.getByRole('button', { name: /Technical details/i })
      if (await details.count()) await details.click()
      throw new Error(`Wins history remained unavailable after one visible retry: ${(await alert.innerText()).slice(0, 1200)}`)
    }
    await alert.getByRole('button', { name: 'Try again' }).click()
  }
}

test.beforeAll(() => {
  if (credentials.email !== email || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('The isolated Auth prerequisite did not provide the named disposable account.')
})

test('AppShell check-in, server awards, Wins history, and responsive sequential celebrations', async ({ page, context }, testInfo) => {
  const browserErrors: string[] = []
  const authRequests: Array<{ path: string; status?: number; elapsedMs: number; failure?: string }> = []
  const authStarted = new Map<string, number>()
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/auth/v1/')) authStarted.set(request.url(), Date.now())
  })
  page.on('requestfinished', async (request) => {
    if (new URL(request.url()).pathname.startsWith('/auth/v1/')) {
      const started = authStarted.get(request.url()) ?? Date.now()
      const response = await request.response()
      authRequests.push({ path: new URL(request.url()).pathname, status: response?.status(), elapsedMs: Date.now() - started })
      authStarted.delete(request.url())
    }
  })
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname.startsWith('/auth/v1/')) {
      authRequests.push({ path: new URL(request.url()).pathname, elapsedMs: Date.now() - (authStarted.get(request.url()) ?? Date.now()), failure: request.failure()?.errorText ?? 'request failed' })
      authStarted.delete(request.url())
    }
  })
  await page.goto('/#/auth')
  await page.getByRole('button', { name: 'Use password' }).click()
  await page.getByLabel('Email address').last().fill(credentials.email)
  await page.getByLabel('Password').fill(credentials.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  try {
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 50_000 })
  } catch (error) {
    await testInfo.attach('auth-diagnostics.json', { body: JSON.stringify({ requests: authRequests, pending: [...authStarted.keys()].map((url) => new URL(url).pathname), visibleState: await page.locator('body').innerText().catch(() => 'body unavailable') }, null, 2), contentType: 'application/json' })
    throw new Error(`Visible password sign-in did not reach AppShell within 50 seconds. Auth requests: ${JSON.stringify(authRequests)}; pending: ${[...authStarted.keys()].map((url) => new URL(url).pathname).join(', ') || 'none'}. Cause: ${error instanceof Error ? error.message : String(error)}`)
  }
  await expect(page.locator('.app-frame')).toBeVisible()
  const originalBodyOverflow = await page.evaluate(() => document.body.style.overflow)

  await page.getByRole('link', { name: 'Today', exact: true }).first().click()
  await page.getByRole('link', { name: 'Trackers', exact: true }).first().click()
  await page.getByRole('link', { name: /Create tracker/ }).first().click()
  await page.getByLabel('What habit do you want to build?').fill('Browser celebration habit')
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: 'Browser celebration habit' })).toBeVisible()
  await page.getByRole('link', { name: 'Today', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Browser celebration habit', level: 2 })).toBeVisible()
  const checkinAction = page.getByRole('button', { name: 'Save check-in' })
  await page.getByRole('button', { name: /Open Browser celebration habit/ }).click()
  await expect(checkinAction).toBeVisible()

  // Confirm the client keeps this local while offline and that only the server
  // confirmation causes AppShell's progression monitor to show the first award.
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await checkinAction.click()
  await expect(page.getByText(/Saved on this device/)).toBeVisible()
  await expect(page.locator('.badge-celebration')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close check-in details' }).click()
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => confirmedAwardState(page, 'perfect-day'), { timeout: 60_000, message: 'AppShell online synchronization should confirm the first Perfect Day award and clear its local queue' }).toMatchObject({ userId, count: 1, pending: 0 })
  try {
    await expect(page.getByRole('dialog', { name: /First Step/i })).toBeVisible({ timeout: 20_000 })
  } catch (error) {
    const diagnostics = await page.evaluate((id) => ({
      seen: localStorage.getItem(`progress-tracker:achievement-seen:${id}`),
      pending: localStorage.getItem(`progress-tracker:achievement-pending:${id}`),
      dialogs: [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].map((element) => ({ name: element.getAttribute('aria-labelledby'), inert: element.inert, hidden: element.getAttribute('aria-hidden') })),
    }), userId)
    await testInfo.attach('celebration-delivery-diagnostics.json', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' })
    throw new Error(`The server confirmed the first Perfect Day award but the celebration did not appear. Delivery state: ${JSON.stringify(diagnostics)}. ${error instanceof Error ? error.message : String(error)}`)
  }

  const firstDialog = page.getByRole('dialog', { name: /First Step/i })
  await expect(firstDialog.getByText(/qualifying date/)).toBeVisible()
  await expect(firstDialog.getByText(/XP confirmed/)).toContainText('+10 XP confirmed')
  await expect(firstDialog.getByRole('button', { name: 'About this celebration' })).toBeVisible()
  await expect(firstDialog.getByRole('button', { name: 'Continue' })).toBeVisible()
  await expect(firstDialog.locator('.badge-celebration-title-row')).toContainText('First Step')
  await expect(firstDialog.locator('.badge-celebration-title-row').getByRole('button', { name: 'About this celebration' })).toBeVisible()
  await expect(firstDialog.locator('header').getByRole('button', { name: 'Close celebration' })).toBeVisible()
  await firstDialog.getByRole('button', { name: 'Continue' }).focus()
  await page.keyboard.press('Tab')
  await expect(firstDialog.getByRole('button', { name: 'About this celebration' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(firstDialog.getByRole('button', { name: 'Continue' })).toBeFocused()

  // Exercise modal geometry, theme tokens, backdrop effects, scroll lock,
  // confetti containment, reduced motion, and visible actions across all sizes.
  const layoutSnapshots: Array<{ width: number; height: number; theme: string; bounds: { x: number; y: number; width: number; height: number }; bodyOverflow: string; blur: string; surface: string }> = []
  for (const size of viewportMatrix) {
    await page.setViewportSize(size)
    await expect.poll(() => page.evaluate(() => window.visualViewport?.width ?? window.innerWidth)).toBe(size.width)
    // Wait for the viewport-driven layout to settle after resize. This is
    // tied to completed layout frames, not a timing delay.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => {
        if (value === 'dark') document.documentElement.dataset.theme = 'dark'
        else delete document.documentElement.dataset.theme
      }, theme)
      const state = await page.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>('.badge-celebration')!
        const backdrop = document.querySelector<HTMLElement>('.badge-celebration-backdrop')!
        const bounds = dialog.getBoundingClientRect()
        const backdropBounds = backdrop.getBoundingClientRect()
        const confetti = document.querySelector<HTMLElement>('.badge-confetti')!
        const confettiBounds = confetti.getBoundingClientRect()
        const badgeTitle = dialog.querySelector<HTMLElement>('.badge-celebration-title-row h2')!
        const infoButton = dialog.querySelector<HTMLElement>('.badge-celebration-title-row .info-button')!
        const closeButton = dialog.querySelector<HTMLElement>('.badge-celebration-close')!
        const rect = (element: HTMLElement) => {
          const bounds = element.getBoundingClientRect()
          return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
        }
        return {
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          backdropBounds: { x: backdropBounds.x, y: backdropBounds.y, width: backdropBounds.width, height: backdropBounds.height },
          bodyOverflow: document.body.style.overflow,
          blur: getComputedStyle(backdrop).backdropFilter,
          backdropPadding: getComputedStyle(backdrop).padding,
          dialogScrollable: dialog.scrollHeight > dialog.clientHeight,
          confettiClipped: getComputedStyle(confetti).overflow === 'hidden',
          confettiWithinDialog: confettiBounds.left >= bounds.left && confettiBounds.right <= bounds.right && confettiBounds.top >= bounds.top,
          titleBounds: rect(badgeTitle),
          infoBounds: rect(infoButton),
          closeBounds: rect(closeButton),
          theme: document.documentElement.dataset.theme ?? 'light',
          surface: getComputedStyle(dialog).backgroundColor,
        }
      })
      const currentBounds = state.bounds
      expect(currentBounds.x).toBeGreaterThanOrEqual(0)
      expect(currentBounds.y).toBeGreaterThanOrEqual(0)
      expect(currentBounds.x + currentBounds.width).toBeLessThanOrEqual(size.width + 1)
      expect(currentBounds.y + currentBounds.height).toBeLessThanOrEqual(size.height + 1)
      const centerDrift = Math.abs(currentBounds.x + currentBounds.width / 2 - state.backdropBounds.x - state.backdropBounds.width / 2)
      expect(centerDrift, JSON.stringify({ size, theme, bounds: currentBounds })).toBeLessThanOrEqual(2)
      const verticalCenterDrift = Math.abs(currentBounds.y + currentBounds.height / 2 - state.backdropBounds.y - state.backdropBounds.height / 2)
      expect(verticalCenterDrift, JSON.stringify({ size, theme, bounds: currentBounds })).toBeLessThanOrEqual(2)
      expect(state.bodyOverflow).toBe('hidden')
      expect(state.blur).toContain('blur(9px)')
      expect(state.confettiClipped).toBe(true)
      expect(state.confettiWithinDialog).toBe(true)
      expect(state.backdropPadding).toMatch(/16px|12px/)
      expect(state.titleBounds.right).toBeLessThanOrEqual(state.infoBounds.x + 1)
      expect(state.infoBounds.right).toBeLessThanOrEqual(state.closeBounds.x + 1)
      expect(state.infoBounds.width).toBeGreaterThanOrEqual(40)
      expect(state.closeBounds.x + state.closeBounds.width).toBeLessThanOrEqual(size.width + 1)
      expect(Math.abs(state.titleBounds.y + state.titleBounds.height / 2 - state.infoBounds.y - state.infoBounds.height / 2)).toBeLessThanOrEqual(state.titleBounds.height / 2)
      await expect(firstDialog.getByRole('button', { name: 'Continue' })).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath(`celebration-${size.width}x${size.height}-${theme}.png`) })
      layoutSnapshots.push({ ...size, theme, bounds: currentBounds, bodyOverflow: state.bodyOverflow, blur: state.blur, surface: state.surface })
    }
  }
  expect(layoutSnapshots).toHaveLength(10)
  for (const size of viewportMatrix) {
    const lightSurface = layoutSnapshots.find((snapshot) => snapshot.width === size.width && snapshot.theme === 'light')?.surface
    const darkSurface = layoutSnapshots.find((snapshot) => snapshot.width === size.width && snapshot.theme === 'dark')?.surface
    expect(lightSurface).not.toBe(darkSurface)
  }

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reducedMotion = await page.locator('.badge-confetti i').first().evaluate((element) => ({ animationName: getComputedStyle(element).animationName, opacity: getComputedStyle(element).opacity }))
  expect(reducedMotion.animationName).toBe('none')
  expect(Number(reducedMotion.opacity)).toBe(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // Initial unlock has sequential First Step then Perfect Day cards.
  await page.setViewportSize({ width: 390, height: 844 })
  await dismissCurrentCelebration(page)
  const firstPerfectDay = page.getByRole('dialog', { name: /Perfect Day/i })
  await expect(firstPerfectDay.getByText(/first unlock/i)).toBeVisible()
  await firstPerfectDay.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.badge-celebration')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe(originalBodyOverflow)

  const todayDate = await page.evaluate(async () => {
    const { localCalendarDate } = await import('/ProgressTracker/src/features/shared/localDates.ts')
    return localCalendarDate(new Date(), 'UTC')
  })
  const history = await page.evaluate(async () => {
    const repo = await import('/ProgressTracker/src/services/supabase/progressionRepository.ts')
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const { data: { session } } = await client.auth.getSession()
    if (!session?.user) throw new Error('The persisted browser session disappeared before reading confirmed history.')
    const badges = await repo.getEarnedAndLockedBadges(session.user.id)
    const overview = await repo.getProgressionOverview(session.user.id)
    return { userId: session.user.id, badges: badges.map((badge) => ({ id: badge.achievementId, count: badge.validAwardCount, history: badge.history.map((item) => ({ date: item.sourceDate, recordedAt: item.recordedAt, kind: item.eventType })) })), xp: overview.confirmedXp }
  })
  expect(history.userId).toBe(userId)
  expect(history.xp).toBe(30)
  expect(history.badges.find((badge) => badge.id === 'perfect-day')?.count).toBe(1)
  expect(history.badges.find((badge) => badge.id === 'perfect-day')?.history).toEqual(expect.arrayContaining([expect.objectContaining({ date: todayDate, kind: 'unlocked' })]))

  // Arrange only this disposable account for the same five-day repeat fixture
  // as the passing local API integration, then create entries through the
  // browser app's Dexie repository and production synchronization engine.
  const repeatStartDate = await page.evaluate(async () => {
    const dates = await import('/ProgressTracker/src/features/shared/localDates.ts')
    const today = dates.localCalendarDate(new Date(), 'UTC')
    return dates.shiftCalendarDate(today, -5)
  })
  const accountCount = runDatabase('SELECT count(*) FROM auth.users;')
  if (accountCount !== '1') throw new Error(`The isolated database contains ${accountCount} Auth users; will not backdate its global repeatable-award cutover.`)
  runDatabase(`UPDATE public.progression_account_state SET initialized_at='${repeatStartDate}T00:00:00.000Z'::timestamptz WHERE user_id='${userId}'; UPDATE public.progression_achievement_accounts SET initialized_at='${repeatStartDate}T00:00:00.000Z'::timestamptz WHERE user_id='${userId}'; UPDATE public.progression_achievement_repeatable_cutover SET recorded_at='${repeatStartDate}T00:00:00.000Z'::timestamptz; UPDATE public.trackers SET created_at='${repeatStartDate}T00:00:00.000Z'::timestamptz, updated_at='${repeatStartDate}T00:00:00.000Z'::timestamptz, definition=jsonb_set(definition, '{startDate}', to_jsonb('${repeatStartDate}'::text)) WHERE user_id='${userId}';`)
  await page.getByRole('link', { name: 'Insights', exact: true }).first().click()
  await page.getByRole('link', { name: 'Wins', exact: true }).click()
  await waitForWinsData(page)
  const winCount = page.getByRole('button', { name: /Perfect Day, earned/i })
  await expect(winCount).toContainText('Earned once')
  const consistencyCard = page.getByRole('button', { name: /Consistency Star, locked/i })
  const consistencySummary = (await consistencyCard.innerText()).replace(/\s+/g, ' ')
  const eligibleDays = consistencySummary.match(/Eligible days: (\d+) \/ 30/)
  expect(eligibleDays, `Expected authoritative eligible-day coverage in: ${consistencySummary}`).not.toBeNull()
  expect(Number(eligibleDays?.[1])).toBeLessThan(30)
  expect(consistencySummary).toMatch(/Adherence: (?:\d+(?:\.\d+)?%|Unavailable) \(target: 80%\)/)
  await expect(consistencyCard.locator('.progression-level-track')).toHaveCount(0)
  // Focus a stable navigation control before background sync updates the badge
  // card's accessible name and count. It remains a valid restoration target.
  const winsNavigation = page.getByRole('link', { name: 'Wins', exact: true })
  await winsNavigation.focus()
  const repeats = await page.evaluate(async () => {
    const repository = await import('/ProgressTracker/src/db/localRepository.ts')
    const trackers = await repository.localRepository.listTrackers()
    const tracker = trackers.find((item) => item.name === 'Browser celebration habit')!
    const completedMetricId = tracker.metrics[0]!.id
    for (let offset = -4; offset <= -1; offset += 1) {
      const dates = await import('/ProgressTracker/src/features/shared/localDates.ts')
      const date = dates.shiftCalendarDate(dates.localCalendarDate(new Date(), 'UTC'), offset)
      await repository.localRepository.saveTrackerEntry({ trackerId: tracker.id, date, outcome: 'recorded', values: { [completedMetricId]: true }, note: 'browser repeat qualification' })
    }
    return { inserted: 4 }
  })
  expect(repeats.inserted).toBe(4)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => confirmedAwardState(page, 'perfect-day'), { timeout: 60_000, message: 'AppShell sync should persist four distinct Perfect Day occurrences' }).toMatchObject({ userId, count: 5, pending: 0 })
  await expect(winCount).toContainText('Earned 5 times')

  // The five-day fixture earns Momentum as well as four distinct Perfect Day
  // occurrences. Derive the expected queue directly from persisted history,
  // since same-sync awards are ordered by their server timestamps and IDs.
  await expect.poll(() => confirmedAwardState(page, 'momentum'), { timeout: 30_000, message: 'The five-day fixture should confirm its first Momentum award' }).toMatchObject({ userId, count: 1, pending: 0 })
  const expectedQueue = await page.evaluate(async (id) => {
    const repository = await import('/ProgressTracker/src/services/supabase/progressionRepository.ts')
    const catalog = await import('/ProgressTracker/src/features/dashboard/achievementCatalog.ts')
    const badges = await repository.getEarnedAndLockedBadges(id)
    const history = badges.flatMap((badge) => badge.history)
    const seen = new Set<string>(JSON.parse(localStorage.getItem(`progress-tracker:achievement-seen:${id}`) ?? '[]'))
    const revoked = new Set(history.filter((event) => event.eventType === 'revoked' && event.reversesEventId).map((event) => event.reversesEventId))
    return history.filter((event) => event.eventType === 'unlocked' && !seen.has(event.id) && !revoked.has(event.id))
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id))
      .map((event) => ({
        achievementId: event.achievementId,
        name: catalog.achievementDefinition(event.achievementId)?.name,
        tier: event.tier,
        sourceDate: event.sourceDate,
        rewardXpDelta: event.rewardXpDelta,
      }))
  }, userId)
  expect(expectedQueue.filter((event) => event.achievementId === 'momentum')).toHaveLength(1)
  expect(expectedQueue.filter((event) => event.achievementId === 'perfect-day').map((event) => event.tier).sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
  expect(expectedQueue).toHaveLength(5)

  const occurrenceLabels: string[] = []
  const presentedAwards: Array<{ achievementId: string; tier: number }> = []
  for (let occurrence = 0; occurrence < expectedQueue.length; occurrence += 1) {
    const expected = expectedQueue[occurrence]!
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('h2')).toHaveText(expected.name!)
    const details = dialog.locator('.badge-celebration-occurrence')
    await expect(details).toBeVisible()
    if (expected.sourceDate) await expect(details).toContainText(expected.sourceDate)
    else await expect(details).toContainText('qualifying date unavailable')
    if (expected.rewardXpDelta && expected.rewardXpDelta > 0) await expect(dialog.getByText(`+${expected.rewardXpDelta} XP confirmed`)).toBeVisible()
    const label = (await dialog.locator('.eyebrow').innerText()).trim()
    if (expected.achievementId === 'perfect-day') occurrenceLabels.push(label)
    presentedAwards.push({ achievementId: expected.achievementId, tier: expected.tier })
    if (occurrence === 0) await page.keyboard.press('Escape')
    else await dialog.getByRole('button', { name: 'Continue' }).click()
  }
  expect(presentedAwards).toEqual(expectedQueue.map(({ achievementId, tier }) => ({ achievementId, tier })))
  expect(occurrenceLabels).toHaveLength(4)
  expect(occurrenceLabels).toContain('5 achievement awards')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(winsNavigation).toBeFocused()

  // Navigate to Wins and confirm server history-backed count and timestamps;
  // browser navigation/refresh must not replay already presented events.
  await expect(page.getByRole('button', { name: /Perfect Day, earned/i })).toContainText('Earned 5 times')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Achievements.' })).toBeVisible()
  await page.getByRole('link', { name: 'Wins', exact: true }).click()
  await waitForWinsData(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Perfect Day, earned/i })).toContainText('Earned 5 times')
  const pageAwards = await page.getByRole('button', { name: /Perfect Day, earned/i }).innerText()
  expect(pageAwards).toContain('Most recent')

  const refreshState = await page.evaluate(async () => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const repo = await import('/ProgressTracker/src/services/supabase/progressionRepository.ts')
    const { data: { session } } = await client.auth.getSession()
    if (!session?.user) throw new Error('The persisted browser session disappeared before refresh verification.')
    const badge = (await repo.getEarnedAndLockedBadges(session.user.id)).find((item) => item.achievementId === 'perfect-day')!
    return { count: badge.validAwardCount, dates: badge.history.filter((event) => event.eventType === 'unlocked').map((event) => event.sourceDate).sort(), timestamps: badge.history.filter((event) => event.eventType === 'unlocked').map((event) => event.recordedAt), xp: (await repo.getProgressionOverview(session.user.id)).confirmedXp }
  })
  expect(refreshState.count).toBe(5)
  expect(new Set(refreshState.dates).size).toBe(5)
  expect(refreshState.timestamps).toHaveLength(5)
  expect(refreshState.xp).toBe(150)

  await winsNavigation.focus()
  // A sixth distinct eligible day exercises an ordinary repeat and Escape
  // restoration; future-dated check-ins are correctly excluded by the server.
  await page.evaluate(async () => {
    const repository = await import('/ProgressTracker/src/db/localRepository.ts')
    const tracker = (await repository.localRepository.listTrackers()).find((item) => item.name === 'Browser celebration habit')!
    const completedMetricId = tracker.metrics[0]!.id
    const dates = await import('/ProgressTracker/src/features/shared/localDates.ts')
    const date = dates.shiftCalendarDate(dates.localCalendarDate(new Date(), 'UTC'), -5)
    await repository.localRepository.saveTrackerEntry({ trackerId: tracker.id, date, outcome: 'recorded', values: { [completedMetricId]: true }, note: 'browser Escape focus restoration' })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => confirmedAwardState(page, 'perfect-day'), { timeout: 60_000, message: 'AppShell sync should confirm the final distinct future-date award' }).toMatchObject({ userId, count: 6 })
  const repeatDialog = page.getByRole('dialog', { name: /Perfect Day/i })
  await expect(repeatDialog).toBeVisible()
  await expect(repeatDialog.locator('.eyebrow')).toHaveText('Achievement unlocked')
  await expect(repeatDialog).toHaveClass(/is-subtle/)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(winsNavigation).toBeFocused()
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe(originalBodyOverflow)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  expect(browserErrors).toEqual([])
})
