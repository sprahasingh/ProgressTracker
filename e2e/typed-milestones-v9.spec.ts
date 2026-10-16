import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

type Fixture = { userId: string; email: string; password: string; accessToken: string; refreshToken: string }
type Measure = { id: string; name: string; valueType: string }
type SavedTracker = { id: string; name: string; schemaVersion: number; metrics: Measure[]; milestones: Array<{ id: string; type?: string; title: string; targetValue?: number }> }

const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progresstracker-v8-sql-review-run2-auth.json'
const DAY_MS = 86_400_000
const fixture = () => JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
const shiftDate = (date: string, amount: number) => new Date(Date.parse(`${date}T00:00:00.000Z`) + amount * DAY_MS).toISOString().slice(0, 10)
const today = () => new Date().toISOString().slice(0, 10)

async function signIn(page: Page, context: BrowserContext, user: Fixture) {
  await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await page.goto('/#/auth')
  await page.evaluate(async (session) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()
    if (!client) throw new Error('The local Supabase client is not configured.')
    const { error } = await client.auth.setSession({ access_token: session.accessToken, refresh_token: session.refreshToken })
    if (error) throw error
  }, user)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 10_000 })
  await page.evaluate(async (userId) => (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository.setTimeZone('UTC', userId), user.userId)
}

async function readTracker(page: Page, name: string): Promise<SavedTracker> {
  return page.evaluate(async (trackerName) => {
    const tracker = (await (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository.listTrackers()).find((item) => item.name === trackerName)
    if (!tracker) throw new Error(`Tracker ${trackerName} was not saved locally.`)
    return {
      id: tracker.id,
      name: tracker.name,
      schemaVersion: tracker.schemaVersion,
      metrics: tracker.metrics.map(({ id, name, valueType }) => ({ id, name, valueType })),
      milestones: tracker.milestones.map(({ id, type, title, targetValue }) => ({ id, type, title, targetValue })),
    }
  }, name)
}

async function dismissVisibleCelebration(page: Page) {
  const celebration = page.getByRole('dialog')
  if (!await celebration.isVisible()) return false
  const dismissRemaining = celebration.getByRole('button', { name: 'Dismiss remaining' })
  const finish = celebration.getByRole('button', { name: /^(Done|Finish)$/ })
  if (await dismissRemaining.isVisible()) await dismissRemaining.click()
  else if (await finish.isVisible()) await finish.click()
  else await celebration.getByRole('button', { name: 'Close celebration' }).click()
  await expect(celebration).toBeHidden()
  return true
}

async function syncAccount(page: Page) {
  await page.goto('/#/auth')
  const button = page.getByRole('button', { name: 'Sync this account' })
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  let syncStarted = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await dismissVisibleCelebration(page)) continue
    try {
      await button.click({ timeout: 2_000 })
      syncStarted = true
      break
    } catch (error) {
      if (!await dismissVisibleCelebration(page) || attempt === 2) throw error
    }
  }
  if (!syncStarted) throw new Error('Could not activate sync after dismissing the visible progression dialogs.')
  await expect(page.getByRole('button', { name: 'Syncing…' })).toBeHidden({ timeout: 45_000 })
}

async function expectRemoteState(page: Page, trackerId: string, expectedEntries: number) {
  await expect.poll(() => page.evaluate(async (id) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const [{ data: tracker, error: trackerError }, { data: entries, error: entryError }] = await Promise.all([
      client.from('trackers').select('schema_version,definition').eq('id', id).maybeSingle(),
      client.from('tracker_entries').select('id,entry_date').eq('tracker_id', id),
    ])
    if (trackerError || entryError) throw new Error([trackerError?.message, entryError?.message].filter(Boolean).join('; '))
    return { version: tracker?.schema_version ?? null, definition: tracker?.definition ?? null, dates: entries.map(({ entry_date }) => entry_date).sort() }
  }, trackerId), { timeout: 45_000 }).toMatchObject({ version: 9 })
  const remote = await page.evaluate(async (id) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const [{ data: tracker, error: trackerError }, { data: entries, error: entryError }] = await Promise.all([
      client.from('trackers').select('schema_version,definition').eq('id', id).single(),
      client.from('tracker_entries').select('id,entry_date').eq('tracker_id', id),
    ])
    if (trackerError || entryError) throw new Error([trackerError?.message, entryError?.message].filter(Boolean).join('; '))
    return { tracker, entries }
  }, trackerId)
  expect(remote.tracker.schema_version).toBe(9)
  expect(remote.tracker.definition.milestones).toHaveLength(5)
  expect(remote.entries).toHaveLength(expectedEntries)
  expect(new Set(remote.entries.map(({ entry_date }) => entry_date)).size).toBe(expectedEntries)
}

test('100 Days of DSA milestones keep separate calculations through reload, sync, history, calendar, themes, and mobile widths', async ({ page, context }) => {
  const user = fixture()
  await signIn(page, context, user)

  const trackerName = 'V9 100 Days of DSA'
  const startDate = shiftDate(today(), -49)
  await page.goto('/#/trackers/new')
  await page.getByText('Challenge or project?', { exact: true }).click()
  await page.getByText('Challenge', { exact: true }).click()
  await page.getByLabel('What challenge are you taking on?').fill(trackerName)
  await page.getByLabel('Measure 1 value type').selectOption('quantity')
  await page.getByLabel('Numeric measure unit').fill('problems')
  await page.getByLabel('Start date').fill(startDate)
  await page.getByLabel('Schedule duration').selectOption('effective')
  await page.getByLabel('Target effective days').fill('100')
  await page.getByText('More options').click()
  const scheduleDetails = page.locator('details.advanced-subsection').filter({ hasText: 'Activity schedule & holidays' })
  await scheduleDetails.locator(':scope > summary').click()
  await page.getByLabel('Activity schedule').selectOption('weekdays')
  await page.getByText('Include rest days too', { exact: true }).click()

  const measures = page.locator('details.advanced-subsection').filter({ hasText: 'Measures, precision & targets' })
  await measures.locator(':scope > summary').click()
  await measures.getByLabel('Name', { exact: true }).first().fill('DSA Problems')

  await page.locator('details.advanced-subsection > summary').filter({ hasText: /^Success rule$/ }).click()
  const success = page.getByRole('region', { name: 'Success rule' })
  await success.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('at-least')
  await success.getByRole('spinbutton', { name: 'Value' }).fill('3')

  await page.locator('details.advanced-subsection > summary').filter({ hasText: /^Streak rule$/ }).click()
  const streak = page.getByRole('region', { name: 'Streak rule' })
  await streak.getByLabel('Streak rule mode').selectOption('custom')
  await streak.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('at-least')
  await streak.getByRole('spinbutton', { name: 'Value' }).fill('1')

  await page.locator('details.advanced-subsection > summary').filter({ hasText: /^Milestones$/ }).click()
  const milestoneTypes = ['cumulative-quantity', 'single-day-quantity', 'successful-days', 'streak-length', 'challenge-day']
  const milestoneNames = ['First 50 Problems', 'Big Practice Day', '10 Productive Days', '7-Day Streak', 'Halfway Through']
  const milestoneTargets = ['50', '10', '10', '7', '50']
  for (let index = 0; index < milestoneTypes.length; index += 1) {
    await page.getByRole('button', { name: '＋ Add milestone' }).click()
    const card = page.locator('.milestone-editor-card').nth(index)
    await card.getByLabel('Milestone name').fill(milestoneNames[index]!)
    await card.getByRole('combobox', { name: 'What should this milestone track?' }).selectOption(milestoneTypes[index]!)
    await card.getByRole('spinbutton').fill(milestoneTargets[index]!)
  }
  await expect(page.locator('.milestone-editor-card').nth(0).locator('.milestone-live-preview')).toContainText('50 DSA Problems')
  await expect(page.locator('.milestone-editor-card').nth(4).locator('.milestone-live-preview')).toContainText('Reach Day 50')

  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: 'You’re ready to begin' })).toBeVisible()
  const tracker = await readTracker(page, trackerName)
  expect(tracker.schemaVersion).toBe(9)
  expect(tracker.metrics[0]).toMatchObject({ name: 'DSA Problems', valueType: 'quantity' })
  expect(tracker.milestones.map(({ type, targetValue }) => [type, targetValue])).toEqual(milestoneTypes.map((type, index) => [type, Number(milestoneTargets[index])]))

  await context.setOffline(true)
  const firstEntryDate = shiftDate(today(), -10)
  const values = [10, 1, 10, 10, 1, 1, 10, 1, 10, 1]
  await page.evaluate(async ({ trackerId, metricId, firstDate, values }) => {
    const repository = (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository
    for (let index = 0; index < values.length; index += 1) {
      await repository.saveTrackerEntry({ trackerId, date: new Date(Date.parse(`${firstDate}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10), outcome: 'recorded', values: { [metricId]: values[index] }, note: '' })
    }
  }, { trackerId: tracker.id, metricId: tracker.metrics[0]!.id, firstDate: firstEntryDate, values })
  await context.setOffline(false)
  await syncAccount(page)
  await expectRemoteState(page, tracker.id, values.length)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  expect((await readTracker(page, trackerName)).milestones).toHaveLength(5)
  await page.goto('/#/trackers')
  const trackerCard = page.locator('.tracker-card').filter({ hasText: trackerName })
  await expect(trackerCard).toBeVisible()
  await trackerCard.locator('.tracker-card-milestones > summary').click()
  const progress = trackerCard.locator('.milestone-progress-card')
  await expect(progress).toHaveCount(5)
  await expect(progress.filter({ hasText: 'First 50 Problems' })).toContainText('55 / 50 problems total')
  await expect(progress.filter({ hasText: 'Big Practice Day' })).toContainText('Best day: 10 / 10 problems')
  await expect(progress.filter({ hasText: '10 Productive Days' })).toContainText('5 / 10 successful days')
  await expect(progress.filter({ hasText: '7-Day Streak' })).toContainText('Best streak: 8 / 7 days')
  await expect(progress.filter({ hasText: 'Halfway Through' })).toContainText('Challenge Day 50 / 50')
  await expect(progress.filter({ hasText: 'First 50 Problems' }).getByText('Completed')).toBeVisible()
  await expect(progress.filter({ hasText: '10 Productive Days' }).getByText('Completed')).toHaveCount(0)

  await page.goto('/#/history')
  await expect(page.getByRole('heading', { name: 'Milestones reached' })).toBeVisible()
  await expect(page.locator('.history-milestone-events')).toContainText('Halfway Through')
  await expect(page.locator('.history-milestone-events')).toContainText('7-Day Streak')

  await page.goto(`/#/calendar?date=${firstEntryDate}`)
  await page.getByRole('combobox', { name: 'Tracker' }).selectOption(tracker.id)
  await expect(page.locator('.calendar-milestone-reached')).toContainText('Big Practice Day')

  for (const theme of ['light', 'dark'] as const) {
    await page.goto('/#/settings')
    await page.locator('#settings-trigger-appearance').click()
    await page.locator('#settings-panel-appearance select').selectOption(theme)
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? 'light')).toBe(theme)
    await page.goto('/#/trackers')
    for (const width of [320, 360, 390, 768]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(page.locator('.tracker-card').filter({ hasText: trackerName })).toBeVisible()
      const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }))
      expect(dimensions.document, `Horizontal page overflow at ${width}px in ${theme} mode: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.viewport)
    }
  }
})
