import { expect, test } from '@playwright/test'

const dateAt = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const shift = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10)

async function seedGoal(page: import('@playwright/test').Page) {
  const today = dateAt(0)
  const trackerId = 'local-browser-goals-regression'
  await page.evaluate(async ({ today, trackerId }) => {
    const { localRepository } = await import('/ProgressTracker/src/db/localRepository.ts')
    await localRepository.saveTracker({
      schemaVersion: 5, id: trackerId, name: 'Local mobile planning regression', description: 'Isolated local browser fixture', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: new Date(Date.parse(`${today}T00:00:00.000Z`) + 3 * 86_400_000).toISOString().slice(0, 10),
      metrics: [{ id: 'hours', name: 'Hours', valueType: 'quantity', unit: 'hours', precision: { decimalPlaces: 0, increment: 1 } }],
      customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { hours: 'incremental' }, dailyTargets: {}, cumulativeTargets: { hours: 10 }, planningTimeZone: 'UTC', allocations: { hours: {} }, manualAllocations: { hours: { [today]: 10, [new Date(Date.parse(`${today}T00:00:00.000Z`) + 1 * 86_400_000).toISOString().slice(0, 10)]: 2 } } },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    })
    await localRepository.saveTrackerEntry({ trackerId, date: today, outcome: 'recorded', values: { hours: 6 }, note: '' })
  }, { today, trackerId })
  return { today, trackerId }
}

test('cumulative planning stays consistent and usable across mobile, tablet, and desktop widths', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await page.goto('/')
  const { today } = await seedGoal(page)
  await page.goto('/#/goals')
  await page.getByRole('button', { name: /View goal details/ }).click()
  await page.getByText('View daily plan').click()
  await page.getByText('Daily schedule').click()

  for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await expect(page.getByRole('heading', { name: 'Hours · 4 calendar days' })).toBeVisible()
  }

  const tomorrow = shift(today, 1)
  await expect(page.getByText('Target reached · goal still active')).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Edit plan for ${today}` })).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Edit plan for ${tomorrow}` })).toBeVisible()
  await page.getByRole('button', { name: `Edit plan for ${tomorrow}` }).click()
  const manualInput = page.getByRole('spinbutton', { name: `Planned allocation for ${tomorrow}` })
  await expect(manualInput).toHaveValue('2')
  await expect(page.getByText('2 Auto days')).toBeVisible()
  await manualInput.fill('3')
  await page.getByRole('button', { name: 'Save manual changes' }).click()
  await expect(page.getByText('Plan saved on this device.')).toBeVisible()
  await expect(page.getByText('0.5 hours / automatic day')).toBeVisible()
  await expect(page.getByRole('button', { name: /0\.5 hours\/Auto day/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Sat,.*1 hours Auto/ })).toBeVisible()

  await page.getByRole('button', { name: `Reset ${tomorrow} to Auto` }).click()
  await page.getByRole('button', { name: 'Save manual changes' }).click()
  await expect(page.getByText(/Plan saved on this device/)).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: /View goal details/ }).click()
  await page.getByText('View daily plan').click()
  await page.getByText('Daily schedule').click()
  await expect(page.getByRole('button', { name: `Edit plan for ${today}` })).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Edit plan for ${tomorrow}` })).toBeVisible()
})
