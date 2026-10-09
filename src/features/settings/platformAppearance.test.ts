import { describe, expect, it } from 'vitest'
import styles from '../../styles.css?raw'
import documentHtml from '../../../index.html?raw'
import manifest from '../../../public/manifest.webmanifest?raw'

describe('mobile system-bar safe areas', () => {
  it('declares edge-to-edge viewport coverage and browser color-scheme metadata', () => {
    expect(documentHtml).toContain('viewport-fit=cover')
    expect(documentHtml).toContain('<meta name="color-scheme" content="light dark"')
    expect(documentHtml).toContain('<meta name="theme-color" content="#fff9f2"')
    expect(documentHtml).toContain("themeColor.content = dark ? '#0b0b0d' : '#fff9f2'")
  })

  it('uses the dark canvas as the installed app UI fallback while retaining the light launch background', () => {
    const config = JSON.parse(manifest) as { theme_color: string; background_color: string; display: string }
    expect(config).toMatchObject({ theme_color: '#0b0b0d', background_color: '#fff9f2', display: 'standalone' })
    expect(documentHtml).toContain("themeColor.content = dark ? '#0b0b0d' : '#fff9f2'")
  })

  it('keeps a stable bottom navigation height and paints the maximum safe area, including the documented fallback', () => {
    expect(styles).toContain('--safe-area-max-inset-bottom: env(safe-area-max-inset-bottom, 36px)')
    expect(styles).toContain('bottom: calc(env(safe-area-inset-bottom, 0px) - var(--safe-area-max-inset-bottom))')
    expect(styles).toContain('height: calc(64px + var(--safe-area-max-inset-bottom))')
    expect(styles).toContain('padding-bottom: var(--safe-area-max-inset-bottom)')
    expect(styles).toContain('padding-bottom: calc(64px + var(--safe-area-max-inset-bottom))')
    expect(styles).toContain('height: calc(60px + env(safe-area-inset-top))')
    expect(styles).toContain('padding-top: env(safe-area-inset-top)')
    expect(styles).toContain('background: var(--canvas)')
  })
})
