export type Appearance = 'light' | 'dark' | 'system'

export const LIGHT_THEME_COLOR = '#fff9f2'
export const DARK_THEME_COLOR = '#0d0b0a'
const APPEARANCE_STORAGE_KEY = 'progress-tracker-appearance'

/** Applies the active palette to browser chrome and installed iOS web apps. */
export function applyDocumentAppearance(appearance: Appearance, systemPrefersDark: boolean, target: Document = document): boolean {
  const dark = appearance === 'dark' || (appearance === 'system' && systemPrefersDark)
  if (dark) target.documentElement.dataset.theme = 'dark'
  else delete target.documentElement.dataset.theme

  target.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR)
  target.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', dark ? 'black-translucent' : 'default')
  return dark
}

/** Keeps the pre-paint theme bootstrap aligned with the workspace preference. */
export function rememberAppearance(appearance: Appearance): void {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance)
  } catch {
    // Storage can be unavailable in private browsing; the live document still updates.
  }
}
