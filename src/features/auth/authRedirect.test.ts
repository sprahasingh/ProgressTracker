import { describe, expect, it } from 'vitest'
import { getAuthRedirectUrl } from './authRedirect'

describe('auth email redirect URL', () => {
  it('preserves the hash route so email confirmations return to the app page', () => {
    expect(getAuthRedirectUrl({ origin: 'https://app.example', pathname: '/', hash: '#/settings' })).toBe('https://app.example/#/settings')
  })

  it('uses the app root when no hash route is present', () => {
    expect(getAuthRedirectUrl({ origin: 'https://app.example', pathname: '/', hash: '' })).toBe('https://app.example/#/')
  })
})
