import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progresstracker-v8-sql-review-run2-auth.json'
const DAY = 86_400_000
type Fixture = { userId: string; email: string; password: string; accessToken: string; refreshToken: string }
type MeasureType = 'boolean' | 'quantity' | 'duration' | 'checklist'
type TrackerFixture = { id: string; name: string; schemaVersion: number; metrics: Array<{ id: string; name: string; valueType: MeasureType }>; qualificationRule: unknown; streakRuleMode: string; streakRule?: unknown }

function fixture(): Fixture { return JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture }
function dateShift(date: string, amount: number): string { return new Date(Date.parse(`${date}T00:00:00.000Z`) + amount * DAY).toISOString().slice(0, 10) }
function today(): string { return new Date().toISOString().slice(0, 10) }

async function useUtc(page: Page, context: BrowserContext, userId: string) {
  await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await page.evaluate(async (id) => (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository.setTimeZone('UTC', id), userId)
}

async function signInThroughUi(page: Page, user: Fixture) {
  await page.goto('/#/auth')
  await page.getByRole('button', { name: 'Use password' }).click()
  await page.getByLabel('Email address').last().fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 20_000 })
}

async function restoreVerifiedSession(page: Page, user: Fixture) {
  await page.goto('/#/auth')
  await page.evaluate(async (session) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()
    if (!client) throw new Error('The local Supabase client is not configured.')
    const { error } = await client.auth.setSession({ access_token: session.accessToken, refresh_token: session.refreshToken })
    if (error) throw error
  }, user)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 10_000 })
}

async function beginTracker(page: Page, name: string, valueType: MeasureType = 'quantity', startDate?: string) {
  await page.goto('/#/trackers/new')
  await page.getByLabel('What habit do you want to build?').fill(name)
  await page.getByLabel('Measure 1 value type').selectOption(valueType)
  if (startDate) await page.getByLabel('Start date').fill(startDate)
}

async function readTracker(page: Page, name: string): Promise<TrackerFixture> {
  return page.evaluate(async (trackerName) => {
    const repository = (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository
    const tracker = (await repository.listTrackers()).find((item) => item.name === trackerName)
    if (!tracker) throw new Error(`Tracker ${trackerName} was not persisted.`)
    return { id: tracker.id, name: tracker.name, schemaVersion: tracker.schemaVersion, metrics: tracker.metrics.map(({ id, name, valueType }) => ({ id, name, valueType })), qualificationRule: tracker.qualificationRule, streakRuleMode: tracker.streakRuleMode, streakRule: tracker.streakRule }
  }, name)
}

async function createTracker(page: Page, name: string, valueType: MeasureType = 'quantity', startDate?: string): Promise<TrackerFixture> {
  await beginTracker(page, name, valueType, startDate)
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: /You’re ready to begin/ })).toBeVisible()
  return readTracker(page, name)
}

async function seedEntry(page: Page, trackerId: string, date: string, values: Record<string, unknown>) {
  await page.evaluate(async ({ trackerId, date, values }) => {
    await (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository.saveTrackerEntry({ trackerId, date, outcome: 'recorded', values, note: '' })
  }, { trackerId, date, values })
}

async function createHistoricalEntry(page: Page, tracker: TrackerFixture, date: string, value: string, shouldShowNotice = false) {
  await page.goto('/#/history')
  await dismissVisibleCelebrations(page)
  await page.getByRole('combobox', { name: 'Tracker', exact: true }).selectOption(tracker.id)
  await page.getByLabel('Add or edit a date').fill(date)
  await clickAfterClearingCelebrations(page, page.getByRole('button', { name: 'Add / edit check-in' }))
  let dialog = page.getByRole('dialog', { name: tracker.name })
  await expect(dialog).toBeVisible()
  if (await dismissVisibleCelebrations(page)) dialog = await reopenHistoryEditor(page, tracker, date)
  if (shouldShowNotice) await expect(dialog.getByRole('note')).toHaveText('Past entries can update your XP, streaks, and achievements.')
  dialog = await fillHistoryValue(page, tracker, date, value)
  const save = dialog.getByRole('button', { name: /Save check-in|Update check-in/ })
  await clickAfterClearingCelebrations(page, save)
  await expect(page.getByText(/Saved on this device/)).toBeVisible()
  await clickAfterClearingCelebrations(page, dialog.getByRole('button', { name: 'Close check-in details' }))
}

async function fillHistoryValue(page: Page, tracker: TrackerFixture, date: string, value: string) {
  let dialog = page.getByRole('dialog', { name: tracker.name })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await dismissVisibleCelebrations(page)) dialog = await reopenHistoryEditor(page, tracker, date)
    try {
      await dialog.getByRole('spinbutton', { name: tracker.metrics[0]!.name }).fill(value, { timeout: 3_000 })
      return dialog
    } catch (error) {
      if (!await page.locator('.badge-celebration-backdrop').count()) throw error
      if (await dismissVisibleCelebrations(page)) dialog = await reopenHistoryEditor(page, tracker, date)
    }
  }
  throw new Error('Could not edit the historical value after acknowledging queued celebrations.')
}

async function reopenHistoryEditor(page: Page, tracker: TrackerFixture, date: string) {
  await page.getByLabel('Add or edit a date').fill(date)
  await clickAfterClearingCelebrations(page, page.getByRole('button', { name: 'Add / edit check-in' }))
  const dialog = page.getByRole('dialog', { name: tracker.name })
  await expect(dialog).toBeVisible()
  return dialog
}

async function awaitRemoteEntries(page: Page, trackerId: string, count: number) {
  await expect.poll(() => page.evaluate(async (id) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    const { data, error } = await client.from('tracker_entries').select('id').eq('tracker_id', id)
    if (error) throw error
    return data.length
  }, trackerId), { timeout: 45_000 }).toBe(count)
}

async function dismissVisibleCelebrations(page: Page) {
  const backdrop = page.locator('.badge-celebration-backdrop')
  let historyEditorClosed = false
  let queueWasObservedEmpty = false
  // One historical sync can confirm every persisted event. Match the monitor's
  // 3,000 item persistence bound, with one extra pass to observe an empty queue.
  for (let attempt = 0; attempt < 3_001; attempt += 1) {
    if (!await backdrop.count()) {
      queueWasObservedEmpty = true
      break
    }
    const celebration = backdrop.locator('[role="dialog"]')
    if (await celebration.evaluate((element) => element.inert || element.getAttribute('aria-hidden') === 'true').catch(() => false)) {
      const closeEditor = page.getByRole('button', { name: 'Close check-in details' })
      if (!await closeEditor.count()) throw new Error('A badge celebration is covered by another modal with no supported History close control.')
      await closeEditor.click()
      historyEditorClosed = true
      await expect(closeEditor).toBeHidden()
      continue
    }
    const current = await celebration.innerText()
    await celebration.getByRole('button', { name: 'Close celebration' }).click()
    await expect.poll(async () => {
      if (!await backdrop.count()) return ''
      return await backdrop.locator('[role="dialog"]').innerText().catch(() => '')
    }).not.toBe(current)
  }
  if (!queueWasObservedEmpty && await backdrop.count()) {
    const remaining = await backdrop.locator('[role="dialog"]').innerText().catch(() => 'unknown celebration')
    throw new Error(`Celebration queue exceeded its 3,000 item acknowledgement bound. Remaining item: ${remaining}`)
  }
  return historyEditorClosed
}

async function clickAfterClearingCelebrations(page: Page, target: Locator) {
  const backdrop = page.locator('.badge-celebration-backdrop')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dismissVisibleCelebrations(page)
    if (!await target.count()) return
    try {
      await target.click({ timeout: 4_000 })
      return
    } catch (error) {
      if (!await backdrop.count()) throw error
    }
  }
  await expect(backdrop).toHaveCount(0, { timeout: 5_000 })
  await target.click({ timeout: 4_000 })
}

async function clickSync(page: Page) {
  await page.goto('/#/auth')
  const sync = page.getByRole('button', { name: 'Sync this account' })
  await expect(sync).toBeVisible()
  await expect(sync).toBeEnabled()
  await sync.scrollIntoViewIfNeeded()
  await clickAfterClearingCelebrations(page, sync)
  await expect(page.getByRole('button', { name: 'Syncing…' })).toBeHidden({ timeout: 45_000 })
}

test('authentication establishes a real browser session that persists after reload', async ({ page, context }) => {
  const user = fixture()
  await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  const authStatuses: number[] = []
  page.on('response', (response) => { if (new URL(response.url()).pathname === '/auth/v1/token') authStatuses.push(response.status()) })
  await signInThroughUi(page, user)
  const before = await page.evaluate(async () => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    return (await client.auth.getSession()).data.session?.user.id ?? null
  })
  expect(authStatuses).toContain(200)
  expect(before).toBe(user.userId)
  await page.reload()
  const after = await page.evaluate(async () => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
    return (await client.auth.getSession()).data.session?.user.id ?? null
  })
  expect(after).toBe(user.userId)
})

test.describe('v8 tracker behavior', () => {
  test.beforeEach(async ({ page, context }) => {
    const user = fixture()
    await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
    await restoreVerifiedSession(page, user)
    await useUtc(page, context, user.userId)
  })

  test('creates every measure type as Measure 1', async ({ page }) => {
    const types: MeasureType[] = ['boolean', 'quantity', 'duration', 'checklist']
    for (const type of types) {
      const tracker = await createTracker(page, `V8 Measure 1 ${type}`, type)
      expect(tracker.schemaVersion).toBe(8)
      expect(tracker.metrics).toHaveLength(1)
      expect(tracker.metrics[0]?.valueType).toBe(type)
    }
  })

  test('evaluates independent custom Success and Streak Rules across mixed measure types', async ({ page }) => {
    await page.goto('/#/trackers/new')
    await page.getByLabel('What habit do you want to build?').fill('V8 Mixed Rules')
    await page.getByLabel('Measure 1 value type').selectOption('boolean')
    await page.getByText('More options').click()
    const measures = page.locator('details.advanced-subsection').filter({ hasText: 'Measures, precision & targets' })
    await expect(measures.locator(':scope > summary')).toBeVisible()
    await measures.locator(':scope > summary').click()
    await page.getByRole('button', { name: /Add measure/ }).click()
    const secondMeasure = page.locator('.configuration-card').nth(1)
    await secondMeasure.getByLabel('Name', { exact: true }).fill('Minutes')
    await secondMeasure.getByLabel('Measure 2 value type').selectOption('duration')

    await page.locator('summary').filter({ hasText: 'Streak rule' }).click()
    const streak = page.getByRole('region', { name: 'Streak rule' })
    await streak.getByLabel('Streak rule mode').selectOption('custom')
    await streak.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('equals')
    await expect(streak.getByLabel('Value', { exact: true })).toHaveValue('true')

    await page.locator('summary').filter({ hasText: 'Success rule' }).click()
    const success = page.getByRole('region', { name: 'Success rule' })
    await success.getByRole('combobox', { name: 'Success condition type' }).selectOption('all')
    const children = success.locator('.rule-node-nested')
    await expect(children).toHaveCount(2)
    const numericCondition = children.nth(1)
    await numericCondition.getByRole('combobox', { name: 'Measure', exact: true }).selectOption({ label: 'Minutes' })
    await numericCondition.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('at-least')
    await numericCondition.getByLabel('Value', { exact: true }).fill('5')
    await page.getByRole('button', { name: 'Create tracker' }).click()
    await expect(page.getByRole('heading', { name: /You’re ready to begin/ })).toBeVisible()

    const evaluated = await page.evaluate(async () => {
      const repository = (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository
      const tracker = (await repository.listTrackers()).find((item) => item.name === 'V8 Mixed Rules')!
      const planning = await import('/ProgressTracker/src/domain/trackers/planning.ts')
      const progression = await import('/ProgressTracker/src/domain/trackers/progression.ts')
      const [doneId, minutesId] = tracker.metrics.map((metric) => metric.id)
      const cases = [
        { [doneId!]: true, [minutesId!]: 5 },
        { [doneId!]: true, [minutesId!]: 0 },
        { [doneId!]: false, [minutesId!]: 5 },
        { [doneId!]: false, [minutesId!]: 0 },
      ]
      return { tracker, evaluations: cases.map((values, index) => {
        const entry = { id: `case-${index}`, trackerId: tracker.id, date: `2026-10-${String(index + 1).padStart(2, '0')}`, outcome: 'recorded' as const, values, note: '', createdAt: '', updatedAt: '', deletedAt: null }
        return { success: planning.evaluateTrackerEntry(tracker, entry).qualified, streak: progression.qualifiesForStreak(tracker, entry) }
      }) }
    })
    expect(evaluated.tracker.schemaVersion).toBe(8)
    expect(evaluated.tracker.streakRuleMode).toBe('custom')
    expect(evaluated.tracker.streakRule).toMatchObject({ kind: 'comparison', operator: 'equals', value: true })
    expect(evaluated.tracker.qualificationRule).toMatchObject({ kind: 'all', operands: [{ kind: 'comparison', operator: 'equals', value: true }, { kind: 'comparison', operator: 'at-least', value: 5 }] })
    expect(evaluated.evaluations).toEqual([{ success: true, streak: true }, { success: false, streak: true }, { success: false, streak: false }, { success: false, streak: false }])
  })

  test('creates, edits, and deletes a historical check-in through History', async ({ page }) => {
    const date = dateShift(today(), -3)
    const tracker = await createTracker(page, 'V8 Historical CRUD', 'quantity', dateShift(today(), -5))
    await createHistoricalEntry(page, tracker, date, '2', true)
    await page.goto('/#/history')
    const card = page.locator('.history-entry-card').filter({ hasText: tracker.name })
    await expect(card).toContainText('2')
    await card.getByRole('button', { name: /Edit check-in/ }).click()
    const dialog = page.getByRole('dialog', { name: tracker.name })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('spinbutton', { name: tracker.metrics[0]!.name }).fill('4')
    await dialog.getByRole('button', { name: 'Update check-in' }).click()
    await expect(page.getByText(/Saved on this device/)).toBeVisible()
    const closeCelebration = page.getByRole('button', { name: 'Close celebration' })
    if (await closeCelebration.isVisible().catch(() => false)) await closeCelebration.click()
    await dialog.getByRole('button', { name: 'Close check-in details' }).click()
    await page.goto('/#/history')
    const editedCard = page.locator('.history-entry-card').filter({ hasText: tracker.name })
    await expect(editedCard).toContainText('4')
    await editedCard.getByRole('button', { name: /Edit check-in/ }).click()
    const editDialog = page.getByRole('dialog', { name: tracker.name })
    await editDialog.getByRole('button', { name: 'Clear check-in' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Clear this check-in?' })
    await confirm.getByRole('button', { name: 'Clear check-in', exact: true }).click()
    await expect(editDialog).toBeHidden()
    const stored = await page.evaluate(async ({ trackerId, date }) => {
      const database = (await import('/ProgressTracker/src/db/database.ts')).db
      const row = await database.trackerEntries.where('[trackerId+date]').equals([trackerId, date]).first()
      return { deletedAt: row?.deletedAt ?? null, live: await (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository.getTrackerEntry(trackerId, date) }
    }, { trackerId: tracker.id, date })
    expect(stored.deletedAt).toEqual(expect.any(String))
    expect(stored.live).toBeUndefined()
  })

  test('historical edits reconcile streak XP and unlock or reverse a streak badge', async ({ page, context }) => {
    const firstDate = dateShift(today(), -15)
    await beginTracker(page, 'V8 Historical Rewards', 'quantity', firstDate)
    await page.getByText('More options').click()
    await page.locator('summary').filter({ hasText: 'Streak rule' }).click()
    const streak = page.getByRole('region', { name: 'Streak rule' })
    await streak.getByLabel('Streak rule mode').selectOption('custom')
    await streak.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('equals')
    await streak.getByRole('spinbutton').fill('1')
    await page.locator('summary').filter({ hasText: 'Success rule' }).click()
    await page.getByRole('region', { name: 'Success rule' }).getByRole('spinbutton').fill('5')
    await page.getByRole('button', { name: 'Create tracker' }).click()
    await expect(page.getByRole('heading', { name: /You’re ready to begin/ })).toBeVisible()
    const tracker = await readTracker(page, 'V8 Historical Rewards')
    const savedTracker = await page.evaluate(async () => {
      const tracker = (await (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository.listTrackers()).find((item) => item.name === 'V8 Historical Rewards')!
      return { id: tracker.id, metricId: tracker.metrics[0]!.id, name: tracker.name }
    })
    await context.setOffline(true)
    await page.evaluate(async ({ trackerId, metricId, firstDate }) => {
      const repository = (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository
      for (let offset = 0; offset < 15; offset += 1) {
        await repository.saveTrackerEntry({ trackerId, date: new Date(Date.parse(`${firstDate}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10), outcome: 'recorded', values: { [metricId]: 1 }, note: '' })
      }
    }, { trackerId: savedTracker.id, metricId: savedTracker.metricId, firstDate })
    await context.setOffline(false)
    await page.goto('/#/auth')
    await awaitRemoteEntries(page, savedTracker.id, 15)
    const initial = await page.evaluate(async ({ userId, trackerId }) => {
      const repository = await import('/ProgressTracker/src/services/supabase/progressionRepository.ts')
      const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
      const badge = (await repository.getEarnedAndLockedBadges(userId)).find((item) => item.achievementId === 'steady-flame')!
      const { data: events, error } = await client.from('progression_events').select('effective_date,reason_code,xp_delta,progression_event_sources(tracker_id,source_id)').eq('user_id', userId).order('effective_date')
      if (error) throw error
      const overview = await repository.getProgressionOverview(userId)
      const trackerXp = overview.scoreHistory.filter((event) => event.trackerId === trackerId).reduce((sum, event) => sum + event.xpDelta, 0)
      return { xp: overview.confirmedXp, trackerXp, history: badge.history.map(({ eventType, reversesEventId }) => ({ eventType, reversesEventId })), trackerId, events }
    }, { userId: fixture().userId, trackerId: savedTracker.id })
    expect(initial.trackerXp, `Expected this tracker to earn only the two streak milestones (35 + 50 XP); account XP ${initial.xp}, tracker-linked events: ${JSON.stringify(initial.events)}`).toBe(85)
    expect(initial.history.some((event) => event.eventType === 'unlocked' && event.reversesEventId === null)).toBe(true)

    await createHistoricalEntry(page, { ...tracker, id: savedTracker.id, name: savedTracker.name, metrics: [{ id: savedTracker.metricId, name: 'Progress', valueType: 'quantity' }] }, dateShift(firstDate, 1), '5')
    await clickSync(page)
    await expect.poll(() => page.evaluate(async ({ trackerId, date, metricId }) => {
      const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
      const { data, error } = await client.from('tracker_entries').select('entry_values').eq('tracker_id', trackerId).eq('entry_date', date).single()
      if (error) throw new Error(error.message)
      return data.entry_values[metricId]
    }, { trackerId: savedTracker.id, date: dateShift(firstDate, 1), metricId: savedTracker.metricId }), { timeout: 30_000 }).toBe(5)
    await page.evaluate(async (userId) => {
      await (await import('/ProgressTracker/src/services/supabase/progressionRepository.ts')).getEarnedAndLockedBadges(userId)
    }, fixture().userId)
    await expect.poll(() => page.evaluate(async ({ userId, trackerId }) => {
      const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
      const { data, error } = await client.from('progression_events').select('xp_delta,progression_event_sources(tracker_id)').eq('user_id', userId)
      if (error) throw new Error(error.message)
      return data.filter((event) => event.progression_event_sources?.tracker_id === trackerId).reduce((sum, event) => sum + event.xp_delta, 0)
    }, { userId: fixture().userId, trackerId: savedTracker.id }), { timeout: 15_000 }).toBe(45)
    const reversed = await page.evaluate(async (userId) => {
      const repository = await import('/ProgressTracker/src/services/supabase/progressionRepository.ts')
      const badge = (await repository.getEarnedAndLockedBadges(userId)).find((item) => item.achievementId === 'steady-flame')!
      return badge.history.map(({ id, eventType, reversesEventId }) => ({ id, eventType, reversesEventId }))
    }, fixture().userId)
    expect(reversed.some((event) => event.eventType === 'revoked' && event.reversesEventId !== null)).toBe(true)
    expect(reversed.some((event) => event.eventType === 'unlocked' && event.reversesEventId === null)).toBe(true)

    const beforeReload = await page.evaluate(async ({ userId, trackerId }) => {
      const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
      const { data, error } = await client.from('progression_events').select('id,xp_delta,progression_event_sources(tracker_id)').eq('user_id', userId)
      if (error) throw new Error(error.message)
      const trackerEvents = data.filter((event) => event.progression_event_sources?.tracker_id === trackerId)
      return { xp: trackerEvents.reduce((sum, event) => sum + event.xp_delta, 0), eventIds: trackerEvents.map((event) => event.id).sort() }
    }, { userId: fixture().userId, trackerId: savedTracker.id })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Sync this account' })).toBeVisible()
    const afterReload = await page.evaluate(async ({ userId, trackerId }) => {
      const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
      const repository = await import('/ProgressTracker/src/services/supabase/progressionRepository.ts')
      const { data, error } = await client.from('progression_events').select('id,xp_delta,progression_event_sources(tracker_id)').eq('user_id', userId)
      if (error) throw new Error(error.message)
      const trackerEvents = data.filter((event) => event.progression_event_sources?.tracker_id === trackerId)
      await repository.getProgressionOverview(userId)
      return {
        xp: trackerEvents.reduce((sum, event) => sum + event.xp_delta, 0),
        eventIds: trackerEvents.map((event) => event.id).sort(),
        acknowledged: JSON.parse(localStorage.getItem(`progress-tracker:achievement-seen:${userId}`) ?? '[]') as string[],
      }
    }, { userId: fixture().userId, trackerId: savedTracker.id })
    expect(afterReload.xp).toBe(45)
    expect(afterReload.eventIds).toEqual(beforeReload.eventIds)
    expect(afterReload.acknowledged).toContain(reversed.find((event) => event.eventType === 'unlocked' && event.reversesEventId === null)?.id)
    await expect(page.locator('.badge-celebration-backdrop')).toHaveCount(0)
  })

  test('tracker-specific Insights separate success, streaks, XP, consistency, and trends', async ({ page, context }) => {
    const firstDate = dateShift(today(), -4)
    await beginTracker(page, 'V8 Insights Rules', 'quantity', firstDate)
    await page.getByText('More options').click()
    await page.locator('summary').filter({ hasText: 'Streak rule' }).click()
    const streak = page.getByRole('region', { name: 'Streak rule' })
    await streak.getByLabel('Streak rule mode').selectOption('custom')
    await streak.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('equals')
    await streak.getByRole('spinbutton').fill('1')
    await page.locator('summary').filter({ hasText: 'Success rule' }).click()
    await page.getByRole('region', { name: 'Success rule' }).getByRole('spinbutton').fill('5')
    await page.getByRole('button', { name: 'Create tracker' }).click()
    await expect(page.getByRole('heading', { name: /You’re ready to begin/ })).toBeVisible()
    const tracker = await readTracker(page, 'V8 Insights Rules')
    const metricId = tracker.metrics[0]!.id
    await context.setOffline(true)
    await seedEntry(page, tracker.id, dateShift(firstDate, 0), { [metricId]: 1 })
    await seedEntry(page, tracker.id, dateShift(firstDate, 1), { [metricId]: 5 })
    await seedEntry(page, tracker.id, dateShift(firstDate, 2), { [metricId]: 0 })
    await seedEntry(page, tracker.id, dateShift(firstDate, 3), { [metricId]: 1 })
    await context.setOffline(false)
    await page.goto('/#/auth')
    await awaitRemoteEntries(page, tracker.id, 4)
    await expect.poll(() => page.evaluate(async (trackerId) => {
      const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
      const { data, error } = await client.from('tracker_entries').select('entry_date,entry_values').eq('tracker_id', trackerId).order('entry_date')
      if (error) throw new Error(error.message)
      return data.map((entry) => Number(Object.values(entry.entry_values ?? {})[0])).sort((a, b) => a - b)
    }, tracker.id), { timeout: 30_000 }).toEqual([0, 1, 1, 5])
    await page.goto('/#/analytics')
    await page.getByRole('combobox', { name: 'Tracker', exact: true }).selectOption(tracker.id)
    const stat = (label: string) => page.locator('.dashboard-stat').filter({ hasText: label })
    await expect(stat('Success rules met')).toContainText('1')
    await expect(stat('Success rate')).toContainText('25%')
    await expect(stat('Streak-qualified days')).toContainText('2')
    await expect(stat('Consistency')).toContainText('25%')
    await expect(stat('Current Streak')).toContainText('1')
    const xpEvidence = await page.evaluate(async ({ userId, trackerId }) => {
      const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
      const [{ data: events, error: eventError }, { data: entries, error: entryError }] = await Promise.all([
        client.from('progression_events').select('effective_date,reason_code,xp_delta,progression_event_sources(tracker_id,source_id)').eq('user_id', userId),
        client.from('tracker_entries').select('id,entry_date,entry_values').eq('tracker_id', trackerId),
      ])
      if (eventError || entryError) throw new Error([eventError?.message, entryError?.message].filter(Boolean).join('; '))
      return { events, entries }
    }, { userId: fixture().userId, trackerId: tracker.id })
    await expect(stat('Tracker XP'), `XP attribution evidence: ${JSON.stringify(xpEvidence)}`).toHaveText(/Tracker XP\s*10\s*net XP attributed to this tracker/)
    const periodAccountXp = xpEvidence.events
      .filter((event) => event.effective_date >= dateShift(today(), -29) && event.effective_date <= today())
      .reduce((sum, event) => sum + event.xp_delta, 0)
    await expect(stat('Account XP')).toHaveText(new RegExp(`Account XP\\s*${periodAccountXp}\\s*net XP across all sources in this period`))
    await expect(page.locator('.analytics-value-chart span')).toHaveCount(4)
    await expect(page.getByRole('heading', { name: 'V8 Insights Rules' })).toBeVisible()
  })

  test('reload retains local data and explicit Supabase sync persists v8 tracker and entry', async ({ page }) => {
    const tracker = await createTracker(page, 'V8 Reload Sync', 'quantity')
    await page.goto('/')
    await page.getByRole('button', { name: /Open V8 Reload Sync/ }).click()
    await page.getByRole('spinbutton', { name: 'Progress' }).fill('3')
    await page.getByRole('button', { name: 'Save check-in' }).click()
    await expect(page.getByText(/Saved on this device/)).toBeVisible()
    await page.getByRole('button', { name: 'Close check-in details' }).click()
    await page.reload()
    await expect.poll(() => page.evaluate(async (id) => (await (await import('/ProgressTracker/src/db/localRepository.ts')).localRepository.listTrackerEntriesForTracker(id)).length, tracker.id)).toBe(1)
    await clickSync(page)
    await expect.poll(() => page.evaluate(async ({ trackerId, metricId }) => {
      const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()!
      const [{ data: cloudTracker, error: trackerError }, { data: entries, error: entryError }] = await Promise.all([
        client.from('trackers').select('schema_version,definition').eq('id', trackerId).maybeSingle(),
        client.from('tracker_entries').select('id,entry_values').eq('tracker_id', trackerId),
      ])
      if (trackerError || entryError) throw new Error([trackerError?.message, entryError?.message].filter(Boolean).join('; '))
      return { schemaVersion: cloudTracker?.schema_version, entries: entries.length, value: entries[0]?.entry_values?.[metricId] }
    }, { trackerId: tracker.id, metricId: tracker.metrics[0]!.id }), { timeout: 45_000 }).toMatchObject({ schemaVersion: 8, entries: 1, value: 3 })
  })

  test('tracker setup and Insights remain usable across responsive widths and both themes', async ({ page }) => {
    const tracker = await createTracker(page, 'V8 Responsive', 'quantity')
    const sizes = [320, 360, 390, 430, 768, 1024, 1440]
    for (const route of ['/trackers/new', '/analytics']) {
      await page.goto(`/#${route}`)
      for (const width of sizes) {
        await page.setViewportSize({ width, height: 844 })
        for (const theme of ['light', 'dark'] as const) {
          await page.evaluate((mode) => mode === 'dark' ? document.documentElement.dataset.theme = 'dark' : delete document.documentElement.dataset.theme, theme)
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), { message: `${route} overflow at ${width}px in ${theme} theme` }).toBe(true)
        }
      }
    }
    await page.goto('/#/analytics')
    await page.getByRole('combobox', { name: 'Tracker', exact: true }).selectOption(tracker.id)
    await expect(page.getByRole('heading', { name: tracker.name })).toBeVisible()
  })
})
