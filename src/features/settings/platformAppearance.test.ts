import { describe, expect, it } from 'vitest'
import styles from '../../styles.css?raw'
import documentHtml from '../../../index.html?raw'

describe('mobile system-bar safe areas', () => {
  it('declares edge-to-edge viewport coverage and browser color-scheme metadata', () => {
    expect(documentHtml).toContain('viewport-fit=cover')
    expect(documentHtml).toContain('<meta name="color-scheme" content="light dark"')
    expect(documentHtml).toContain('<meta name="theme-color" content="#fff9f2"')
    expect(documentHtml).toContain("themeColor.content = dark ? '#0d0b0a' : '#fff9f2'")
  })

  it('keeps a stable bottom navigation height and paints the maximum safe area', () => {
    expect(styles).toContain('--safe-area-max-inset-bottom: env(safe-area-inset-bottom, 0px)')
    expect(styles).toContain('--safe-area-max-inset-bottom: env(safe-area-max-inset-bottom)')
    expect(styles).toContain('bottom: calc(env(safe-area-inset-bottom, 0px) - var(--safe-area-max-inset-bottom))')
    expect(styles).toContain('height: calc(64px + var(--safe-area-max-inset-bottom))')
    expect(styles).toContain('padding-bottom: var(--safe-area-max-inset-bottom)')
    expect(styles).toContain('padding-bottom: calc(64px + var(--safe-area-max-inset-bottom))')
    expect(styles).toContain('height: calc(60px + env(safe-area-inset-top))')
    expect(styles).toContain('padding-top: env(safe-area-inset-top)')
    expect(styles).toContain('background: var(--canvas)')
  })
})
