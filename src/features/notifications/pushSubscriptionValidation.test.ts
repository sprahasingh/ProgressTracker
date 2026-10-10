import { describe, expect, it } from 'vitest'
import { decodeVapidPublicKey, validatePushSubscription } from '../../../supabase/functions/_shared/pushSubscriptionValidation'

const p256dh = `BA${'A'.repeat(85)}`
const auth = 'A'.repeat(22)

describe('Web Push subscription validation', () => {
  it('accepts a valid HTTPS subscription with browser key material', () => {
    expect(validatePushSubscription({ endpoint: 'https://push.example.test/a/b?token=private', expirationTime: null, keys: { p256dh, auth } }))
      .toMatchObject({ endpoint: 'https://push.example.test/a/b?token=private', expirationTime: null })
  })

  it('rejects non-HTTPS, malformed, oversized, and extra-field payloads', () => {
    expect(validatePushSubscription(null)).toBeNull()
    expect(validatePushSubscription({ endpoint: 'http://push.example.test/endpoint', keys: { p256dh, auth } })).toBeNull()
    expect(validatePushSubscription({ endpoint: `https://push.example.test/${'x'.repeat(2100)}`, keys: { p256dh, auth } })).toBeNull()
    expect(validatePushSubscription({ endpoint: 'https://push.example.test/endpoint', user_id: 'attacker', keys: { p256dh, auth } })).toBeNull()
  })

  it('rejects malformed key encodings and expired subscriptions', () => {
    expect(validatePushSubscription({ endpoint: 'https://push.example.test/endpoint', keys: { p256dh: 'bad', auth } })).toBeNull()
    expect(validatePushSubscription({ endpoint: 'https://push.example.test/endpoint', keys: { p256dh, auth: 'bad' } })).toBeNull()
    expect(validatePushSubscription({ endpoint: 'https://push.example.test/endpoint', expirationTime: 100, keys: { p256dh, auth } }, 101)).toBeNull()
  })

  it('accepts only an uncompressed P-256 application server public key', () => {
    expect(decodeVapidPublicKey(`BA${'A'.repeat(85)}`)).toHaveLength(65)
    expect(decodeVapidPublicKey('not-a-vapid-key')).toBeNull()
  })
})
