import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const viewportMatrix = [
  { width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 844 },
  { width: 430, height: 932 }, { width: 768, height: 1024 }, { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const

async function signIn(page: Page, fixture: { email: string; password: string }) {
  await page.goto('/#/auth')
  await page.getByRole('button', { name: 'Use password' }).click()
  await page.getByLabel('Email address').last().fill(fixture.email)
  await page.getByLabel('Password').fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 50_000 })
}

async function openAdvancedGoalPlanning(page: Page) {
  const advanced = page.locator('details.advanced-setup')
  if (!await advanced.evaluate((element) => (element as HTMLDetailsElement).open)) await advanced.locator(':scope > summary').click()
  const planning = page.locator('details.advanced-subsection').filter({ has: page.locator('summary', { hasText: 'Goal planning' }) })
  if (!await planning.evaluate((element) => (element as HTMLDetailsElement).open)) await planning.locator(':scope > summary').click()
  return planning
}

test('creates, reloads, edits, and records a cumulative goal across tracker form viewports', async ({ page, context }) => {
  const fixture = JSON.parse(readFileSync('/private/tmp/progression-playwright-auth.json', 'utf8')) as { userId: string; email: string; password: string }
  await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await signIn(page, fixture)
  await page.goto('/#/trackers/new')
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByLabel('What habit do you want to build?')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('alert').filter({ hasText: 'Enter a name for this tracker.' })).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss notification: Check the tracker details' }).click()

  await page.locator('.tracker-kind-option').filter({ hasText: 'Goal' }).click()
  await page.getByLabel('What do you want to achieve?').fill('Browser 100 problems goal')
  await page.getByLabel('Numeric measure unit').fill('problems')
  await page.locator('details.optional-goal-plan > summary').click()
  await page.getByLabel('Total amount').fill('100')
  await page.getByLabel('Goal deadline').fill('2027-01-21')
  await openAdvancedGoalPlanning(page)
  await expect(page.getByLabel('Planning mode', { exact: true })).toHaveValue('cumulative-deadline')
  await expect(page.getByLabel('Entry meaning for cumulative plans')).toHaveValue('incremental')
  await expect(page.getByLabel('Progress cumulative planning target')).toHaveValue('100')
  await expect(page.getByText(/Uses the tracker deadline: Jan 21, 2027/)).toBeVisible()

  const modeSelect = page.getByLabel('Planning mode', { exact: true })
  const infoButton = page.getByRole('button', { name: 'More about Planning mode' })
  const footer = page.locator('.tracker-form-actions')
  for (const size of viewportMatrix) {
    await page.setViewportSize(size)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => value === 'dark' ? document.documentElement.dataset.theme = 'dark' : delete document.documentElement.dataset.theme, theme)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      const selectBounds = await modeSelect.boundingBox()
      expect(selectBounds, `${size.width}px ${theme} planning dropdown is laid out`).not.toBeNull()
      expect(selectBounds!.x).toBeGreaterThanOrEqual(0)
      expect(selectBounds!.x + selectBounds!.width).toBeLessThanOrEqual(size.width + 1)
      await infoButton.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
      await infoButton.focus()
      await page.keyboard.press('Enter')
      const popover = page.getByRole('dialog', { name: 'Planning mode' })
      await expect(popover).toBeVisible()
      const popoverBounds = await popover.boundingBox()
      expect(popoverBounds, `${size.width}px ${theme} help popover is laid out`).not.toBeNull()
      expect(popoverBounds!.x).toBeGreaterThanOrEqual(0)
      expect(popoverBounds!.x + popoverBounds!.width).toBeLessThanOrEqual(size.width + 1)
      expect(popoverBounds!.y).toBeGreaterThanOrEqual(0)
      expect(popoverBounds!.y + popoverBounds!.height).toBeLessThanOrEqual(size.height + 1)
      await page.keyboard.press('Escape')
      await expect(popover).toBeHidden()
      await footer.scrollIntoViewIfNeeded()
      const footerBounds = await footer.boundingBox()
      expect(footerBounds, `${size.width}px ${theme} action footer is laid out`).not.toBeNull()
      expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(size.height + 1)
      if (size.width <= 430) {
        const nav = await page.locator('.mobile-nav').boundingBox()
        if (nav) expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(nav.y + 1)
      }
    }
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: 'You’re ready to begin' })).toBeVisible()
  const saved = await page.evaluate(async () => {
    const repo = await import('/ProgressTracker/src/db/localRepository.ts')
    const tracker = (await repo.localRepository.listTrackers()).find((item) => item.name === 'Browser 100 problems goal')!
    return { id: tracker.id, kind: tracker.kind, deadline: tracker.deadline, mode: tracker.goalPlanning?.mode, semantics: tracker.goalPlanning?.progressSemantics[tracker.metrics[0]!.id], total: tracker.goalPlanning?.cumulativeTargets[tracker.metrics[0]!.id], unit: tracker.metrics[0]!.unit }
  })
  expect(saved).toMatchObject({ kind: 'goal', deadline: '2027-01-21', mode: 'cumulative-deadline', semantics: 'incremental', total: 100, unit: 'problems' })

  await page.goto(`/#/trackers/${saved.id}/edit`)
  await openAdvancedGoalPlanning(page)
  await expect(page.getByLabel('What do you want to achieve?')).toHaveValue('Browser 100 problems goal')
  await expect(page.locator('.tracker-deadline-field input[type="date"]')).toHaveValue('2027-01-21')
  await expect(page.getByLabel('Progress cumulative planning target')).toHaveValue('100')
  await expect(page.getByLabel('Entry meaning for cumulative plans')).toHaveValue('incremental')
  await page.reload()
  await openAdvancedGoalPlanning(page)
  await expect(page.getByLabel('Progress cumulative planning target')).toHaveValue('100')
  await page.getByLabel('What do you want to achieve?').fill('Browser 100 problems goal edited')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Browser 100 problems goal edited')).toBeVisible()

  await page.goto('/')
  await page.getByRole('button', { name: /Open Browser 100 problems goal edited/ }).click()
  await page.getByRole('spinbutton', { name: 'Progress' }).fill('7')
  await page.getByRole('button', { name: 'Save check-in' }).click()
  await expect(page.getByText(/Saved on this device/)).toBeVisible()
  await page.getByRole('button', { name: 'Close check-in details' }).click()
  await page.goto('/#/goals')
  await expect(page.getByRole('button', { name: /Browser 100 problems goal edited/ })).toContainText('7 / 100 problems')
})

test('persists binary, daily target, no-target, and multi-measure tracker configurations', async ({ page, context }) => {
  const fixture = JSON.parse(readFileSync('/private/tmp/progression-playwright-auth.json', 'utf8')) as { userId: string; email: string; password: string }
  await (await context.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await signIn(page, fixture)
  const createHabit = async () => {
    await page.goto('/#/trackers/new')
    await page.getByLabel('What habit do you want to build?').fill('Browser binary habit')
    await page.getByRole('button', { name: 'Create tracker' }).click()
    await expect(page.getByRole('heading', { name: 'Browser binary habit' })).toBeVisible()
  }
  await createHabit()

  await page.goto('/#/trackers/new')
  await page.locator('.tracker-kind-option').filter({ hasText: 'Goal' }).click()
  await page.getByLabel('What do you want to achieve?').fill('Browser daily goal')
  await page.locator('details.optional-goal-plan > summary').click()
  await page.getByLabel('Total amount').fill('5')
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: 'Browser daily goal' })).toBeVisible()

  await page.goto('/#/trackers/new')
  await page.locator('.tracker-kind-option').filter({ hasText: 'Goal' }).click()
  await page.getByLabel('What do you want to achieve?').fill('Browser goal without target')
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: 'Browser goal without target' })).toBeVisible()

  await page.goto('/#/trackers/new')
  await page.getByText('Challenge or project?').click()
  await page.locator('.tracker-kind-option').filter({ hasText: 'Project' }).click()
  await page.getByLabel('What project will you move forward?').fill('Browser multi-measure project')
  await page.locator('details.advanced-setup > summary').click()
  const measures = page.locator('details.advanced-subsection').filter({ hasText: 'Measures, precision & targets' })
  await measures.locator(':scope > summary').click()
  await page.getByRole('button', { name: /Add measure/ }).click()
  await page.locator('.configuration-card').nth(1).getByLabel('Name', { exact: true }).fill('Minutes')
  await page.getByRole('button', { name: 'Create tracker' }).click()
  await expect(page.getByRole('heading', { name: 'Browser multi-measure project' })).toBeVisible()

  await page.reload()
  const saved = await page.evaluate(async () => {
    const repo = await import('/ProgressTracker/src/db/localRepository.ts')
    const trackers = await repo.localRepository.listTrackers()
    return trackers.filter((item) => item.name.startsWith('Browser ')).map((item) => ({ name: item.name, kind: item.kind, types: item.metrics.map((metric) => metric.valueType), names: item.metrics.map((metric) => metric.name), daily: item.goalPlanning?.dailyTargets[item.metrics[0]!.id], cumulative: item.goalPlanning?.cumulativeTargets[item.metrics[0]!.id] }))
  })
  expect(saved.find((item) => item.name === 'Browser binary habit')).toMatchObject({ kind: 'habit', types: ['boolean'] })
  expect(saved.find((item) => item.name === 'Browser daily goal')).toMatchObject({ kind: 'goal', daily: 5, cumulative: undefined })
  expect(saved.find((item) => item.name === 'Browser goal without target')).toMatchObject({ kind: 'goal', daily: undefined, cumulative: undefined })
  expect(saved.find((item) => item.name === 'Browser multi-measure project')).toMatchObject({ kind: 'project', types: ['quantity', 'quantity'], names: ['Progress', 'Minutes'] })
})
