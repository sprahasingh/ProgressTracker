import { afterEach, describe, expect, it } from 'vitest'
import { applyDocumentAppearance, DARK_THEME_COLOR, LIGHT_THEME_COLOR, rememberAppearance } from './appearance'

describe('document appearance', () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme
    document.querySelector('meta[name="theme-color"]')?.remove()
    document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.remove()
    localStorage.clear()
  })

  it('updates the theme color and status bar metadata when switching without reloading', () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color"><meta name="apple-mobile-web-app-status-bar-style">')

    expect(applyDocumentAppearance('dark', false)).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', DARK_THEME_COLOR)
    expect(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent')

    expect(applyDocumentAppearance('light', true)).toBe(false)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', LIGHT_THEME_COLOR)
    expect(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'default')
  })

  it('follows system preference only in system mode and remembers explicit preferences', () => {
    expect(applyDocumentAppearance('system', true)).toBe(true)
    expect(applyDocumentAppearance('system', false)).toBe(false)
    expect(applyDocumentAppearance('light', true)).toBe(false)
    expect(applyDocumentAppearance('dark', false)).toBe(true)

    rememberAppearance('dark')
    expect(localStorage.getItem('progress-tracker-appearance')).toBe('dark')
  })

})
