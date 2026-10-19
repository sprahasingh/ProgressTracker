import { describe, expect, it } from 'vitest'
import { hasExplicitIdentitySharingConsent } from './identityConsent.ts'

describe('explicit maintainer identity consent', () => {
  it('permits only an explicitly saved opt-in', () => {
    expect(hasExplicitIdentitySharingConsent({ share_identity: true, identity_sharing_preference_set: true })).toBe(true)
    expect(hasExplicitIdentitySharingConsent({ share_identity: false, identity_sharing_preference_set: true })).toBe(false)
    expect(hasExplicitIdentitySharingConsent({ share_identity: true, identity_sharing_preference_set: false })).toBe(false)
    expect(hasExplicitIdentitySharingConsent({ share_identity: true, identity_sharing_preference_set: null })).toBe(false)
  })

  it('denies missing preference rows and failed lookups', () => {
    expect(hasExplicitIdentitySharingConsent(null)).toBe(false)
    expect(hasExplicitIdentitySharingConsent({ share_identity: true, identity_sharing_preference_set: true }, true)).toBe(false)
  })
})
