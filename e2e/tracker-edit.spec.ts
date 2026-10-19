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

function streakCureTracker(id: string, version: 7 | 8 | 9): TrackerDefinition {
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
  if (version === 9) return {
    ...base,
    schemaVersion: 9,
    scheduling: { mode: 'ongoing' },
    streakRuleMode: 'custom',
    streakRule: { kind: 'comparison', metricId: 'sessions', operator: 'at-least', value: 1 },
    milestones: [{
      id: 'typed-milestone', title: 'Five sessions', description: 'Retained typed milestone',
      type: 'cumulative-quantity', metricId: 'sessions', targetValue: 5, measureTypeSnapshot: 'quantity', unitSnapshot: 'sessions', position: 0,
    }],
  }
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

async function seedTracker(page: Page, tracker: TrackerDefinition, userId: string, history?: { date: string; values: Record<string, unknown>; outcome?: 'recorded' | 'skipped' } | null): Promise<void> {
  await page.evaluate(async ({ tracker, userId, history }) => {
    const { activateWorkspace } = await import('/ProgressTracker/src/db/database.ts')
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    await activateWorkspace(userId)
    await localRepository.saveTracker(tracker)
    const entry = history === undefined ? { date: '2026-10-15', outcome: 'recorded' as const, values: { sessions: 3 } } : history
    if (entry) await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: entry.date, outcome: entry.outcome ?? 'recorded', values: entry.values, note: 'Historical progress stays unchanged' })
  }, { tracker, userId, history })
}

function legacyV6Challenge(id: string): TrackerDefinition {
  return {
    schemaVersion: 6,
    id,
    name: '100 Days Of MERN',
    description: '',
    kind: 'challenge',
    status: 'active',
    categoryId: null,
    tags: [],
    icon: '',
    accent: '#315e46',
    schedule: { kind: 'every-day' },
    startDate: '2026-10-16',
    deadline: '2027-01-23',
    scheduling: { mode: 'effective', effectiveDays: 100, planningTimeZone: 'Asia/Calcutta' },
    metrics: [{
      id: 'progress', name: 'Progress', valueType: 'quantity', unit: 'Hours',
      precision: { decimalPlaces: 1, increment: 0.5 },
      thresholds: { direction: 'increase', minimum: 1, target: 1.5, stretch: 2, streakQualification: 'any-recorded-value' },
    }],
    qualificationRule: { kind: 'threshold', level: 'minimum', metricId: 'progress' },
    customFields: [],
    milestones: [],
    strictMode: false,
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
    archivedAt: null,
    deletedAt: null,
  }
}

async function setCustomStreakRule(page: Page, trackerId: string) {
  await page.goto(`/#/trackers/${trackerId}/edit`)
  await page.locator('.advanced-setup > summary').click()
  await page.locator('.advanced-subsection').filter({ hasText: 'Streak rule mode' }).locator('summary').click()
  const streak = page.getByRole('region', { name: 'Streak rule' })
  await streak.getByRole('combobox', { name: 'Streak rule mode' }).selectOption('custom')
  await streak.locator('.rule-leaf-controls select:not([aria-label])').selectOption('target')
  await page.getByRole('button', { name: 'Save changes' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radio', { name: /Apply from today/ })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Apply from today' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
}

async function createRemoteDeletedSkip(page: Page, trackerId: string, userId: string, entryId: string) {
  return page.evaluate(async ({ trackerId, userId, entryId }) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const client = getSupabaseClient()
    if (!client) throw new Error('The authenticated local Supabase client is unavailable.')
    const original = {
      id: entryId,
      tracker_id: trackerId,
      entry_date: '2026-10-16',
      outcome: 'skipped',
      entry_values: {},
      note: '',
      created_at: '2026-10-16T16:00:00.000Z',
      updated_at: '2026-10-16T16:00:00.000Z',
      deleted_at: null,
    }
    const inserted = await client.rpc('apply_tracker_sync_operation', {
      p_expected_user_id: userId,
      p_operation_id: crypto.randomUUID(),
      p_entity: 'tracker_entry',
      p_expected_revision: null,
      p_record: original,
    })
    if (inserted.error || inserted.data?.status !== 'applied') throw new Error(`Could not seed the local soft-deleted fixture entry: ${inserted.error?.message ?? 'unexpected result'}`)
    const deleted = await client.rpc('apply_tracker_sync_operation', {
      p_expected_user_id: userId,
      p_operation_id: crypto.randomUUID(),
      p_entity: 'tracker_entry',
      p_expected_revision: 1,
      p_record: { ...original, updated_at: '2026-10-16T16:04:23.431Z', deleted_at: '2026-10-16T16:04:23.431Z' },
    })
    if (deleted.error || deleted.data?.status !== 'applied') throw new Error(`Could not seed the local soft-deleted fixture entry: ${deleted.error?.message ?? 'unexpected result'}`)
    return { firstRevision: inserted.data.record.server_revision, tombstone: deleted.data.record }
  }, { trackerId, userId, entryId })
}

async function syncAndReadRemote(page: Page, userId: string, trackerId: string, expectedName: string, expectedStreakRuleMode?: TrackerDefinition['streakRuleMode'], expectedRetiredFieldId?: string) {
  const result = await page.evaluate(async ({ userId, trackerId, expectedName, expectedStreakRuleMode, expectedRetiredFieldId }) => {
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
      const expectedFieldRetired = expectedRetiredFieldId === undefined || record?.definition.customFields?.some((field) => field.id === expectedRetiredFieldId && typeof field.retiredAt === 'string')
      if (record?.definition.name === expectedName && (expectedStreakRuleMode === undefined || record.definition.streakRuleMode === expectedStreakRuleMode) && expectedFieldRetired) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const { db } = await import('/ProgressTracker/src/db/database.ts')
    const [syncRecord, operations, conflicts] = await Promise.all([
      db.syncRecords.get(`tracker:${trackerId}`),
      db.syncOperations.where('entityId').equals(trackerId).toArray(),
      db.syncConflicts.where('entityId').equals(trackerId).toArray(),
    ])
    const diagnostic = {
      remote: record ? { schemaVersion: record.schema_version, serverRevision: record.server_revision } : null,
      localServerRevision: syncRecord?.serverRevision ?? null,
      operations: operations.map((operation) => ({ entity: operation.entity, expectedRevision: operation.expectedRevision, status: operation.status, attempts: operation.attempts })),
      conflicts: conflicts.map((conflict) => ({ entity: conflict.entity, remoteServerRevision: conflict.remoteRecord?.server_revision ?? null })),
    }
    return { summary, record, diagnostic }
  }, { userId, trackerId, expectedName, expectedStreakRuleMode, expectedRetiredFieldId })
  if (result.summary.conflicts > 0) console.log(`Tracker Edit sync diagnostic: ${JSON.stringify(result.diagnostic)}`)
  return result
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
  const ruleHistoryDialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(ruleHistoryDialog).toBeVisible()
  await ruleHistoryDialog.getByRole('button', { name: 'Apply from today' }).click()
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
    schemaVersion: 10,
    name: 'Streak Cure updated',
    description: 'Description saved alongside the rule.',
    streakRuleMode: 'custom',
    streakRule: { kind: 'comparison', metricId: 'sessions', operator: 'at-least', value: 2 },
    tags: ['preserve-me'],
    milestones: tracker.milestones,
    ruleVersions: [
      { effectiveFrom: '2026-01-05', revision: 1, application: 'baseline' },
      { revision: 2, application: 'apply-from-today', evaluation: { streakRuleMode: 'custom', streakRule: { value: 2 } } },
    ],
  })
  expect(localState.entries).toHaveLength(1)
  expect(localState.entries[0]).toMatchObject({ date: '2026-10-15', values: { sessions: 3 }, note: 'Historical progress stays unchanged' })

  await context.setOffline(false)
  const synced = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure updated', 'custom')
  expect(synced.summary, JSON.stringify(synced.diagnostic)).toMatchObject({ failed: 0, conflicts: 0 })
  expect(synced.record).toMatchObject({
    id: tracker.id,
    schema_version: 10,
    definition: {
      name: 'Streak Cure updated',
      description: 'Description saved alongside the rule.',
      streakRuleMode: 'custom',
      streakRule: { kind: 'comparison', metricId: 'sessions', operator: 'at-least', value: 2 },
      tags: ['preserve-me'],
      milestones: tracker.milestones,
      ruleVersions: [
        { effectiveFrom: '2026-01-05', revision: 1, application: 'baseline' },
        { revision: 2, application: 'apply-from-today', evaluation: { streakRuleMode: 'custom', streakRule: { value: 2 } } },
      ],
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
  const sameAsSuccessDialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(sameAsSuccessDialog).toBeVisible()
  await sameAsSuccessDialog.getByRole('button', { name: 'Apply from today' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const sharedRule = await page.evaluate(async (trackerId) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    return localRepository.getTracker(trackerId)
  }, tracker.id)
  expect(sharedRule).toMatchObject({ schemaVersion: 10, streakRuleMode: 'same-as-success' })
  expect(sharedRule).not.toHaveProperty('streakRule')
  const syncedSharedRule = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure', 'same-as-success')
  expect(syncedSharedRule.summary, JSON.stringify(syncedSharedRule.diagnostic)).toMatchObject({ failed: 0, conflicts: 0 })
  expect(syncedSharedRule.record?.definition).not.toHaveProperty('streakRule')

  await page.goto(`/#/trackers/${tracker.id}/edit`)
  await page.locator('.advanced-setup > summary').click()
  await page.locator('.advanced-subsection').filter({ hasText: 'Streak rule mode' }).locator('summary').click()
  const reenabledMode = page.getByRole('region', { name: 'Streak rule' }).getByRole('combobox', { name: 'Streak rule mode' })
  await reenabledMode.selectOption('custom')
  await page.getByRole('button', { name: 'Save changes' }).click()
  const customRuleDialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(customRuleDialog).toBeVisible()
  await customRuleDialog.getByRole('button', { name: 'Apply from today' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const syncedReenabledRule = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure', 'custom')
  expect(syncedReenabledRule.summary).toMatchObject({ failed: 0, conflicts: 0 })
  expect(syncedReenabledRule.record).toMatchObject({ definition: { streakRule: tracker.qualificationRule } })
  const reenabledRule = await page.evaluate(async (trackerId) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    return localRepository.getTracker(trackerId)
  }, tracker.id)
  expect(reenabledRule).toMatchObject({
    schemaVersion: 10,
    streakRuleMode: 'custom',
    streakRule: tracker.qualificationRule,
  })
})

test('edits legacy v6 trackers with no, deleted, and active entries through real tracker sync', async ({ page }) => {
  const fixture = readFixture()
  await signIn(page, fixture)

  const emptyTracker = legacyV6Challenge(randomUUID())
  await seedTracker(page, emptyTracker, fixture.userId, null)
  const emptySeed = await syncAndReadRemote(page, fixture.userId, emptyTracker.id, emptyTracker.name)
  expect(emptySeed.summary).toMatchObject({ uploaded: 1, failed: 0, conflicts: 0 })
  expect(emptySeed.record).toMatchObject({ schema_version: 6, server_revision: 1 })
  expect(emptySeed.record?.definition).not.toHaveProperty('streakRule')
  expect(emptySeed.record?.definition).not.toHaveProperty('streakRuleMode')
  expect(emptySeed.record?.definition.scheduling).not.toHaveProperty('effectiveDayCounting')

  await setCustomStreakRule(page, emptyTracker.id)
  const emptySaved = await syncAndReadRemote(page, fixture.userId, emptyTracker.id, emptyTracker.name, 'custom')
  const today = await page.evaluate(() => {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Calcutta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
    return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}-${parts.find((part) => part.type === 'day')!.value}`
  })
  expect(emptySaved.summary, JSON.stringify(emptySaved.diagnostic)).toMatchObject({ failed: 0, conflicts: 0 })
  expect(emptySaved.record).toMatchObject({
    schema_version: 10,
    server_revision: 2,
    definition: {
      schemaVersion: 10,
      qualificationRule: { kind: 'threshold', metricId: 'progress', level: 'minimum' },
      streakRuleMode: 'custom',
      streakRule: { kind: 'threshold', metricId: 'progress', level: 'target' },
      ruleVersions: [
        { effectiveFrom: '2026-10-16', revision: 1, application: 'baseline', evaluation: { qualificationRule: { level: 'minimum' }, streakRuleMode: null, streakRule: null } },
        { effectiveFrom: today, revision: 2, application: 'apply-from-today', evaluation: { streakRuleMode: 'custom', streakRule: { level: 'target' } } },
      ],
    },
  })
  expect(emptySaved.record?.definition.ruleVersions?.[0]?.evaluation.scheduling).not.toHaveProperty('effectiveDayCounting')

  await page.reload()
  await page.goto(`/#/trackers/${emptyTracker.id}/edit`)
  const reloadedEvaluation = await page.evaluate(async ({ trackerId, today }) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    const { evaluateTrackerEntry } = await import('/ProgressTracker/src/domain/trackers/planning.ts')
    const { qualifiesForStreak } = await import('/ProgressTracker/src/domain/trackers/progression.ts')
    const saved = await localRepository.getTracker(trackerId)
    if (!saved) throw new Error('Reloaded legacy tracker was not available locally.')
    const makeEntry = (date: string) => ({
      id: `evaluation-${date}`, trackerId, date, outcome: 'recorded' as const,
      values: { progress: 0.5 }, note: '', createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, deletedAt: null,
    })
    const historical = makeEntry('2026-10-16')
    const current = makeEntry(today)
    return {
      schemaVersion: saved.schemaVersion,
      rules: saved.ruleVersions?.map((version) => ({ effectiveFrom: version.effectiveFrom, application: version.application })),
      historicalSuccess: evaluateTrackerEntry(saved, historical).qualified,
      historicalStreak: qualifiesForStreak(saved, historical),
      currentStreak: qualifiesForStreak(saved, current),
    }
  }, { trackerId: emptyTracker.id, today })
  expect(reloadedEvaluation).toMatchObject({
    schemaVersion: 10,
    rules: [
      { effectiveFrom: '2026-10-16', application: 'baseline' },
      { effectiveFrom: today, application: 'apply-from-today' },
    ],
    historicalSuccess: false,
    historicalStreak: true,
    currentStreak: false,
  })

  const deletedTracker = legacyV6Challenge(randomUUID())
  await seedTracker(page, deletedTracker, fixture.userId, null)
  const deletedSeed = await syncAndReadRemote(page, fixture.userId, deletedTracker.id, deletedTracker.name)
  expect(deletedSeed.summary).toMatchObject({ failed: 0, conflicts: 0 })
  const deletedEntryId = randomUUID()
  const insertedTombstone = await createRemoteDeletedSkip(page, deletedTracker.id, fixture.userId, deletedEntryId)
  expect(insertedTombstone).toMatchObject({ firstRevision: 1, tombstone: { server_revision: 2, outcome: 'skipped', entry_values: {} } })
  expect(Date.parse(insertedTombstone.tombstone.deleted_at)).toBe(Date.parse('2026-10-16T16:04:23.431Z'))
  const hydratedTombstone = await page.evaluate(async ({ userId, entryId }) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const { synchronizeWorkspace } = await import('/ProgressTracker/src/services/supabase/syncEngine.ts')
    const { db } = await import('/ProgressTracker/src/db/database.ts')
    const client = getSupabaseClient()
    if (!client) throw new Error('The authenticated local Supabase client is unavailable.')
    await synchronizeWorkspace(userId, client)
    return { entry: await db.trackerEntries.get(entryId), revision: await db.syncRecords.get(`tracker_entry:${entryId}`) }
  }, { userId: fixture.userId, entryId: deletedEntryId })
  expect(hydratedTombstone.entry).toMatchObject({ outcome: 'skipped', values: {}, deletedAt: '2026-10-16T16:04:23.431Z' })
  expect(hydratedTombstone.revision).toMatchObject({ serverRevision: 2 })

  await setCustomStreakRule(page, deletedTracker.id)
  const deletedSaved = await syncAndReadRemote(page, fixture.userId, deletedTracker.id, deletedTracker.name, 'custom')
  expect(deletedSaved.summary).toMatchObject({ failed: 0, conflicts: 0 })
  const deletedRemoteEntry = await page.evaluate(async ({ entryId }) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const client = getSupabaseClient()
    if (!client) throw new Error('The authenticated local Supabase client is unavailable.')
    const { data, error } = await client.from('tracker_entries').select('outcome, entry_values, deleted_at, server_revision').eq('id', entryId).maybeSingle()
    if (error) throw new Error(`Could not verify the cloud tombstone: ${error.message}`)
    return data
  }, { entryId: deletedEntryId })
  expect(deletedRemoteEntry).toMatchObject({ outcome: 'skipped', entry_values: {}, server_revision: 2 })
  expect(Date.parse(deletedRemoteEntry.deleted_at)).toBe(Date.parse('2026-10-16T16:04:23.431Z'))
  const deletedLocalEntry = await page.evaluate(async (entryId) => {
    const { db } = await import('/ProgressTracker/src/db/database.ts')
    return db.trackerEntries.get(entryId)
  }, deletedEntryId)
  expect(deletedLocalEntry).toMatchObject({ outcome: 'skipped', values: {}, deletedAt: '2026-10-16T16:04:23.431Z' })

  const activeTracker = legacyV6Challenge(randomUUID())
  await seedTracker(page, activeTracker, fixture.userId, { date: '2026-10-16', values: { progress: 0.5 } })
  const activeSeed = await syncAndReadRemote(page, fixture.userId, activeTracker.id, activeTracker.name)
  expect(activeSeed.summary).toMatchObject({ failed: 0, conflicts: 0 })
  const progressionBeforeEdit = await readProgressionLedger(page, fixture.userId)
  await page.goto(`/#/trackers/${activeTracker.id}/edit`)
  await page.locator('.advanced-setup > summary').click()
  await page.locator('.advanced-subsection').filter({ hasText: 'Streak rule mode' }).locator('summary').click()
  const activeStreak = page.getByRole('region', { name: 'Streak rule' })
  await activeStreak.getByRole('combobox', { name: 'Streak rule mode' }).selectOption('custom')
  await activeStreak.locator('.rule-leaf-controls select:not([aria-label])').selectOption('target')
  await page.getByRole('button', { name: 'Save changes' }).click()
  const activeDialog = page.getByRole('alertdialog', { name: 'How should your tracker changes apply?' })
  await expect(activeDialog).toBeVisible()
  await expect(activeDialog.getByRole('radio', { name: /Apply from today/ })).toBeEnabled()
  await expect(activeDialog.getByRole('radio', { name: /Apply to all history/ })).toBeDisabled()
  await expect(activeDialog.locator('#all-history-help')).toContainText('Unavailable: historical compatibility cannot be proven')
  await activeDialog.getByRole('button', { name: 'Apply from today' }).click()
  const activeSaved = await syncAndReadRemote(page, fixture.userId, activeTracker.id, activeTracker.name, 'custom')
  expect(activeSaved.summary).toMatchObject({ failed: 0, conflicts: 0 })
  expect(activeSaved.record).toMatchObject({
    schema_version: 10,
    definition: { ruleVersions: [
      { effectiveFrom: '2026-10-16', revision: 1, application: 'baseline' },
      { effectiveFrom: today, revision: 2, application: 'apply-from-today' },
    ] },
  })
  const activeEntry = await page.evaluate(async ({ trackerId }) => {
    const { getSupabaseClient } = await import('/ProgressTracker/src/services/supabase/client.ts')
    const client = getSupabaseClient()
    if (!client) throw new Error('The authenticated local Supabase client is unavailable.')
    const { data, error } = await client.from('tracker_entries').select('entry_date, outcome, entry_values, deleted_at, server_revision').eq('tracker_id', trackerId).maybeSingle()
    if (error) throw new Error(`Could not verify the active history: ${error.message}`)
    return data
  }, { trackerId: activeTracker.id })
  expect(activeEntry).toMatchObject({ entry_date: '2026-10-16', outcome: 'recorded', entry_values: { progress: 0.5 }, deleted_at: null, server_revision: 1 })
  await expect.poll(() => readProgressionLedger(page, fixture.userId)).toEqual(progressionBeforeEdit)
})

test('preserves typed schema v9 trackers during cosmetic edits', async ({ page }) => {
  const fixture = readFixture()
  const tracker = streakCureTracker(randomUUID(), 9)
  await signIn(page, fixture)
  await seedTracker(page, tracker, fixture.userId)
  const created = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure', 'custom')
  expect(created.summary).toMatchObject({ failed: 0, conflicts: 0 })
  expect(created.record).toMatchObject({ schema_version: 9, definition: { milestones: tracker.milestones } })

  await page.goto(`/#/trackers/${tracker.id}/edit`)
  await page.getByRole('textbox', { name: 'What habit do you want to build?' }).fill('Streak Cure renamed')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page).toHaveURL(/#\/trackers$/)
  const renamed = await syncAndReadRemote(page, fixture.userId, tracker.id, 'Streak Cure renamed', 'custom')
  expect(renamed.summary).toMatchObject({ failed: 0, conflicts: 0 })
  expect(renamed.record).toMatchObject({ schema_version: 9, definition: { name: 'Streak Cure renamed', milestones: tracker.milestones } })
})

test('preserves legacy historical values and blocks unsafe custom-field edits offline', async ({ page, context }) => {
  const fixture = readFixture()
  const tracker: TrackerDefinition = {
    schemaVersion: 1,
    id: randomUUID(),
    name: 'Historical field meanings',
    description: 'Keep recorded details stable.',
    kind: 'habit',
    status: 'active',
    categoryId: null,
    tags: [],
    icon: 'habit',
    accent: '#315e46',
    schedule: { kind: 'every-day' },
    metrics: [{ id: 'routine', name: 'Routine', valueType: 'checklist', checklistItems: [
      { id: 'read', label: 'Read', position: 0 },
      { id: 'review', label: 'Review', position: 1 },
    ] }],
    customFields: [{ id: 'mood', name: 'Mood', type: 'single-select', required: false, position: 0, options: ['Focused', 'Tired'] }],
    milestones: [],
    createdAt: '2026-01-05T00:00:00.000Z',
    updatedAt: '2026-01-05T00:00:00.000Z',
    archivedAt: null,
    deletedAt: null,
  }
  await signIn(page, fixture)
  await page.evaluate(async ({ tracker, userId }) => {
    const { activateWorkspace } = await import('/ProgressTracker/src/db/database.ts')
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    await activateWorkspace(userId)
    await localRepository.saveTracker(tracker)
    await localRepository.saveTrackerEntry({
      trackerId: tracker.id,
      date: '2026-10-15',
      outcome: 'recorded',
      values: { routine: { read: true, review: false }, 'field:mood': 'Focused' },
      note: 'Original checklist and detail',
    })
  }, { tracker, userId: fixture.userId })

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`/#/trackers/${tracker.id}/edit`)
  await page.locator('.advanced-setup > summary').click()
  await page.getByText('Measures, precision & targets').click()
  await expect(page.getByRole('textbox', { name: 'Checklist item 1' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '＋ Add checklist item' })).toBeDisabled()
  await page.getByText('Extra check-in details').click()
  await expect(page.getByRole('textbox', { name: 'Field name' })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: 'Field type' })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: 'Options' })).toBeDisabled()
  await expect(page.getByRole('checkbox', { name: /Required/ })).toBeDisabled()

  await context.setOffline(true)
  await page.getByRole('button', { name: 'Retire field' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page).toHaveURL(new RegExp(`#\\/trackers\\/${tracker.id}\\/edit$`))
  await expect(page.getByText(/field availability is not saved in its history/i)).toBeVisible()
  const offlineState = await page.evaluate(async (trackerId) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    const { db } = await import('/ProgressTracker/src/db/database.ts')
    return {
      tracker: await localRepository.getTracker(trackerId),
      entries: await localRepository.listTrackerEntriesForTracker(trackerId),
      operations: await db.syncOperations.toArray(),
    }
  }, tracker.id)
  expect(offlineState.tracker?.customFields).toMatchObject([{ id: 'mood', name: 'Mood', options: ['Focused', 'Tired'] }])
  expect(offlineState.tracker?.customFields?.[0]).not.toHaveProperty('retiredAt')
  expect(offlineState.entries).toMatchObject([{ values: { routine: { read: true, review: false }, 'field:mood': 'Focused' }, note: 'Original checklist and detail' }])
  const queuedEntry = offlineState.operations.find((operation) => operation.entity === 'tracker_entry'
    && (operation.payload as { trackerId?: string }).trackerId === tracker.id)
  expect(queuedEntry).toBeDefined()
  expect(queuedEntry?.status).toMatch(/^(pending|conflict)$/)
  expect((queuedEntry?.payload as { values?: Record<string, unknown> }).values?.['field:mood']).toBe('Focused')

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
