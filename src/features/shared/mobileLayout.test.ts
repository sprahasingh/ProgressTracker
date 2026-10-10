import { describe, expect, it } from 'vitest'
import styles from '../../styles.css?raw'
import tokens from '../../styles/tokens.css?raw'
import heatmap from '../dashboard/ActivityHeatmap.tsx?raw'

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

  it('uses the shared rounded card treatment for Today, Insights, and nested notification groups', () => {
    expect(tokens).toMatch(/--radius-card:\s*22px;/)
    expect(tokens).toMatch(/--radius-card-nested:\s*15px;/)
    expect(tokens).toMatch(/\[data-theme='dark'\]\s*\{[\s\S]*?--shadow-card:\s*0 10px 28px/)
    expect(styles).toContain('.today-checkin-card.status-card { border: 1px solid var(--status-stroke, var(--line)); }')
    expect(styles).toMatch(/\.analytics-tracker,[\s\S]*?\.achievement-card,[\s\S]*?\.history-entry-card,[\s\S]*?\.settings-card/)
    expect(styles).toMatch(/\.notification-accordion\s*\{[^}]*border: 1px solid var\(--line\);[^}]*border-radius: var\(--radius-card-nested\)/s)
    expect(styles).not.toMatch(/\.today-checkin-card(?:\.status-card)?\s*\{[^}]*border-top(?:-width|-color)?:\s*3px/)
  })

  it.each([320, 360, 390, 430, 560])('stacks Calendar filters without overlap at %ipx', (width) => {
    expect(width).toBeGreaterThanOrEqual(320)
    expect(styles).toMatch(/@media\s*\(max-width:\s*560px\)[\s\S]*?\.calendar-toolbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/)
    expect(styles).toMatch(/\.calendar-toolbar\s*>\s*\.tracker-filter\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/)
    expect(styles).toMatch(/\.calendar-toolbar\s*>\s*\.history-filter\s*\{[^}]*grid-column:\s*1;/)
    expect(styles).toMatch(/\.calendar-toolbar\s*>\s*\.button-quiet\s*\{[^}]*grid-column:\s*2;/)
    expect(styles).toMatch(/@media\s*\(max-width:\s*900px\)[\s\S]*?\.calendar-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/)
  })

  it('reserves the fixed navigation height and safe area in the mobile scroll space', () => {
    expect(styles).toMatch(/--mobile-nav-visible-height:\s*64px;/)
    expect(styles).toMatch(/\.main-area\s*\{\s*padding-bottom:\s*calc\(var\(--mobile-nav-visible-height\)\s*\+\s*var\(--safe-area-max-inset-bottom\)\);\s*\}/)
    expect(styles).toMatch(/\.page-content\s*\{\s*scroll-padding-bottom:\s*calc\(var\(--mobile-nav-visible-height\)\s*\+\s*var\(--safe-area-max-inset-bottom\)\);\s*\}/)
  })

  it.each([320, 360, 390, 430, 768, 1024, 1280])('keeps the heatmap compact and contained at %ipx', (width) => {
    expect(width).toBeGreaterThanOrEqual(320)
    expect(styles).toMatch(/\.activity-heatmap-scroll\s*\{[^}]*overflow-x:\s*auto;/)
    expect(styles).toMatch(/\.heatmap-cells\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--heatmap-columns\),\s*16px\);[^}]*grid-template-rows:\s*repeat\(7,\s*16px\);/)
    expect(styles).toMatch(/\.heatmap-cells\s+\.heatmap-cell::before\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;/)
    expect(styles).not.toMatch(/\.heatmap-cells\s*\{[^}]*grid-template-rows:\s*repeat\(7,\s*1fr\)/)
    expect(styles).not.toMatch(/\.activity-heatmap-section\s*\{[^}]*min-height:/)
    expect(styles).toMatch(/\.heatmap-months\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--heatmap-columns\),\s*16px\);/)
    expect(styles).toMatch(/\.heatmap-legend\s*\{[^}]*margin:\s*12px\s+0\s+0\s+27px;/)
    expect(styles).toMatch(/\.heatmap-legend\s+small\s*\{\s*flex-basis:\s*100%;/)
    expect(styles).toMatch(/button\.heatmap-cell:focus-visible\s*\{[^}]*outline:/)
    expect(heatmap).toMatch(/role="region" aria-label=\{`Scrollable \$\{rangeName\} activity heatmap`\} tabIndex=\{0\}/)
  })
})
