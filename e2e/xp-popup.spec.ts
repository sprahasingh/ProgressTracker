import { expect, test } from '@playwright/test'

async function swipeTouch(content, cdp) {
  const rect = await content.evaluate((element) => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right } })
  const x = Math.round((rect.left + rect.right) / 2)
  const startY = Math.round(rect.top + (rect.bottom - rect.top) * 0.78)
  const endY = Math.round(rect.top + (rect.bottom - rect.top) * 0.2)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY, id: 0 }] })
  await new Promise((resolve) => setTimeout(resolve, 100))
  for (let step = 1; step <= 12; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(startY + (endY - startY) * step / 12), id: 0 }] })
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await new Promise((resolve) => setTimeout(resolve, 150))
  return content.evaluate((element) => element.scrollTop)
}

test('XP information popup scrolls by touch and exposes its last threshold at mobile widths', async ({ page }) => {
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 640 })
    if (width === 320) {
      // Check the gesture coordinates and direction against a plain scrollport
      // so a failed popup swipe cannot be blamed on a non-working emulator.
      await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="probe" style="position:fixed;top:100px;left:20px;width:200px;height:300px;overflow-y:auto;touch-action:auto;background:#eee"><div style="height:1200px">plain scroll probe</div></div>')
      const probeCdp = await page.context().newCDPSession(page)
      await probeCdp.send('Page.setTouchEmulationEnabled', { enabled: true, configuration: 'mobile' })
      await probeCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 320, id: 0 }] })
      await page.waitForTimeout(100)
      for (let step = 1; step <= 12; step += 1) {
        await probeCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100, y: 320 - 220 * step / 12, id: 0 }] })
        await page.waitForTimeout(30)
      }
      await probeCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(100)
      expect(await page.locator('#probe').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await probeCdp.detach()
    }

    await page.goto('e2e/xp-popup-fixture.html')
    const xpCard = page.locator('.progression-level-card-shell')
    const cardLayout = await xpCard.evaluate((shell) => {
      const bounds = (selector) => {
        const rect = (selector === '.progression-level-card-shell' ? shell : shell.querySelector(selector)).getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height }
      }
      return {
        shell: bounds('.progression-level-card-shell'),
        title: bounds('.progression-xp-header > strong'),
        level: bounds('.progression-level-pill'),
        info: bounds('.info-button'),
        track: bounds('.progression-level-track'),
        caption: bounds('.progression-level-caption'),
        minHeight: getComputedStyle(shell.querySelector('.progression-level-card')).minHeight,
      }
    })
    expect(cardLayout.shell.height, `XP card is too tall at ${width}px: ${JSON.stringify(cardLayout)}`).toBeLessThan(170)
    expect(cardLayout.shell.bottom - cardLayout.caption.bottom).toBeLessThanOrEqual(14)
    expect(cardLayout.minHeight).toBe('0px')
    expect(Math.abs((cardLayout.level.top + cardLayout.level.bottom) - (cardLayout.info.top + cardLayout.info.bottom))).toBeLessThanOrEqual(2)
    expect(cardLayout.track.right - cardLayout.track.left).toBeGreaterThan(width * 0.7)

    await page.evaluate(() => window.scrollTo(0, 180))
    const pageScrollBeforeOpen = await page.evaluate(() => window.scrollY)
    await page.getByRole('button', { name: 'XP and level information' }).click()

    const dialog = page.getByRole('dialog', { name: 'How XP and levels work' })
    const content = dialog.locator('.info-popover-content')
    await expect(dialog).toBeVisible()
    await expect(content.getByText('Level 20')).toBeAttached()
    const before = await content.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const dialog = element.closest('.info-popover')
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        overflowY: style.overflowY,
        touchAction: style.touchAction,
        overscrollBehaviorY: style.overscrollBehaviorY,
        pointerEvents: style.pointerEvents,
      }
    })
    const bodyBefore = await page.evaluate(() => ({ scrollY: window.scrollY, position: document.body.style.position, top: document.body.style.top, overflow: document.body.style.overflow }))

    expect(before.scrollHeight, `popup should overflow at ${width}px: ${JSON.stringify(before)}`).toBeGreaterThan(before.clientHeight)
    expect(before.overflowY).toBe('auto')
    expect(before.touchAction).toBe('auto')
    expect(bodyBefore.position).toBe('fixed')
    expect(bodyBefore.overflow).toBe('hidden')

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Page.setTouchEmulationEnabled', { enabled: true, configuration: 'mobile' })
    let touchTop = await swipeTouch(content, cdp)
    for (let swipe = 0; swipe < 4 && touchTop < before.scrollHeight - before.clientHeight; swipe += 1) {
      touchTop = await swipeTouch(content, cdp)
    }
    await page.waitForTimeout(250)
    const after = await content.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop }))
    const touchEvents = await page.evaluate(() => window.__xpTouchEvents)
    const bodyAfter = await page.evaluate(() => ({ scrollY: window.scrollY, position: document.body.style.position, top: document.body.style.top, overflow: document.body.style.overflow }))
    await cdp.detach()

    expect(touchEvents.some((event) => event.type === 'touchstart' && event.target === '.info-popover-content')).toBe(true)
    expect(after.scrollTop, `popup did not scroll at ${width}px: before=${JSON.stringify(before)}, after=${JSON.stringify(after)}, events=${JSON.stringify(touchEvents.slice(-16))}`).toBeGreaterThan(0)
    expect(bodyAfter).toEqual(bodyBefore)

    const finalThreshold = content.getByText('Level 20')
    await expect(finalThreshold).toBeInViewport()
    const rowBounds = await finalThreshold.evaluate((element) => {
      const row = element.closest('[role="row"]')!.getBoundingClientRect()
      const scroller = element.closest('.info-popover-content')!.getBoundingClientRect()
      return { rowTop: row.top, rowBottom: row.bottom, contentTop: scroller.top, contentBottom: scroller.bottom }
    })
    expect(rowBounds.rowTop).toBeGreaterThanOrEqual(rowBounds.contentTop)
    expect(rowBounds.rowBottom).toBeLessThanOrEqual(rowBounds.contentBottom)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.body.style.position)).toBe('')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('XP and level information')
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBeforeOpen)

    await page.evaluate(() => window.scrollBy(0, 60))
    const afterPageScroll = await page.evaluate(() => window.scrollY)
    expect(afterPageScroll).toBeGreaterThan(pageScrollBeforeOpen)
    await page.getByRole('button', { name: 'XP and level information' }).click()
    await expect(dialog).toBeVisible()
    await page.getByRole('button', { name: 'Close explanation' }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.body.style.position)).toBe('')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('XP and level information')
    expect(await page.evaluate(() => window.scrollY)).toBe(afterPageScroll)
  }
})

test('daily plan editor stays compact, touch friendly, and free of horizontal overflow on mobile', async ({ page }) => {
  await page.goto('e2e/xp-popup-fixture.html')
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 760 })
    const preview = page.getByRole('region', { name: 'Pages allocation preview' })
    await expect(preview).toBeVisible()
    const measurements = await preview.evaluate((element) => ({
      viewportWidth: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      previewWidth: element.clientWidth,
      minTableWidth: getComputedStyle(element.querySelector('.allocation-preview-table')).minWidth,
    }))
    expect(measurements.pageWidth, `page overflows horizontally at ${width}px: ${JSON.stringify(measurements)}`).toBeLessThanOrEqual(width)
    await preview.getByText(/Daily schedule/).click()
    const firstRow = preview.locator('tbody tr').first()
    expect(await firstRow.evaluate((row) => getComputedStyle(row).display)).toBe('grid')
    expect(await firstRow.getByText('Auto').count()).toBe(1)
    await expect(firstRow.getByRole('button', { name: /Reset .* to Auto/ })).toHaveCount(0)
    await firstRow.getByRole('button', { name: 'Edit plan for 2026-01-05' }).click()
    await expect(firstRow.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-05' })).toBeVisible()
    expect(await preview.locator('.allocation-preview-table-wrap').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const jump = preview.getByRole('textbox', { name: 'Jump to date' })
    await jump.fill('2026-02-01')
    await expect(preview.getByRole('row', { name: /Sun, Feb 1/ })).toBeAttached()
    await page.reload()
  }
})
