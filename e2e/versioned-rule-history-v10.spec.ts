import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import type { TrackerDefinition } from '../src/domain/trackers/types'

const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH!
const DAY_MS = 86_400_000
const fixtureEmails = {
  primary: 'browser-achievement-e2e@progress-tracker.invalid',
  retrospective: 'browser-rule-history-retrospective@progress-tracker.invalid',
} as const

type Fixture = { userId: string; email: string; password: string; accessToken: string; refreshToken: string }
type FixtureKey = keyof typeof fixtureEmails
type Seed = { id: string; name: string; today: string; startDate: string; historyDates: string[]; backdatedDate: string }

function readFixture(key: FixtureKey = 'primary'): Fixture {
  const value = JSON.parse(readFileSync(fixturePath, 'utf8')) as { users?: Partial<Record<FixtureKey, Fixture>> }
  const user = value.users?.[key]
  if (!user || !/^[0-9a-f-]{36}$/i.test(user.userId) || user.email !== fixtureEmails[key] || !user.accessToken || !user.refreshToken) {
    throw new Error(`The versioned rule history suite requires its named disposable local Auth fixture (${key}).`)
  }
  return user
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function utcToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

async function establishSession(page: Page, context: BrowserContext, user: Fixture): Promise<void> {
  await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await page.goto('/#/auth')
  await page.evaluate(async (session) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const client = getSupabaseClient()
    if (!client) throw new Error('The isolated local Supabase browser client is unavailable.')
    const { error } = await client.auth.setSession({ access_token: session.accessToken, refresh_token: session.refreshToken })
    if (error) throw error
  }, user)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 20_000 })
  await page.evaluate(async (userId) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    await localRepository.setTimeZone('UTC', userId)
  }, user.userId)
}

async function seedTracker(page: Page, userId: string, label: string, includeRetirableField = false, withV10History = false): Promise<Seed> {
  const today = utcToday()
  const startDate = shift(today, -10)
  const historyDates = Array.from({ length: 8 }, (_, index) => shift(today, index - 7))
  const tracker: TrackerDefinition = {
    schemaVersion: 9,
    id: randomUUID(),
    name: `Rule history ${label}`,
    description: 'Browser fixture for date-effective tracker evaluation.',
    kind: 'habit',
    status: 'active',
    categoryId: null,
    tags: [],
    icon: 'habit',
    accent: '#315e46',
    schedule: { kind: 'every-day' },
    startDate,
    scheduling: { mode: 'ongoing' },
    metrics: [{
      id: 'sessions',
      name: 'Sessions',
      valueType: 'quantity',
      unit: 'sessions',
      thresholds: { direction: 'increase', minimum: 1, target: 5, streakQualification: 'minimum' },
    }, ...(includeRetirableField ? [{ id: 'bonus', name: 'Bonus', valueType: 'boolean' as const }] : [])],
    qualificationRule: { kind: 'comparison', metricId: 'sessions', operator: 'at-least', value: 3 },
    streakRuleMode: 'same-as-success',
    customFields: includeRetirableField ? [{ id: 'mood', name: 'Mood', type: 'single-select' as const, required: false, position: 0, options: ['Focused', 'Tired'] }] : [],
    milestones: [],
    strictMode: false,
    createdAt: `${startDate}T12:00:00.000Z`,
    updatedAt: `${startDate}T12:00:00.000Z`,
    archivedAt: null,
    deletedAt: null,
  }

  await page.evaluate(async ({ userId, tracker, dates, today, includeRetirableField, withV10History }) => {
    const { activateWorkspace } = await import('/ProgressTracker/src/db/database.ts')
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    let savedTracker = tracker
    if (withV10History) {
      const { trackerEvaluationSnapshot } = await import('/ProgressTracker/src/domain/trackers/ruleVersions.ts')
      savedTracker = {
        ...tracker,
        schemaVersion: 10,
        ruleVersions: [{
          id: crypto.randomUUID(), effectiveFrom: tracker.startDate ?? tracker.createdAt.slice(0, 10), revision: 1,
          application: 'baseline', recordedAt: tracker.createdAt, evaluation: trackerEvaluationSnapshot(tracker),
        }],
      }
    }
    await activateWorkspace(userId)
    await localRepository.saveTracker(savedTracker)
    for (const date of dates) {
      await localRepository.saveTrackerEntry({
        trackerId: tracker.id,
        date,
        outcome: 'recorded',
        // The server has no date-effective custom-field definition snapshot.
        // Only seed the field value on today's date, where the current field
        // definition proves availability; older check-ins keep their measure
        // data without fabricating historical field availability.
        values: { sessions: 3, ...(includeRetirableField ? { bonus: false, ...(date === today ? { 'field:mood': 'Focused' } : {}) } : {}) },
        note: `Keep ${date} intact`,
      })
    }
  }, { userId, tracker, dates: historyDates, today, includeRetirableField, withV10History })

  return { id: tracker.id, name: tracker.name, today, startDate, historyDates, backdatedDate: shift(today, -9) }
}

async function syncTracker(page: Page, userId: string, trackerId: string, expectedSchemaVersion: number) {
  return page.evaluate(async ({ userId, trackerId, expectedSchemaVersion }) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const { openDatabase } = await import('/ProgressTracker/src/db/database.ts')
    const { synchronizeWorkspace } = await import('/ProgressTracker/src/services/supabase/syncEngine.ts')
    const client = getSupabaseClient()
    if (!client) throw new Error('The isolated Supabase client is unavailable.')
    let summary = { uploaded: 0, downloaded: 0, conflicts: 0, failed: 0 }
    let record: { id: string; schema_version: number; definition: TrackerDefinition; server_revision: number } | null = null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      summary = await synchronizeWorkspace(userId, client)
      const { data, error } = await client.from('trackers').select('id,schema_version,definition,server_revision').eq('id', trackerId).maybeSingle()
      if (error) throw new Error(`Could not read the isolated tracker through owner RLS: ${error.message}`)
      record = data
      if (record?.schema_version === expectedSchemaVersion && summary.failed === 0 && summary.conflicts === 0) break
      if (summary.conflicts > 0) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const database = await openDatabase()
    const [operations, conflicts] = await Promise.all([
      database.syncOperations.where('ownerUserId').equals(userId).toArray(),
      database.syncConflicts.where('ownerUserId').equals(userId).toArray(),
    ])
    const relatedOperations = operations.filter((operation) => operation.entityId === trackerId
      || (operation.entity === 'tracker_entry' && 'trackerId' in (operation.payload ?? {}) && operation.payload.trackerId === trackerId))
    const relatedConflicts = conflicts.filter((conflict) => conflict.entityId === trackerId
      || (conflict.entity === 'tracker_entry' && 'trackerId' in conflict.localPayload && conflict.localPayload.trackerId === trackerId))
    return {
      summary,
      record,
      syncState: {
        operations: relatedOperations.map(({ entity, entityId, status, expectedRevision, attempts, lastError }) => ({ entity, entityId, status, expectedRevision, attempts, lastError })),
        conflicts: relatedConflicts.map(({ entity, entityId, reason, remoteRecord }) => ({ entity, entityId, reason, remoteRevision: remoteRecord?.server_revision })),
      },
    }
  }, { userId, trackerId, expectedSchemaVersion })
}

async function dismissAchievementCelebrations(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dialog = page.getByRole('dialog')
    const completion = dialog.getByRole('button', { name: /^(Finish|Done)$/ }).first()
    const close = dialog.getByRole('button', { name: 'Close celebration' })
    const dismissal = await completion.isVisible().catch(() => false) ? completion : close
    if (!await dismissal.isVisible().catch(() => false)) break
    const previousHeading = await dialog.getByRole('heading').first().innerText()
    await dismissal.click()
    await expect.poll(async () => {
      const nextHeading = page.getByRole('dialog').getByRole('heading').first()
      return await nextHeading.isVisible().catch(() => false) ? nextHeading.innerText() : null
    }).not.toBe(previousHeading)
  }
}

async function waitForAuthenticatedUser(page: Page, userId: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async () => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()
    if (!client) return { userId: null, error: 'Supabase client is unavailable.' }
    const { data, error } = await client.auth.getUser()
    return { userId: data.user?.id ?? null, error: error?.message ?? null }
  }), { message: 'the isolated authenticated session should be available before the online sync' })
    .toEqual({ userId, error: null })
}

async function readLocalHistory(page: Page, trackerId: string, asOfDate: string) {
  return page.evaluate(async ({ id, asOfDate }) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    const tracker = await localRepository.getTracker(id)
    const entries = await localRepository.listTrackerEntriesForTracker(id)
    const { evaluateTrackerEntry } = await import('/ProgressTracker/src/domain/trackers/planning.ts')
    const classified = entries.map((entry) => ({ id: entry.id, date: entry.date, values: entry.values, note: entry.note, success: evaluateTrackerEntry(tracker!, entry).qualified }))
    const { calculateStreak } = await import('/ProgressTracker/src/domain/trackers/progression.ts')
    const streak = tracker ? calculateStreak(tracker, entries, asOfDate, new Set(), 'UTC') : null
    return { tracker, classified, streak }
  }, { id: trackerId, asOfDate })
}

async function readTrackerLedger(page: Page, userId: string, trackerId: string) {
  return page.evaluate(async ({ userId, trackerId }) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()
    if (!client) throw new Error('The isolated Supabase client is unavailable.')
    const { data: sources, error: sourceError } = await client.from('progression_event_sources').select('event_id').eq('user_id', userId).eq('tracker_id', trackerId)
    if (sourceError) throw new Error(`Could not read owner-scoped progression sources: ${sourceError.message}`)
    const sourceIds = (sources ?? []).map((source) => source.event_id)
    if (!sourceIds.length) return { awards: [], streakAwards: [], reversals: [] }
    const { data: events, error: eventError } = await client.from('progression_events').select('id,xp_delta,reason_code,effective_date,reverses_event_id').eq('user_id', userId)
    if (eventError) throw new Error(`Could not read owner-scoped progression events: ${eventError.message}`)
    const related = (events ?? []).filter((event) => sourceIds.includes(event.id) || (event.reverses_event_id !== null && sourceIds.includes(event.reverses_event_id)))
    return {
      awards: related.filter((event) => event.reason_code === 'DAILY_CHECK_IN_COMPLETED' && event.xp_delta > 0),
      streakAwards: related.filter((event) => event.reason_code === 'STREAK_MILESTONE' && event.xp_delta > 0),
      reversals: related.filter((event) => event.reason_code === 'AWARD_REVERSAL'),
    }
  }, { userId, trackerId })
}

async function readFirstStepHistory(page: Page, userId: string) {
  return page.evaluate(async (id) => {
    const client = (await import('/ProgressTracker/src/services/supabase/client.ts')).getSupabaseClient()
    if (!client) throw new Error('The isolated Supabase client is unavailable.')
    const [progressResult, eventsResult] = await Promise.all([
      client.from('progression_achievement_progress').select('achievement_id,current_tier').eq('user_id', id).eq('achievement_id', 'first-step').maybeSingle(),
      client.from('progression_achievement_events').select('id,event_type,reverses_event_id').eq('user_id', id).eq('achievement_id', 'first-step').order('recorded_at'),
    ])
    if (progressResult.error) throw new Error(`Could not read owner-scoped achievement progress: ${progressResult.error.message}`)
    if (eventsResult.error) throw new Error(`Could not read owner-scoped achievement history: ${eventsResult.error.message}`)
    return { progress: progressResult.data, events: eventsResult.data ?? [] }
  }, userId)
}

async function editSuccessRule(page: Page, seed: Seed, nextValue: number): Promise<void> {
  await page.goto(`/#/trackers/${seed.id}/edit`)
  await page.locator('.advanced-setup > summary').click()
  await page.locator('details.advanced-subsection > summary').filter({ hasText: /^Success rule$/ }).click()
  const success = page.getByRole('region', { name: 'Success rule' })
  await success.getByRole('spinbutton', { name: 'Value' }).fill(String(nextValue))
  await page.getByRole('button', { name: 'Save changes' }).click()
}

test('applies from today, preserves earlier rules, accepts a backdated value, syncs offline work, and reloads', async ({ page, context }) => {
  const user = readFixture()
  await establishSession(page, context, user)
  const seed = await seedTracker(page, user.userId, randomUUID().slice(0, 8))
  const seeded = await syncTracker(page, user.userId, seed.id, 9)
  expect(seeded.summary, `Sync diagnostics: ${JSON.stringify(seeded.syncState)}`).toMatchObject({ failed: 0, conflicts: 0 })
  expect(seeded.record?.definition.qualificationRule).toMatchObject({ value: 3 })
  const entriesBefore = await readLocalHistory(page, seed.id, seed.today)
  const priorIds = entriesBefore.classified.map((entry) => ({ id: entry.id, date: entry.date, values: entry.values, note: entry.note }))
  expect(entriesBefore.classified.filter((entry) => entry.success)).toHaveLength(8)
  expect(entriesBefore.streak).toMatchObject({ current: 8, longest: 8 })
  await expect.poll(async () => (await readTrackerLedger(page, user.userId, seed.id)).awards).toHaveLength(8)
  await expect.poll(async () => (await readTrackerLedger(page, user.userId, seed.id)).streakAwards).toHaveLength(1)
  await dismissAchievementCelebrations(page)
  const firstStepBefore = await readFirstStepHistory(page, user.userId)
  expect(firstStepBefore.progress).toMatchObject({ achievement_id: 'first-step', current_tier: 1 })
  expect(firstStepBefore.events.map((event) => event.event_type)).toEqual(['unlocked'])

  await editSuccessRule(page, seed, 5)
  await expect(page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })).toBeVisible()
  const dialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  const cards = dialog.locator('label.tracker-history-option')
  await expect(cards).toHaveCount(3)
  expect(await cards.evaluateAll((items) => items.map((item) => item.className))).toEqual([
    'tracker-history-option', 'tracker-history-option', 'tracker-history-option',
  ])
  await expect(dialog.getByRole('radio', { name: /Apply from today/ })).toBeChecked()
  await context.setOffline(true)
  await dialog.getByRole('button', { name: 'Apply from today' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const prospective = await readLocalHistory(page, seed.id, seed.today)
  expect(prospective.tracker).toMatchObject({ schemaVersion: 10, qualificationRule: { value: 5 } })
  expect(prospective.tracker?.ruleVersions?.map((version) => version.application)).toEqual(['baseline', 'apply-from-today'])
  expect(prospective.tracker?.ruleVersions?.at(-1)?.effectiveFrom).toBe(seed.today)
  expect(prospective.classified.filter((entry) => entry.date < seed.today && entry.success)).toHaveLength(7)
  expect(prospective.streak).toMatchObject({ current: 7, longest: 7 })
  expect(prospective.classified.find((entry) => entry.date === seed.today)?.success).toBe(false)
  expect(prospective.classified.map(({ id, date, values, note }) => ({ id, date, values, note }))).toEqual(priorIds)

  await page.evaluate(async ({ trackerId, date }) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    await localRepository.saveTrackerEntry({ trackerId, date, outcome: 'recorded', values: { sessions: 3 }, note: `Keep ${date} intact` })
  }, { trackerId: seed.id, date: seed.backdatedDate })
  const backdated = await readLocalHistory(page, seed.id, seed.today)
  expect(backdated.classified.find((entry) => entry.date === seed.backdatedDate)).toMatchObject({ success: true, values: { sessions: 3 }, note: `Keep ${seed.backdatedDate} intact` })

  await context.setOffline(false)
  await waitForAuthenticatedUser(page, user.userId)
  const synced = await syncTracker(page, user.userId, seed.id, 10)
  expect(synced.summary, `Sync diagnostics: ${JSON.stringify(synced.syncState)}`).toMatchObject({ failed: 0, conflicts: 0 })
  expect(synced.record?.definition.ruleVersions?.map((version) => version.application)).toEqual(['baseline', 'apply-from-today'])
  const persisted = await readTrackerLedger(page, user.userId, seed.id)
  expect(persisted.awards).toHaveLength(9)
  expect(persisted.streakAwards).toHaveLength(1)
  expect(persisted.reversals).toHaveLength(1)
  expect(await readFirstStepHistory(page, user.userId)).toMatchObject({
    progress: { achievement_id: 'first-step', current_tier: 1 },
    events: [{ event_type: 'unlocked', reverses_event_id: null }],
  })
  await page.reload()
  await page.goto(`/#/trackers/${seed.id}/edit`)
  await expect(page.getByRole('textbox', { name: 'What habit do you want to build?' })).toHaveValue(seed.name)
  const reloaded = await readLocalHistory(page, seed.id, seed.today)
  expect(reloaded.tracker?.ruleVersions?.at(-1)?.effectiveFrom).toBe(seed.today)
  expect(reloaded.classified.find((entry) => entry.date === seed.backdatedDate)?.success).toBe(true)
  expect(reloaded.streak).toMatchObject({ current: 7, longest: 7 })
})

test('converges an offline rule edit and another device’s backdated entry after synchronization', async ({ page, context }) => {
  const user = readFixture()
  await establishSession(page, context, user)
  const browser = context.browser()
  if (!browser) throw new Error('The multi-device browser verification requires a Chromium browser instance.')
  const currentUrl = new URL(page.url())
  const secondContext = await browser.newContext({
    baseURL: `${currentUrl.origin}${currentUrl.pathname}`,
    viewport: { width: 1280, height: 900 },
  })
  try {
    const secondPage = await secondContext.newPage()
    await establishSession(secondPage, secondContext, user)
    await secondPage.evaluate(async (userId) => {
      const { activateWorkspace } = await import('/ProgressTracker/src/db/database.ts')
      await activateWorkspace(userId)
    }, user.userId)

    const seed = await seedTracker(page, user.userId, randomUUID().slice(0, 8))
    const initialSync = await syncTracker(page, user.userId, seed.id, 9)
    expect(initialSync.summary, `Device A sync diagnostics: ${JSON.stringify(initialSync.syncState)}`).toMatchObject({ failed: 0, conflicts: 0 })
    await dismissAchievementCelebrations(page)
    const secondDeviceSync = await syncTracker(secondPage, user.userId, seed.id, 9)
    expect(secondDeviceSync.summary, `Device B download diagnostics: ${JSON.stringify(secondDeviceSync.syncState)}`).toMatchObject({ failed: 0, conflicts: 0 })

    await secondPage.evaluate(async ({ trackerId, date }) => {
      const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
      await localRepository.saveTrackerEntry({ trackerId, date, outcome: 'recorded', values: { sessions: 3 }, note: `Cross-device ${date}` })
    }, { trackerId: seed.id, date: seed.backdatedDate })
    const entrySync = await syncTracker(secondPage, user.userId, seed.id, 9)
    expect(entrySync.summary, `Device B backdated-entry diagnostics: ${JSON.stringify(entrySync.syncState)}`).toMatchObject({ failed: 0, conflicts: 0 })
    expect((await readLocalHistory(secondPage, seed.id, seed.today)).classified.find((entry) => entry.date === seed.backdatedDate))
      .toMatchObject({ success: true, values: { sessions: 3 }, note: `Cross-device ${seed.backdatedDate}` })

    await editSuccessRule(page, seed, 5)
    const choice = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
    await expect(choice).toBeVisible()
    await expect(choice.getByRole('radio', { name: /Apply from today/ })).toBeChecked()
    await context.setOffline(true)
    await choice.getByRole('button', { name: 'Apply from today' }).click()
    await expect(page).toHaveURL(/#\/trackers$/)
    const offline = await readLocalHistory(page, seed.id, seed.today)
    expect(offline.tracker?.ruleVersions?.at(-1)?.effectiveFrom).toBe(seed.today)
    const otherDeviceOffline = await readLocalHistory(secondPage, seed.id, seed.today)
    expect(otherDeviceOffline.classified.find((entry) => entry.date === seed.backdatedDate)?.success).toBe(true)

    await context.setOffline(false)
    await waitForAuthenticatedUser(page, user.userId)
    const deviceASync = await syncTracker(page, user.userId, seed.id, 10)
    expect(deviceASync.summary, `Device A rule-sync diagnostics: ${JSON.stringify(deviceASync.syncState)}`).toMatchObject({ failed: 0, conflicts: 0 })
    const deviceBSync = await syncTracker(secondPage, user.userId, seed.id, 10)
    expect(deviceBSync.summary, `Device B convergence diagnostics: ${JSON.stringify(deviceBSync.syncState)}`).toMatchObject({ failed: 0, conflicts: 0 })
    const [deviceAHistory, deviceBHistory] = await Promise.all([
      readLocalHistory(page, seed.id, seed.today),
      readLocalHistory(secondPage, seed.id, seed.today),
    ])
    expect(deviceBHistory.tracker?.ruleVersions).toEqual(deviceAHistory.tracker?.ruleVersions)
    const summarize = (history: typeof deviceAHistory) => history.classified
      .map(({ id, date, values, note, success }) => ({ id, date, values, note, success }))
      .sort((left, right) => left.date.localeCompare(right.date))
    expect(summarize(deviceBHistory)).toEqual(summarize(deviceAHistory))
    expect(deviceBHistory.streak).toEqual(deviceAHistory.streak)
    expect(deviceAHistory.classified.find((entry) => entry.date === seed.backdatedDate)?.success).toBe(true)
    expect(deviceBHistory.classified.find((entry) => entry.date === seed.backdatedDate)?.success).toBe(true)
  } finally {
    await secondContext.close()
  }
})

test('recalculates all saved history explicitly and reverses only newly ineligible awards', async ({ page, context }) => {
  const user = readFixture('retrospective')
  await establishSession(page, context, user)
  const seed = await seedTracker(page, user.userId, randomUUID().slice(0, 8), false, true)
  const seeded = await syncTracker(page, user.userId, seed.id, 10)
  expect(seeded.summary, `Sync diagnostics: ${JSON.stringify(seeded.syncState)}`).toMatchObject({ failed: 0, conflicts: 0 })
  await expect.poll(async () => (await readTrackerLedger(page, user.userId, seed.id)).awards).toHaveLength(8)
  await expect.poll(async () => (await readTrackerLedger(page, user.userId, seed.id)).streakAwards).toHaveLength(1)
  await dismissAchievementCelebrations(page)
  const before = await readLocalHistory(page, seed.id, seed.today)
  const rawBefore = before.classified.map(({ id, date, values, note }) => ({ id, date, values, note }))

  await editSuccessRule(page, seed, 5)
  const dialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(dialog).toBeVisible()
  const cards = dialog.locator('label.tracker-history-option')
  await expect(cards).toHaveCount(3)
  expect(await cards.evaluateAll((items) => items.map((item) => item.className))).toEqual([
    'tracker-history-option', 'tracker-history-option', 'tracker-history-option',
  ])
  await expect(dialog.getByRole('radio', { name: /Apply from today \(recommended\)/ })).toBeChecked()
  await dialog.getByRole('radio', { name: /Apply to all history/ }).check()
  await expect(dialog.getByRole('button', { name: 'Apply to all history' })).toBeEnabled()
  await context.setOffline(true)
  await dialog.getByRole('button', { name: 'Apply to all history' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const local = await readLocalHistory(page, seed.id, seed.today)
  expect(local.tracker).toMatchObject({ schemaVersion: 10, qualificationRule: { value: 5 } })
  expect(local.tracker?.ruleVersions).toHaveLength(1)
  expect(local.tracker?.ruleVersions?.[0]).toMatchObject({ application: 'recalculate-all-history', effectiveFrom: seed.startDate })
  expect(local.classified.some((entry) => entry.success)).toBe(false)
  expect(local.streak).toMatchObject({ current: 0, longest: 0 })
  expect(local.classified.map(({ id, date, values, note }) => ({ id, date, values, note }))).toEqual(rawBefore)

  await context.setOffline(false)
  await waitForAuthenticatedUser(page, user.userId)
  const synced = await syncTracker(page, user.userId, seed.id, 10)
  expect(synced.summary, `Sync diagnostics: ${JSON.stringify(synced.syncState)}`).toMatchObject({ failed: 0, conflicts: 0 })
  const reconciled = await readTrackerLedger(page, user.userId, seed.id)
  expect(reconciled.awards).toHaveLength(8)
  expect(reconciled.streakAwards).toHaveLength(1)
  expect(reconciled.reversals).toHaveLength(9)
  expect(await readFirstStepHistory(page, user.userId)).toMatchObject({
    progress: { achievement_id: 'first-step', current_tier: 0 },
    events: [{ event_type: 'unlocked', reverses_event_id: null }, { event_type: 'revoked', reverses_event_id: expect.any(String) }],
  })
  await dismissAchievementCelebrations(page)
  const repeated = await syncTracker(page, user.userId, seed.id, 10)
  expect(repeated.summary).toMatchObject({ failed: 0, conflicts: 0 })
  expect(await readTrackerLedger(page, user.userId, seed.id)).toMatchObject({ awards: reconciled.awards, reversals: reconciled.reversals })
  await page.reload()
  const afterReload = await readLocalHistory(page, seed.id, seed.today)
  expect(afterReload.classified.every((entry) => !entry.success)).toBe(true)
  expect(afterReload.streak).toMatchObject({ current: 0, longest: 0 })

  await editSuccessRule(page, seed, 3)
  const reapplyDialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(reapplyDialog).toBeVisible()
  await reapplyDialog.getByRole('radio', { name: /Apply to all history/ }).check()
  await reapplyDialog.getByRole('button', { name: 'Apply to all history' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const requalified = await syncTracker(page, user.userId, seed.id, 10)
  expect(requalified.summary).toMatchObject({ failed: 0, conflicts: 0 })
  await expect.poll(async () => {
    const ledger = await readTrackerLedger(page, user.userId, seed.id)
    return { awards: ledger.awards.length, streakAwards: ledger.streakAwards.length, reversals: ledger.reversals.length }
  }, { timeout: 30_000 }).toEqual({ awards: 16, streakAwards: 2, reversals: 9 })
  const requalifiedLedger = await readTrackerLedger(page, user.userId, seed.id)
  expect(requalifiedLedger.awards).toHaveLength(16)
  expect(requalifiedLedger.streakAwards).toHaveLength(2)
  expect(requalifiedLedger.reversals).toHaveLength(9)
  await expect.poll(async () => (await readFirstStepHistory(page, user.userId)).events.map((event) => event.event_type))
    .toEqual(['unlocked', 'revoked', 'unlocked'])
  expect((await readFirstStepHistory(page, user.userId)).events.map((event) => event.event_type)).toEqual(['unlocked', 'revoked', 'unlocked'])
  const requalifiedLocal = await readLocalHistory(page, seed.id, seed.today)
  expect(requalifiedLocal.streak).toMatchObject({ current: 8, longest: 8 })
})

test('structural v10 edits defer past today’s check-in and explain disabled choices', async ({ page }) => {
  const user = readFixture()
  await establishSession(page, page.context(), user)
  const seed = await seedTracker(page, user.userId, randomUUID().slice(0, 8), true)
  const initialSync = await syncTracker(page, user.userId, seed.id, 9)
  expect(initialSync.summary).toMatchObject({ failed: 0, conflicts: 0 })
  // The seed history can create a real level-up celebration during initial sync;
  // dismiss it before exercising the independent tracker editor flow.
  await dismissAchievementCelebrations(page)

  await editSuccessRule(page, seed, 5)
  const compatible = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(compatible).toBeVisible()
  await compatible.getByRole('button', { name: 'Apply from today' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const v10Sync = await syncTracker(page, user.userId, seed.id, 10)
  expect(v10Sync.summary).toMatchObject({ failed: 0, conflicts: 0 })

  await page.goto(`/#/trackers/${seed.id}/edit`)
  await page.locator('.advanced-setup > summary').click()
  await page.locator('details.advanced-subsection').filter({ hasText: 'Measures, precision & targets' }).locator('summary').click()
  const retireMeasureButtons = page.getByRole('button', { name: 'Retire measure' })
  await expect(retireMeasureButtons).toHaveCount(2)
  page.once('dialog', (dialog) => dialog.accept())
  await retireMeasureButtons.nth(1).click()
  await expect(page.getByRole('article', { name: 'Bonus measure' }).locator('strong')).toContainText('Retired')
  await page.getByRole('button', { name: 'Save changes' }).click()
  const structural = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(structural).toBeVisible()
  await expect(structural.getByRole('radio', { name: 'After the last check-in' })).toBeChecked()
  const today = seed.today
  const tomorrow = shift(today, 1)
  const displayedDate = await page.evaluate((date) => new Date(`${date}T12:00:00.000Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }), tomorrow)
  await expect(structural.getByText(`Your changes will start on ${displayedDate} in UTC. Starting earlier would require removing conflicting check-ins through the normal check-in workflow.`)).toBeVisible()
  await expect(structural.getByRole('radio', { name: /Apply from today/ })).toBeDisabled()
  await expect(structural.getByRole('radio', { name: /Apply to all history/ })).toBeDisabled()
  await expect(structural.locator('#apply-today-help')).toContainText('Unavailable:')
  await expect(structural.locator('#all-history-help')).toContainText('Unavailable:')
  await structural.getByRole('button', { name: 'After the last check-in' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const result = await readLocalHistory(page, seed.id, tomorrow)
  expect(result.tracker?.ruleVersions?.at(-1)).toMatchObject({ effectiveFrom: tomorrow, application: 'apply-from-today', historyPolicy: 'after-last-check-in' })
  expect(result.tracker?.metrics?.[1]).toMatchObject({ id: 'bonus', retiredAt: expect.any(String) })
  expect(result.classified.find((entry) => entry.date === today)).toMatchObject({ values: { sessions: 3, bonus: false, 'field:mood': 'Focused' } })
})

test('Escape and Cancel discard no local fields and do not persist the pending rule change', async ({ page, context }) => {
  const user = readFixture()
  await establishSession(page, context, user)
  const seed = await seedTracker(page, user.userId, randomUUID().slice(0, 8))
  await syncTracker(page, user.userId, seed.id, 9)
  await dismissAchievementCelebrations(page)

  await editSuccessRule(page, seed, 5)
  let dialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: 'Success rule' }).getByRole('spinbutton', { name: 'Value' })).toHaveValue('5')
  expect((await readLocalHistory(page, seed.id, seed.today)).tracker).toMatchObject({ schemaVersion: 9, qualificationRule: { value: 3 } })

  await page.getByRole('button', { name: 'Save changes' }).click()
  dialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: 'Success rule' }).getByRole('spinbutton', { name: 'Value' })).toHaveValue('5')
  expect((await readLocalHistory(page, seed.id, seed.today)).tracker).toMatchObject({ schemaVersion: 9, qualificationRule: { value: 3 } })
})

test('keeps both rule modes readable and operable at desktop and mobile widths', async ({ page, context }) => {
  const user = readFixture()
  await establishSession(page, context, user)
  const seed = await seedTracker(page, user.userId, randomUUID().slice(0, 8), false, true)
  await syncTracker(page, user.userId, seed.id, 10)
  await dismissAchievementCelebrations(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await editSuccessRule(page, seed, 5)
  let dialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(dialog).toBeVisible()
  const mobileBounds = await dialog.evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    viewport: document.documentElement.clientWidth,
  }))
  expect(mobileBounds.left).toBeGreaterThanOrEqual(0)
  expect(mobileBounds.right).toBeLessThanOrEqual(mobileBounds.viewport + 1)
  await dialog.getByRole('radio', { name: /Apply to all history/ }).check()
  await expect(dialog.getByRole('button', { name: 'Apply to all history' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: 'Save changes' }).click()
  dialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(dialog).toBeVisible()
  const desktopBounds = await dialog.evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    viewport: document.documentElement.clientWidth,
  }))
  expect(desktopBounds.left).toBeGreaterThanOrEqual(0)
  expect(desktopBounds.right).toBeLessThanOrEqual(desktopBounds.viewport + 1)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})
