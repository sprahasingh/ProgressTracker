import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('Wins navigation, badge collection, history, details, and hash-route refresh work at mobile and desktop sizes', async ({ page }) => {
  const fixture = JSON.parse(readFileSync('/private/tmp/progression-playwright-auth.json', 'utf8')) as { email: string; password: string }
  await page.goto('/#/auth')
  await page.getByRole('button', { name: 'Use password' }).click()
  await page.getByLabel('Email address').last().fill(fixture.email)
  await page.getByLabel('Password').fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 50_000 })

  for (const width of [320, 360, 390, 430, 1440]) {
    const height = width < 500 ? 760 : 900
    await page.setViewportSize({ width, height })
    await page.goto('/#/achievements')
    await expect(page.getByRole('heading', { name: 'Achievements' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Achievements' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Achievement badges' })).toBeAttached()

    const routeBeforeScroll = new URL(page.url()).hash
    await page.getByRole('button', { name: 'Show all badges' }).click()
    const allBadgesDialog = page.getByRole('dialog', { name: 'All badges' })
    await expect(allBadgesDialog).toBeVisible()
    await expect(allBadgesDialog.getByRole('heading', { name: 'All badges' })).toBeVisible()
    expect(new URL(page.url()).hash).toBe(routeBeforeScroll)
    await allBadgesDialog.getByRole('button', { name: 'Close details' }).click()
    await expect(allBadgesDialog).toHaveCount(0)

    await page.getByRole('button', { name: /Open score history/ }).first().click()
    const scoreHistory = page.getByRole('dialog', { name: 'Score history' })
    await expect(scoreHistory).toBeVisible()
    const reversalToggle = scoreHistory.getByRole('checkbox', { name: 'Show reversed transactions' })
    await expect(reversalToggle).not.toBeChecked()
    await reversalToggle.check()
    await expect(reversalToggle).toBeChecked()
    const toggleBounds = await reversalToggle.boundingBox()
    expect(toggleBounds).not.toBeNull()
    expect(toggleBounds!.x + toggleBounds!.width).toBeLessThanOrEqual(width)
    await reversalToggle.uncheck()
    await page.getByRole('button', { name: 'Close details' }).click()

    if (width === 320) {
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Achievements' })).toBeVisible()
      await page.getByRole('button', { name: /Open score history/ }).first().click()
      await expect(page.getByRole('dialog', { name: 'Score history' }).getByRole('checkbox', { name: 'Show reversed transactions' })).not.toBeChecked()
      await page.getByRole('button', { name: 'Close details' }).click()
    }

    await page.getByRole('button', { name: /view consistency details/i }).click()
    await expect(page.getByRole('dialog', { name: 'Consistency' })).toBeVisible()
    await page.getByRole('button', { name: 'Close details' }).click()

    await page.getByRole('button', { name: /view streak details/i }).click()
    await expect(page.getByRole('dialog', { name: 'Streaks & recent activity' })).toBeVisible()
    await page.getByRole('button', { name: 'Close details' }).click()
  }

  await page.goto('/#/this-route-does-not-exist')
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible()
  await expect(page.getByText('Unexpected Application Error!')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to Today' }).click()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/ProgressTracker/')
})
