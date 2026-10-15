import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const DAY = 86_400_000
const shift = (date: string, amount: number) => new Date(Date.parse(`${date}T00:00:00.000Z`) + amount * DAY).toISOString().slice(0, 10)
const currentDate = () => new Date().toISOString().slice(0, 10)

type AuthFixture = { userId: string; email: string; password: string }

async function signIn(page: Page, fixture: AuthFixture) {
  await page.goto('/#/auth')
  await page.getByRole('button', { name: 'Use password' }).click()
  await page.getByLabel('Email address').last().fill(fixture.email)
  await page.getByLabel('Password').fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 50_000 })
}

test('unified scheduling flows through setup, holidays, check-ins, Goals, History, offline storage, and account sync', async ({ page, context }) => {
  const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progression-playwright-auth.json'
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as AuthFixture
  await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await signIn(page, fixture)

  const dates = { today: currentDate(), finish: shift(currentDate(), 2), extended: shift(currentDate(), 3) }
  const ids = {
    calendar: '60000000-0000-4000-8000-000000000601',
    challenge: '60000000-0000-4000-8000-000000000602',
    ongoing: '60000000-0000-4000-8000-000000000603',
    cumulative: '60000000-0000-4000-8000-000000000604',
    daily: '60000000-0000-4000-8000-000000000605',
  }
  await page.evaluate(async ({ userId, dates, ids }) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    await localRepository.setTimeZone('UTC', userId)
    const base = {
      schemaVersion: 6 as const, description: '', status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '',
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
      customFields: [], milestones: [], strictMode: false,
      createdAt: `${dates.today}T12:00:00.000Z`, updatedAt: new Date().toISOString(), archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker({ ...base, id: ids.calendar, name: 'E2E Calendar tracker', kind: 'habit', schedule: { kind: 'every-day' }, startDate: dates.today, deadline: dates.finish, scheduling: { mode: 'calendar' } })
    await localRepository.saveTracker({ ...base, id: ids.challenge, name: 'E2E Effective challenge', kind: 'challenge', schedule: { kind: 'every-day' }, startDate: dates.today, deadline: dates.finish, scheduling: { mode: 'effective', effectiveDays: 3, planningTimeZone: 'UTC' } })
    await localRepository.saveTracker({ ...base, id: ids.ongoing, name: 'E2E Ongoing tracker', kind: 'project', schedule: { kind: 'weekdays' }, startDate: dates.today, scheduling: { mode: 'ongoing' } })
    await localRepository.saveTracker({
      ...base, id: ids.cumulative, name: 'E2E Cumulative Goal', kind: 'goal', schedule: { kind: 'every-day' }, startDate: dates.today, deadline: dates.finish,
      scheduling: { mode: 'effective', effectiveDays: 3, planningTimeZone: 'UTC' },
      metrics: [{ id: 'chapters', name: 'Chapters', valueType: 'quantity', unit: 'chapters', thresholds: { direction: 'increase', target: 1, streakQualification: 'target' } }],
      qualificationRule: { kind: 'threshold', metricId: 'chapters', level: 'target' },
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { chapters: 'incremental' }, dailyTargets: {}, cumulativeTargets: { chapters: 20 }, allocations: { chapters: {} }, manualAllocations: { chapters: { [dates.finish]: 2 } }, planningTimeZone: 'UTC' },
    })
    await localRepository.saveTrackerEntry({ trackerId: ids.cumulative, date: dates.today, outcome: 'recorded', values: { chapters: 4 }, note: 'Keep completed work' })
    await localRepository.saveTracker({
      ...base, id: ids.daily, name: 'E2E Daily Goal', kind: 'goal', schedule: { kind: 'weekdays' }, startDate: dates.today,
      metrics: [{ id: 'chapters', name: 'Chapters', valueType: 'quantity', unit: 'chapters', thresholds: { direction: 'increase', target: 1, streakQualification: 'target' } }],
      qualificationRule: { kind: 'threshold', metricId: 'chapters', level: 'target' }, scheduling: { mode: 'ongoing' },
      goalPlanning: { mode: 'daily-recurring', progressSemantics: {}, dailyTargets: { chapters: 2 }, cumulativeTargets: {}, planningTimeZone: 'UTC' },
    })
  }, { userId: fixture.userId, dates, ids })

  const readScheduling = (id: string) => page.evaluate(async (trackerId) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    const tracker = await localRepository.getTracker(trackerId)
    return { schemaVersion: tracker?.schemaVersion, scheduling: tracker?.scheduling, deadline: tracker?.deadline, manual: tracker?.goalPlanning?.manualAllocations?.chapters, goalPlanning: tracker?.goalPlanning }
  }, id)
  await expect.poll(() => readScheduling(ids.cumulative)).toMatchObject({ deadline: dates.finish, scheduling: { mode: 'effective', effectiveDays: 3 } })
  expect(await readScheduling(ids.calendar)).toMatchObject({ deadline: dates.finish, scheduling: { mode: 'calendar' } })
  expect(await readScheduling(ids.ongoing)).toMatchObject({ deadline: undefined, scheduling: { mode: 'ongoing' } })

  await page.goto('/')
  await expect(page.getByRole('button', { name: /Open E2E Effective challenge/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Open E2E Daily Goal/ })).toBeVisible()
  await page.getByRole('button', { name: /Open E2E Effective challenge/ }).click()
  await expect(page.getByRole('dialog', { name: 'E2E Effective challenge' })).toContainText('Day 1 of 3')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Save check-in' }).click()
  await expect(page.getByText(/Saved on this device/)).toBeVisible()
  await page.getByRole('button', { name: 'Close check-in details' }).click()

  await page.getByRole('button', { name: /Open E2E Daily Goal/ }).click()
  await page.getByRole('spinbutton', { name: 'Chapters' }).fill('2')
  await page.getByRole('button', { name: 'Save check-in' }).click()
  await expect(page.getByText(/Saved on this device/)).toBeVisible()
  await page.getByRole('button', { name: 'Close check-in details' }).click()

  await page.getByRole('button', { name: /Open E2E Calendar tracker/ }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Save check-in' }).click()
  await expect(page.getByText(/Saved on this device/)).toBeVisible()
  await page.getByRole('button', { name: 'Close check-in details' }).click()

  await page.goto('/#/holidays')
  await page.getByLabel('From').fill(dates.finish)
  await page.getByLabel('Through').fill(dates.finish)
  await page.getByRole('button', { name: 'Mark holiday' }).click()
  await expect(page.getByRole('status', { name: 'Holiday added' })).toBeVisible()
  await expect.poll(() => readScheduling(ids.cumulative)).toMatchObject({ deadline: dates.extended })
  expect(await readScheduling(ids.calendar)).toMatchObject({ deadline: dates.finish })
  expect(await readScheduling(ids.cumulative)).toMatchObject({ manual: { [dates.finish]: 2 }, goalPlanning: { cumulativeTargets: { chapters: 20 } } })
  const completedEntry = await page.evaluate(async ({ trackerId, date }) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    const entry = await localRepository.getTrackerEntry(trackerId, date)
    return entry?.values
  }, { trackerId: ids.cumulative, date: dates.today })
  expect(completedEntry).toEqual({ chapters: 4 })

  await page.goto('/#/goals')
  await page.getByRole('button', { name: /E2E Cumulative Goal.*View progress details/ }).click()
  await page.getByText('View daily plan').click()
  await page.getByText('Daily schedule').click()
  await expect(page.getByRole('status').filter({ hasText: 'future Manual allocation' })).toContainText('holiday')
  await expect(page.getByRole('button', { name: 'Remove these future overrides' })).toBeVisible()
  await expect(page.getByText('2 Auto days', { exact: true })).toBeVisible()

  await page.goto('/#/holidays')
  await page.getByRole('button', { name: `More actions for ${dates.finish}` }).click()
  await page.getByRole('menuitem', { name: 'Remove holiday' }).click()
  await expect.poll(() => readScheduling(ids.cumulative)).toMatchObject({ deadline: dates.finish })
  await page.goto('/#/goals')
  await page.getByRole('button', { name: /E2E Cumulative Goal.*View progress details/ }).click()
  await page.getByText('View daily plan').click()
  await page.getByText('Daily schedule').click()
  await expect(page.getByText('1 Auto days', { exact: true })).toBeVisible()

  await page.goto(`/#/trackers/${ids.calendar}/edit`)
  await page.getByLabel('Schedule duration').selectOption('effective')
  await page.getByLabel('Target effective days').fill('3')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { name: 'E2E Calendar tracker' })).toBeVisible()
  await expect.poll(() => readScheduling(ids.calendar)).toMatchObject({ scheduling: { mode: 'effective', effectiveDays: 3 }, deadline: dates.finish })

  await page.goto('/#/trackers')
  await expect(page.getByRole('heading', { name: 'E2E Ongoing tracker' })).toBeVisible()
  await expect(page.getByLabel('Challenge Day 1 of 3')).toBeVisible()
  await page.goto('/#/goals')
  await expect(page.getByText('Effective Day 1 of 3')).toBeVisible()
  await page.getByRole('button', { name: /E2E Cumulative Goal.*View progress details/ }).click()
  await page.getByText('View daily plan').click()
  await page.getByText('Daily schedule').click()
  await expect(page.getByText('Manual', { exact: true })).toBeVisible()
  await expect(page.getByText('20 chapters total', { exact: true })).toBeVisible()

  await page.goto('/#/holidays')
  await page.getByLabel('From').fill(dates.today)
  await page.getByLabel('Through').fill(dates.today)
  await page.getByRole('button', { name: 'Mark holiday' }).click()
  await expect(page.getByRole('status', { name: 'Holiday added' })).toBeVisible()
  await page.goto('/')
  await expect(page.getByRole('button', { name: /Open E2E Effective challenge/ })).toContainText('Holiday · next is Day 1')
  await page.getByRole('button', { name: /Open E2E Effective challenge/ }).click()
  await expect(page.getByRole('dialog', { name: 'E2E Effective challenge' })).toContainText('Holiday · next is Day 1')
  await page.getByRole('button', { name: 'Close check-in details' }).click()
  await page.goto('/#/trackers')
  await expect(page.getByLabel('Challenge Holiday · next is Day 1')).toBeVisible()
  await page.goto(`/#/history?date=${dates.today}`)
  await expect(page.locator('.history-entry-card').filter({ hasText: 'E2E Effective challenge' })).toContainText('Holiday · next is Day 1')

  for (const width of [320, 360, 390, 430]) {
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 844 })
      await page.evaluate((value) => value === 'dark' ? document.documentElement.dataset.theme = 'dark' : delete document.documentElement.dataset.theme, theme)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    }
  }

  await page.goto('/#/trackers/new')
  await context.setOffline(true)
  await page.getByLabel('What habit do you want to build?').fill('E2E Offline Ongoing')
  await page.getByLabel('Schedule duration').selectOption('ongoing')
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: /You’re ready to begin/ })).toBeVisible()
  const offlineTracker = await page.evaluate(async () => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    const tracker = (await localRepository.listTrackers()).find((item) => item.name === 'E2E Offline Ongoing')
    return { id: tracker?.id, scheduling: tracker?.scheduling, deadline: tracker?.deadline }
  })
  expect(offlineTracker).toMatchObject({ scheduling: { mode: 'ongoing' }, deadline: undefined })
  await context.setOffline(false)
  await page.reload()
  await expect.poll(() => page.evaluate(async () => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    return (await localRepository.listTrackers()).some((item) => item.name === 'E2E Offline Ongoing')
  })).toBe(true)
  await page.setViewportSize({ width: 390, height: 1100 })
  await page.goto('/#/auth')
  if (await page.getByRole('button', { name: 'Use password' }).isVisible().catch(() => false)) await signIn(page, fixture)
  const syncButton = page.getByRole('button', { name: 'Sync this account' })
  await expect(syncButton).toBeVisible({ timeout: 60_000 })
  let syncStarted = false
  for (let attempt = 0; attempt < 20 && !syncStarted; attempt += 1) {
    const dismissRemaining = page.getByRole('button', { name: 'Dismiss remaining' })
    const closeCelebration = page.getByRole('button', { name: 'Close celebration' })
    const finishCelebration = page.getByRole('button', { name: 'Finish', exact: true })
    if (await dismissRemaining.isVisible().catch(() => false)) {
      await dismissRemaining.click()
    } else if (await closeCelebration.isVisible().catch(() => false)) {
      await closeCelebration.click()
    } else if (await finishCelebration.isVisible().catch(() => false)) {
      await finishCelebration.click()
    } else {
      try {
        await syncButton.click({ timeout: 1_500 })
        syncStarted = true
      } catch (error) {
        const celebrationVisible = await page.getByRole('dialog').isVisible().catch(() => false)
        if (!celebrationVisible) throw error
      }
    }
  }
  expect(syncStarted).toBe(true)
  await expect(page.getByRole('button', { name: 'Syncing…' })).toBeHidden({ timeout: 60_000 })
  await expect.poll(async () => page.evaluate(async (id) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const { data, error } = await getSupabaseClient()!.from('trackers').select('schema_version,definition').eq('id', id).maybeSingle()
    if (error) return error.code
    return data?.definition?.scheduling?.mode ?? null
  }, offlineTracker.id), { timeout: 60_000 }).toBe('ongoing')
  await page.evaluate(() => localStorage.clear())
})

test('all five recurrence choices survive setup, reload, and editing', async ({ page, context }) => {
  const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progression-playwright-auth.json'
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as AuthFixture
  await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await signIn(page, fixture)

  const cases = [
    { name: 'E2E Recurrence Daily', choice: 'every-day', expected: { kind: 'every-day' } },
    { name: 'E2E Recurrence Weekdays', choice: 'weekdays', expected: { kind: 'weekdays' } },
    { name: 'E2E Recurrence Weekends', choice: 'weekends', expected: { kind: 'selected-weekdays', weekdays: [0, 6] } },
    { name: 'E2E Recurrence Saturday', choice: 'custom-days', customDays: [6], expected: { kind: 'selected-weekdays', weekdays: [6] } },
    { name: 'E2E Recurrence Sunday', choice: 'custom-days', customDays: [0], expected: { kind: 'selected-weekdays', weekdays: [0] } },
    { name: 'E2E Recurrence None', choice: 'none', expected: { kind: 'none' } },
  ] as const

  for (const item of cases) {
    await page.goto('/#/trackers/new')
    await page.getByLabel('What habit do you want to build?').fill(item.name)
    await page.getByText('More options').click()
    await page.getByText('Activity schedule & holidays').click()
    await page.getByRole('combobox', { name: 'Activity schedule' }).selectOption(item.choice)
    if (item.choice === 'custom-days') {
      for (const [label, day] of [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]] as const) {
        if (!item.customDays.includes(day)) await page.getByRole('button', { name: label }).click()
      }
    }
    await page.getByRole('button', { name: 'Create tracker' }).click()
    await expect(page.getByRole('heading', { name: /You’re ready to begin/ })).toBeVisible()

    const saved = await page.evaluate(async (name) => {
      const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
      const tracker = (await localRepository.listTrackers()).find((item) => item.name === name)
      return { id: tracker?.id, schedule: tracker?.schedule }
    }, item.name)
    expect(saved.schedule).toEqual(item.expected)

    await page.reload()
    await page.goto(`/#/trackers/${saved.id}/edit`)
    await expect(page.getByRole('heading', { name: 'Edit habit.' })).toBeVisible()
    await page.getByText('More options').click()
    await page.getByText('Activity schedule & holidays').click()
    await expect(page.getByRole('combobox', { name: 'Activity schedule' })).toHaveValue(item.choice === 'custom-days' ? 'custom-days' : item.choice)
    const reloaded = await page.evaluate(async (id) => {
      const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
      return (await localRepository.getTracker(id))?.schedule
    }, saved.id)
    expect(reloaded).toEqual(item.expected)
  }
})

test('both Effective Days counting methods update deadlines through creation, holidays, editing, and reload', async ({ page, context }) => {
  const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progression-playwright-auth.json'
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as AuthFixture
  await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await signIn(page, fixture)
  await page.goto('/#/trackers/new')
  await page.getByLabel('What habit do you want to build?').fill('E2E Planned Effective Days')
  await page.getByLabel('Schedule duration').selectOption('effective')
  await page.getByLabel('Target effective days').fill('3')
  await page.getByLabel('Start date').fill('2026-11-01')
  await page.getByText('More options').click()
  await page.getByText('Activity schedule & holidays').click()
  await page.getByRole('combobox', { name: 'Activity schedule' }).selectOption('weekdays')
  await expect(page.getByRole('radio', { name: 'Only planned activity days' })).toBeChecked()
  await expect(page.getByText(/3 planned activity days · Ends/)).toBeVisible()
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: /You’re ready to begin/ })).toBeVisible()

  const trackerId = await page.evaluate(async () => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    return (await localRepository.listTrackers()).find((item) => item.name === 'E2E Planned Effective Days')?.id
  })
  expect(trackerId).toBeTruthy()
  const readTracker = () => page.evaluate(async (id) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    const tracker = await localRepository.getTracker(id)
    return { schemaVersion: tracker?.schemaVersion, deadline: tracker?.deadline, scheduling: tracker?.scheduling }
  }, trackerId!)
  await expect.poll(readTracker).toMatchObject({ schemaVersion: 7, deadline: '2026-11-04', scheduling: { effectiveDayCounting: 'planned-activity-days' } })

  await page.goto('/#/holidays')
  await page.getByLabel('From').fill('2026-11-02')
  await page.getByLabel('Through').fill('2026-11-02')
  await page.getByRole('button', { name: 'Mark holiday' }).click()
  await expect(page.getByRole('status', { name: 'Holiday added' })).toBeVisible()
  await expect.poll(readTracker).toMatchObject({ deadline: '2026-11-05' })
  await page.getByRole('button', { name: 'More actions for 2026-11-02' }).click()
  await page.getByRole('menuitem', { name: 'Remove holiday' }).click()
  await expect.poll(readTracker).toMatchObject({ deadline: '2026-11-04' })

  await page.goto(`/#/trackers/${trackerId}/edit`)
  await page.getByText('More options').click()
  await page.getByText('Activity schedule & holidays').click()
  await expect(page.getByRole('radio', { name: 'Only planned activity days' })).toBeChecked()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('radio', { name: 'Include rest days too' }).check()
  await expect(page.getByText(/3 non-holiday days · Ends/)).toBeVisible()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { name: 'E2E Planned Effective Days' })).toBeVisible()
  await expect.poll(readTracker).toMatchObject({ schemaVersion: 7, deadline: '2026-11-03', scheduling: { effectiveDayCounting: 'all-non-holiday-days' } })
  await page.reload()
  await expect.poll(readTracker).toMatchObject({ deadline: '2026-11-03', scheduling: { effectiveDayCounting: 'all-non-holiday-days' } })
  await page.goto('/#/auth')
  const syncButton = page.getByRole('button', { name: 'Sync this account' })
  await expect(syncButton).toBeVisible({ timeout: 60_000 })
  await syncButton.click()
  await expect(page.getByRole('button', { name: 'Syncing…' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Syncing…' })).toBeHidden({ timeout: 60_000 })
  await expect.poll(() => page.evaluate(async (id) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const client = getSupabaseClient()
    if (!client) return null
    const { data, error } = await client.from('trackers').select('schema_version,definition').eq('id', id).maybeSingle()
    if (error) return { error: error.code }
    return data ? { schemaVersion: data.schema_version, effectiveDayCounting: data.definition?.scheduling?.effectiveDayCounting } : null
  }, trackerId!), { timeout: 60_000 }).toEqual({ schemaVersion: 7, effectiveDayCounting: 'all-non-holiday-days' })
})
