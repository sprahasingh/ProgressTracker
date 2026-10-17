import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../services/supabase/client'

export class IdentitySharingError extends Error {}

function requireClient(client: SupabaseClient | null) {
  if (!client) throw new IdentitySharingError('Privacy settings are unavailable because the account service is not configured.')
  return client
}

async function requireSignedInUser(client: SupabaseClient) {
  const { data, error } = await client.auth.getSession()
  const userId = data.session?.user.id
  if (error || !userId) throw new IdentitySharingError('Sign in again to update your privacy setting.')
  return userId
}

/** A missing or not-yet-chosen preference defaults to sharing details. */
export async function getIdentitySharingPreference(clientInput: SupabaseClient | null = getSupabaseClient()): Promise<boolean> {
  const client = requireClient(clientInput)
  const userId = await requireSignedInUser(client)
  const { data, error } = await client.from('app_settings').select('share_identity,identity_sharing_preference_set').eq('user_id', userId).maybeSingle()
  if (error) throw new IdentitySharingError('Your privacy setting could not be loaded. Try again.')
  return data?.identity_sharing_preference_set === true ? data.share_identity === true : true
}

/** The database RPC saves the preference and withdraws prior submissions atomically. */
export async function setIdentitySharingPreference(shareIdentity: boolean, clientInput: SupabaseClient | null = getSupabaseClient()): Promise<boolean> {
  const client = requireClient(clientInput)
  await requireSignedInUser(client)
  const { data, error } = await client.rpc('set_identity_sharing_preference', { p_share_identity: shareIdentity })
  if (error || data !== shareIdentity) throw new IdentitySharingError('Your privacy setting could not be saved. Try again.')
  return data
}
