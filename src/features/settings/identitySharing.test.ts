import { describe, expect, it, vi } from 'vitest'
import { getIdentitySharingPreference, setIdentitySharingPreference } from './identitySharing'

function clientFor({ preference = null, preferenceSet = preference !== null, readError = null, saveResult = true, saveError = null, userId = 'user-1' }: {
  preference?: boolean | null
  preferenceSet?: boolean | null
  readError?: unknown
  saveResult?: boolean | null
  saveError?: unknown
  userId?: string | null
} = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: preference === null ? null : { share_identity: preference, identity_sharing_preference_set: preferenceSet }, error: readError })
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  const rpc = vi.fn().mockResolvedValue({ data: saveResult, error: saveError })
  const getSession = vi.fn().mockResolvedValue({ data: { session: userId ? { user: { id: userId }, access_token: 'private-token' } : null }, error: null })
  return { client: { auth: { getSession }, from, rpc } as never, maybeSingle, eq, from, rpc, getSession }
}

describe('identity sharing preference', () => {
  it('loads the preference from the signed-in account across sessions', async () => {
    const { client, from, eq, getSession } = clientFor({ preference: true })
    await expect(getIdentitySharingPreference(client)).resolves.toBe(true)
    expect(getSession).toHaveBeenCalledOnce()
    expect(from).toHaveBeenCalledWith('app_settings')
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1')
  })

  it('defaults on only when the preference is missing and preserves an explicit opt-out', async () => {
    await expect(getIdentitySharingPreference(clientFor().client)).resolves.toBe(true)
    await expect(getIdentitySharingPreference(clientFor({ preference: false, preferenceSet: true }).client)).resolves.toBe(false)
    await expect(getIdentitySharingPreference(clientFor({ preference: true, preferenceSet: true }).client)).resolves.toBe(true)
    // New app_settings rows can exist for timezone or appearance while consent remains unset.
    await expect(getIdentitySharingPreference(clientFor({ preference: false, preferenceSet: null }).client)).resolves.toBe(true)
  })

  it('reports a load error instead of assuming that sharing is enabled', async () => {
    await expect(getIdentitySharingPreference(clientFor({ preference: true, readError: new Error('network') }).client))
      .rejects.toThrow('Your privacy setting could not be loaded.')
  })

  it('saves opt in and withdrawal through the authenticated database function', async () => {
    const enabled = clientFor({ saveResult: true })
    await expect(setIdentitySharingPreference(true, enabled.client)).resolves.toBe(true)
    expect(enabled.rpc).toHaveBeenCalledWith('set_identity_sharing_preference', { p_share_identity: true })
    const disabled = clientFor({ saveResult: false })
    await expect(setIdentitySharingPreference(false, disabled.client)).resolves.toBe(false)
    expect(disabled.rpc).toHaveBeenCalledWith('set_identity_sharing_preference', { p_share_identity: false })
  })

  it('reports save failures and requires an authenticated account', async () => {
    await expect(setIdentitySharingPreference(true, clientFor({ saveError: new Error('network') }).client))
      .rejects.toThrow('Your privacy setting could not be saved.')
    await expect(getIdentitySharingPreference(clientFor({ userId: null }).client))
      .rejects.toThrow('Sign in again to update your privacy setting.')
  })
})
