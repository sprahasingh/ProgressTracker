import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import type { TrackerDefinition } from '../src/domain/trackers/types'

const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progression-tracker-edit-playwright-auth.json'
const fixtureEmail = 'browser-achievement-e2e@progress-tracker.invalid'

type Fixture = { userId: string; email: string; password: string }

function readFixture(): Fixture {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
  if (!/^[0-9a-f-]{36}$/i.test(fixture.userId) || fixture.email !== fixtureEmail || !fixture.password) {
    throw new Error('The focused Tracker Edit suite requires its named disposable Auth fixture.')
  }
  return fixture
}

function streakCureTracker(id: string, version: 7 | 8): TrackerDefinition {
  const base: TrackerDefinition = {
    schemaVersion: version,
    id,
    name: 'Streak Cure',
    description: 'Existing tracker description',
    kind: 'habit',
    status: 'active',
    categoryId: null,
    tags: ['preserve-me'],
    icon: 'habit',
    accent: '#315e46',
    schedule: { kind: 'every-day' },
    startDate: '2026-01-05',
    metrics: [{
      id: 'sessions', name: 'Sessions', valueType: 'quantity', unit: 'sessions',
      thresholds: { direction: 'increase', minimum: 1, target: 5, streakQualification: 'target' },
    }],
    qualificationRule: { kind: 'threshold', metricId: 'sessions', level: 'target' },
    customFields: [],
    milestones: [{ id: 'old-milestone', title: 'First five', description: 'Keep this history reference', metricId: 'sessions', targetValue: 5, position: 0 }],
    strictMode: false,
    createdAt: '2026-01-05T00:00:00.000Z',
    updatedAt: '2026-01-05T00:00:00.000Z',
    archivedAt: null,
    deletedAt: null,
  }
  if (version === 7) return { ...base, scheduling: { mode: 'ongoing' } }
  return {
    ...base,
    schemaVersion: 8,
    scheduling: { mode: 'ongoing' },
    streakRuleMode: 'custom',
    streakRule: { kind: 'comparison', metricId: 'sessions', operator: 'at-least', value: 1 },
  }
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.goto('/#/auth')
  await page.getByRole('button', { name: 'Use password' }).click()
  await page.getByLabel('Email address').last().fill(fixture.email)
  await page.getByLabel('Password').fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 50_000 })
}

async function seedTracker(page: Page, tracker: TrackerDefinition, userId: string): Promise<void> {
  await page.evaluate(async ({ tracker, userId }) => {
    const { activateWorkspace } = await import('/ProgressTracker/src/db/database.ts')
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    await activateWorkspace(userId)
    await localRepository.saveTracker(tracker)
    await localRepository.saveTrackerEntry({
      trackerId: tracker.id,
      date: '2026-10-15',
      outcome: 'recorded',
      values: { sessions: 3 },
      note: 'Historical progress stays unchanged',
    })
  }, { tracker, userId })
}

async function syncAndReadRemote(page: Page, userId: string, trackerId: string, expectedName: string, expectedStreakRuleMode?: TrackerDefinition['streakRuleMode']) {
  return page.evaluate(async ({ userId, trackerId, expectedName, expectedStreakRuleMode }) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const { synchronizeWorkspace } = await import('/ProgressTracker/src/services/supabase/syncEngine.ts')
    const client = getSupabaseClient()
    if (!client) throw new Error('The authenticated local Supabase client is unavailable.')
    let summary = { uploaded: 0, downloaded: 0, conflicts: 0, failed: 0 }
    let record: { id: string; schema_version: number; definition: TrackerDefinition; server_revision: number } | null = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      summary = await synchronizeWorkspace(userId, client)
      const { data, error } = await client.from('trackers').select('id, schema_version, definition, server_revision').eq('id', trackerId).maybeSingle()
      if (error) throw new Error(`Could not read the test tracker through authenticated RLS: ${error.message}`)
      record = data
      if (record?.definition.name === expectedName && (expectedStreakRuleMode === undefined || record.definition.streakRuleMode === expectedStreakRuleMode)) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return { summary, record }
  }, { userId, trackerId, expectedName, expectedStreakRuleMode })
}

async function readProgressionLedger(page: Page, userId: string) {
  return page.evaluate(async (userId) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const client = getSupabaseClient()
    if (!client) throw new Error('The authenticated local Supabase client is unavailable.')
    const [xp, achievements] = await Promise.all([
      client.from('progression_events').select('id, xp_delta, event_category, reason_code').eq('user_id', userId).order('id'),
      client.from('progression_achievement_events').select('id, achievement_id, tier, generation, event_type, source_event_id, reverses_event_id').eq('user_id', userId).order('id'),
    ])
    if (xp.error) throw new Error(`Could not read the test XP ledger through authenticated RLS: ${xp.error.message}`)
    if (achievements.error) throw new Error(`Could not read the test achievement ledger through authenticated RLS: ${achievements.error.message}`)
    return { xp: xp.data, achievements: achievements.data }
  }, userId)
}

test('saves an existing custom Streak Rule offline, then syncs and reloads it without changing history', async ({ page, context }) => {
  const fixture = readFixture()
  const tracker = streakCureTracker(randomUUID(), 8)
  await signIn(page, fixture)
  await seedTracker(page, tracker, fixture.userId)
  const seededRemote = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure', 'custom')
  expect(seededRemote.summary).toMatchObject({ failed: 0, conflicts: 0 })
  const progressionBeforeEdit = await readProgressionLedger(page, fixture.userId)
  await page.goto(`/#/trackers/${tracker.id}/edit`)

  await page.locator('.advanced-setup > summary').click()
  await page.locator('.advanced-subsection').filter({ hasText: 'Streak rule mode' }).locator('summary').click()
  const name = page.getByRole('textbox', { name: 'What habit do you want to build?' })
  await name.fill('Streak Cure updated')
  await page.locator('.tracker-name-field textarea').fill('Description saved alongside the rule.')
  const streakSection = page.getByRole('region', { name: 'Streak rule' })
  await expect(streakSection.getByRole('combobox', { name: 'Streak rule mode' })).toHaveValue('custom')
  await streakSection.getByRole('spinbutton').fill('2')

  await context.setOffline(true)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const localState = await page.evaluate(async (trackerId) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    return {
      tracker: await localRepository.getTracker(trackerId),
      entries: await localRepository.listTrackerEntriesForTracker(trackerId),
    }
  }, tracker.id)
  expect(localState.tracker).toMatchObject({
    id: tracker.id,
    name: 'Streak Cure updated',
    description: 'Description saved alongside the rule.',
    streakRuleMode: 'custom',
    streakRule: { kind: 'comparison', metricId: 'sessions', operator: 'at-least', value: 2 },
    tags: ['preserve-me'],
    milestones: tracker.milestones,
  })
  expect(localState.entries).toHaveLength(1)
  expect(localState.entries[0]).toMatchObject({ date: '2026-10-15', values: { sessions: 3 }, note: 'Historical progress stays unchanged' })

  await context.setOffline(false)
  const synced = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure updated', 'custom')
  expect(synced.summary).toMatchObject({ failed: 0, conflicts: 0 })
  expect(synced.record).toMatchObject({
    id: tracker.id,
    schema_version: 8,
    definition: {
      name: 'Streak Cure updated',
      description: 'Description saved alongside the rule.',
      streakRuleMode: 'custom',
      streakRule: { kind: 'comparison', metricId: 'sessions', operator: 'at-least', value: 2 },
      tags: ['preserve-me'],
      milestones: tracker.milestones,
    },
  })
  await expect.poll(() => readProgressionLedger(page, fixture.userId)).toEqual(progressionBeforeEdit)

  await page.reload()
  await page.goto(`/#/trackers/${tracker.id}/edit`)
  await expect(page.getByRole('textbox', { name: 'What habit do you want to build?' })).toHaveValue('Streak Cure updated')
  await page.locator('.advanced-setup > summary').click()
  await page.locator('.advanced-subsection').filter({ hasText: 'Streak rule mode' }).locator('summary').click()
  const reloadedRule = page.getByRole('region', { name: 'Streak rule' })
  await expect(reloadedRule.getByRole('combobox', { name: 'Streak rule mode' })).toHaveValue('custom')
  await expect(reloadedRule.getByRole('spinbutton')).toHaveValue('2')
})

test('supports switching a saved custom rule off and back on', async ({ page }) => {
  const fixture = readFixture()
  const tracker = streakCureTracker(randomUUID(), 8)
  await signIn(page, fixture)
  await seedTracker(page, tracker, fixture.userId)
  await page.goto(`/#/trackers/${tracker.id}/edit`)
  await page.locator('.advanced-setup > summary').click()
  await page.locator('.advanced-subsection').filter({ hasText: 'Streak rule mode' }).locator('summary').click()
  const mode = page.getByRole('region', { name: 'Streak rule' }).getByRole('combobox', { name: 'Streak rule mode' })
  await mode.selectOption('same-as-success')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const sharedRule = await page.evaluate(async (trackerId) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    return localRepository.getTracker(trackerId)
  }, tracker.id)
  expect(sharedRule).toMatchObject({ schemaVersion: 8, streakRuleMode: 'same-as-success' })
  expect(sharedRule).not.toHaveProperty('streakRule')
  const syncedSharedRule = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure', 'same-as-success')
  expect(syncedSharedRule.summary).toMatchObject({ failed: 0, conflicts: 0 })
  expect(syncedSharedRule.record?.definition).not.toHaveProperty('streakRule')

  await page.goto(`/#/trackers/${tracker.id}/edit`)
  await page.locator('.advanced-setup > summary').click()
  await page.locator('.advanced-subsection').filter({ hasText: 'Streak rule mode' }).locator('summary').click()
  const reenabledMode = page.getByRole('region', { name: 'Streak rule' }).getByRole('combobox', { name: 'Streak rule mode' })
  await reenabledMode.selectOption('custom')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const syncedReenabledRule = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure', 'custom')
  expect(syncedReenabledRule.summary).toMatchObject({ failed: 0, conflicts: 0 })
  expect(syncedReenabledRule.record).toMatchObject({ definition: { streakRule: tracker.qualificationRule } })
  const reenabledRule = await page.evaluate(async (trackerId) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    return localRepository.getTracker(trackerId)
  }, tracker.id)
  expect(reenabledRule).toMatchObject({
    schemaVersion: 8,
    streakRuleMode: 'custom',
    streakRule: tracker.qualificationRule,
  })
})

test('preserves legacy rules and tracker data when editing a schema v7 tracker', async ({ page }) => {
  const fixture = readFixture()
  const tracker = streakCureTracker(randomUUID(), 7)
  await signIn(page, fixture)
  await seedTracker(page, tracker, fixture.userId)
  await page.goto(`/#/trackers/${tracker.id}/edit`)
  await page.getByRole('textbox', { name: 'What habit do you want to build?' }).fill('Streak Cure legacy edit')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)

  const saved = await page.evaluate(async (trackerId) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    return {
      tracker: await localRepository.getTracker(trackerId),
      entries: await localRepository.listTrackerEntriesForTracker(trackerId),
    }
  }, tracker.id)
  expect(saved.tracker).toMatchObject({ schemaVersion: 7, name: 'Streak Cure legacy edit', qualificationRule: tracker.qualificationRule, milestones: tracker.milestones })
  expect(saved.tracker).not.toHaveProperty('streakRuleMode')
  expect(saved.entries).toHaveLength(1)
  expect(saved.entries[0]).toMatchObject({ values: { sessions: 3 }, note: 'Historical progress stays unchanged' })

  const synced = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure legacy edit')
  expect(synced.summary).toMatchObject({ failed: 0, conflicts: 0 })
  expect(synced.record).toMatchObject({ schema_version: 7, definition: { name: 'Streak Cure legacy edit' } })
  expect(synced.record.definition).not.toHaveProperty('streakRuleMode')
})
