/** Maintainer disclosure requires an explicit saved opt-in; missing/error states fail closed. */
export function hasExplicitIdentitySharingConsent(
  preference: { share_identity?: boolean | null; identity_sharing_preference_set?: boolean | null } | null | undefined,
  lookupFailed = false,
): boolean {
  return !lookupFailed
    && preference?.identity_sharing_preference_set === true
    && preference.share_identity === true
}
