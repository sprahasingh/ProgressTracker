import { describe, expect, it } from 'vitest'
import styles from '../../styles.css?raw'

const viewportWidths = [320, 360, 390, 430] as const

describe('mobile page and card spacing', () => {
  it.each(viewportWidths)('keeps an 8–10px page gutter and readable card inset at %ipx', (width) => {
    const pageGutter = width <= 360 ? 8 : 10
    const cardInset = 14

    expect(width - pageGutter * 2 - cardInset * 2).toBeGreaterThanOrEqual(276)
    expect(styles).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.page-content\s*\{[^}]*padding-right:\s*10px;[^}]*padding-left:\s*10px;/)
    expect(styles).toMatch(/\.tracker-page,\s*\.placeholder-page\s*\{[^}]*padding-right:\s*0;[^}]*padding-left:\s*0;/)
    expect(styles).toMatch(/\.surface-padded,[\s\S]*?\.calendar-day-details\s*\{\s*padding:\s*14px;/)
    if (width <= 360) {
      expect(styles).toMatch(/@media\s*\(max-width:\s*360px\)[\s\S]*?\.page-content\s*\{\s*padding-right:\s*8px;\s*padding-left:\s*8px;/)
    }
  })

  it('uses shared theme surface tokens so the same mobile geometry works in light and dark mode', () => {
    expect(styles).toContain('[data-theme=\'dark\']')
    expect(styles).toMatch(/\.settings-card,\s*\.calendar-month-card,[\s\S]*?\.calendar-day-details\s*\{\s*padding:\s*14px;/)
    expect(styles).not.toContain('[data-theme=\'dark\'] .page-content')
  })
})
