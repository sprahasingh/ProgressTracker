import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progression-xp-history-playwright-auth.json'
const fixtureEmail = 'browser-achievement-e2e@progress-tracker.invalid'
const retrospectiveFixtureEmail = 'browser-rule-history-retrospective@progress-tracker.invalid'
const legacyContainer = 'supabase_db_progression-xp-history-e2e'
const ruleHistoryProject = process.env.PROGRESSION_RULE_HISTORY_PROJECT_ID
const expectedContainer = ruleHistoryProject && /^[a-z0-9-]{1,40}$/.test(ruleHistoryProject)
  ? `supabase_db_${ruleHistoryProject}`
  : legacyContainer
const initialConfirmedXp = 29
const originalAwardName = 'XP History original reversed reward'
const reversalName = 'XP History reversal transaction'

type Fixture = { userId: string; email: string; password: string }

function readFixture(): Fixture {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
  if (!/^[0-9a-f-]{36}$/i.test(fixture.userId) || fixture.email !== fixtureEmail || !fixture.password) {
    throw new Error('The focused XP History suite requires its named disposable Auth fixture.')
  }
  return fixture
}

function runFixtureSql(query: string): string {
  const container = process.env.SUPABASE_DB_CONTAINER
  if (container !== expectedContainer || (ruleHistoryProject && expectedContainer === legacyContainer)) throw new Error('XP History fixture SQL refused an unexpected database container.')
  return execFileSync('docker', ['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', query], {
    encoding: 'utf8',
    timeout: 15_000,
  }).trim()
}

function isolationGuard(userId: string): string {
  const allowedEmails = [fixtureEmail, ...(ruleHistoryProject ? [retrospectiveFixtureEmail] : [])]
  const sqlEmails = allowedEmails.map((email) => `'${email}'`).join(', ')
  return `DO $$ BEGIN
    IF (SELECT count(*) FROM auth.users) <> ${allowedEmails.length}
      OR (SELECT count(*) FROM auth.users WHERE email NOT IN (${sqlEmails})) <> 0 THEN
      RAISE EXCEPTION 'XP History fixture refuses a database with unrelated Auth users';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '${userId}'::uuid AND email = '${fixtureEmail}') THEN
      RAISE EXCEPTION 'XP History disposable Auth fixture is missing';
    END IF;
  END $$;`
}

function resetAndSeedFixture(): void {
  const { userId } = readFixture()
  const sql = `BEGIN;
  ${isolationGuard(userId)}
  DELETE FROM public.progression_events WHERE user_id = '${userId}'::uuid;
  WITH fixture_events AS (
    SELECT
      md5('${userId}:xp-history:item:' || item::text)::uuid AS id,
      '${userId}'::uuid AS user_id,
      item,
      date_trunc('second', now()) - make_interval(secs => 31 - item) AS recorded_at
    FROM generate_series(1, 29) AS item
  )
  INSERT INTO public.progression_events
    (id, user_id, event_category, reason_code, effective_date, recorded_at, xp_delta, scoring_version, idempotency_key, metadata)
  SELECT id, user_id, 'check_in', 'DAILY_CHECK_IN_COMPLETED', current_date, recorded_at, 1, 2,
    md5('${userId}:xp-history:item-key:' || item::text)::uuid,
    jsonb_build_object('fixture', 'xp-history-browser-test', 'item', item)
  FROM fixture_events;
  INSERT INTO public.progression_events
    (id, user_id, event_category, reason_code, effective_date, recorded_at, xp_delta, scoring_version, idempotency_key, reverses_event_id, metadata)
  VALUES
    (md5('${userId}:xp-history:original')::uuid, '${userId}'::uuid, 'check_in', 'DAILY_CHECK_IN_COMPLETED', current_date,
      date_trunc('second', now()) - interval '32 seconds', 12, 2, md5('${userId}:xp-history:original-key')::uuid,
      NULL, '{"fixture":"xp-history-browser-test"}'::jsonb),
    (md5('${userId}:xp-history:reversal')::uuid, '${userId}'::uuid, 'reversal', 'AWARD_REVERSAL', current_date,
      date_trunc('second', now()) - interval '1 second', -12, 2, md5('${userId}:xp-history:reversal-key')::uuid,
      md5('${userId}:xp-history:original')::uuid, jsonb_build_object('fixture', 'xp-history-browser-test'));
  INSERT INTO public.progression_event_sources (user_id, event_id, display_name)
  SELECT '${userId}'::uuid, md5('${userId}:xp-history:item:' || item::text)::uuid,
    'XP History pagination item ' || lpad(item::text, 2, '0')
  FROM generate_series(1, 29) AS item;
  INSERT INTO public.progression_event_sources (user_id, event_id, display_name)
  VALUES
    ('${userId}'::uuid, md5('${userId}:xp-history:original')::uuid, '${originalAwardName}'),
    ('${userId}'::uuid, md5('${userId}:xp-history:reversal')::uuid, '${reversalName}');
  COMMIT;`
  runFixtureSql(sql)
}

function addSyncRefreshReward(): void {
  const { userId } = readFixture()
  const sql = `BEGIN;
  ${isolationGuard(userId)}
  WITH inserted AS (
    INSERT INTO public.progression_events
      (user_id, event_category, reason_code, effective_date, xp_delta, scoring_version, idempotency_key, metadata)
    VALUES ('${userId}'::uuid, 'streak_milestone', 'STREAK_MILESTONE', current_date, 5, 2, gen_random_uuid(),
      '{"fixture":"xp-history-browser-sync-refresh"}'::jsonb)
    RETURNING user_id, id
  )
  INSERT INTO public.progression_event_sources (user_id, event_id, display_name)
  SELECT user_id, id, 'XP History sync refresh marker' FROM inserted;
  COMMIT;`
  runFixtureSql(sql)
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.goto('/#/auth')
  await page.getByRole('button', { name: 'Use password' }).click()
  await page.getByLabel('Email address').last().fill(fixture.email)
  await page.getByLabel('Password').fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 50_000 })
  await page.goto('/#/achievements')
  // The route remains /achievements, while its user-facing page was renamed
  // to Wins. Keep the test anchored to the current accessible page title.
  await expect(page).toHaveURL(/#\/achievements$/)
  await expect(page.getByRole('heading', { name: 'Wins.', exact: true })).toBeVisible()
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: /Open score history/ }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Score history' })
  await expect(dialog.getByText('XP History pagination item 29', { exact: true })).toBeVisible()
  return dialog
}

test.beforeEach(() => resetAndSeedFixture())

test('hides complete reversals across history pages and the toggle restores both rows', async ({ page }) => {
  const fixture = readFixture()
  await signIn(page, fixture)

  const dialog = await openHistory(page)
  const rows = dialog.locator('.progression-dialog-event-list > li')
  const toggle = dialog.getByRole('checkbox', { name: 'Show reversed transactions' })
  await expect(toggle).not.toBeChecked()
  await expect(page.getByRole('button', { name: new RegExp(`${initialConfirmedXp} confirmed XP`) })).toBeVisible()
  await expect(rows).toHaveCount(29)
  await expect(dialog.getByText(originalAwardName, { exact: true })).toHaveCount(0)
  await expect(dialog.getByText(reversalName, { exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Load more history' })).toBeVisible()

  await toggle.check()
  await expect(toggle).toBeChecked()
  await expect(rows).toHaveCount(30)
  await expect(dialog.getByText('Award reversed', { exact: true })).toBeVisible()
  const reversalRow = rows.filter({ hasText: 'Award reversed' })
  await expect(reversalRow.getByText(originalAwardName, { exact: true })).toBeVisible()
  await expect(dialog.getByText(reversalName, { exact: true })).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Load more history' }).click()
  await expect(rows).toHaveCount(31)
  const originalAwardRow = rows.filter({ hasText: originalAwardName })
  await expect(originalAwardRow.getByText('Qualifying check-in', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/Reverses qualifying check-in/)).toBeVisible()

  await toggle.uncheck()
  await expect(rows).toHaveCount(29)
  await expect(dialog.getByText(originalAwardName, { exact: true })).toHaveCount(0)
  await expect(dialog.getByText(reversalName, { exact: true })).toHaveCount(0)
})

test('resets the reversed transaction filter to hidden after a full page reload', async ({ page }) => {
  await signIn(page, readFixture())
  let dialog = await openHistory(page)
  const toggle = dialog.getByRole('checkbox', { name: 'Show reversed transactions' })
  await toggle.check()
  const reversalRow = dialog.locator('.progression-dialog-event-list > li').filter({ hasText: 'Award reversed' })
  await expect(reversalRow.getByText(originalAwardName, { exact: true })).toBeVisible()
  await expect(dialog.getByText(reversalName, { exact: true })).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Wins.', exact: true })).toBeVisible()
  dialog = await openHistory(page)
  await expect(dialog.getByRole('checkbox', { name: 'Show reversed transactions' })).not.toBeChecked()
  await expect(dialog.getByText(originalAwardName, { exact: true })).toHaveCount(0)
  await expect(dialog.getByText(reversalName, { exact: true })).toHaveCount(0)
})

test('refreshes the open XP History and confirmed total on sync completion', async ({ page }) => {
  const fixture = readFixture()
  await signIn(page, fixture)
  const dialog = await openHistory(page)
  await expect(page.getByRole('button', { name: new RegExp(`${initialConfirmedXp} confirmed XP`) })).toBeVisible()

  addSyncRefreshReward()
  const syncResult = await page.evaluate(async (userId) => {
    const clientModule = await import('/ProgressTracker/src/services/supabase/client.ts')
    const syncEngine = await import('/ProgressTracker/src/services/supabase/syncEngine.ts')
    const client = clientModule.getSupabaseClient()
    if (!client) throw new Error('The authenticated local Supabase client is unavailable during the sync refresh test.')
    return syncEngine.synchronizeWorkspace(userId, client)
  }, fixture.userId)
  expect(syncResult.failed).toBe(0)

  await expect(dialog.getByText('XP History sync refresh marker', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(`${initialConfirmedXp + 5} confirmed XP`) })).toBeVisible()
})

test('keeps the XP History toggle and rows inside mobile, tablet, and desktop viewports', async ({ page }) => {
  await signIn(page, readFixture())

  for (const width of [320, 360, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 760 : 900 })
    const dialog = await openHistory(page)
    const toggle = dialog.getByRole('checkbox', { name: 'Show reversed transactions' })
    await expect(toggle).not.toBeChecked()
    const bounds = await toggle.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.getByRole('button', { name: 'Close details' }).click()
  }
})
