import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from './client'

/**
 * Keep the server's date policy aligned with the workspace's calendar date.
 * An unconfigured database default (including UTC) is seeded from the saved
 * workspace preference; an explicitly configured account timezone is shared.
 */
export async function ensureAccountWorkspaceTimeZone(
  userId: string,
  fallbackTimeZone: string,
  clientInput: SupabaseClient | null = getSupabaseClient(),
): Promise<string | null> {
  if (!clientInput) return null
  const { data, error } = await clientInput.from('app_settings').select('timezone,timezone_configured').eq('user_id', userId).maybeSingle()
  if (error) throw workspaceTimeZoneError('read', error)
  if (data?.timezone_configured === true && typeof data.timezone === 'string' && data.timezone.length > 0) return data.timezone

  const { error: saveError } = await clientInput.from('app_settings').upsert({
    id: 'general', user_id: userId, timezone: fallbackTimeZone, timezone_configured: true,
  }, { onConflict: 'user_id' })
  if (saveError) throw workspaceTimeZoneError('save', saveError)
  return fallbackTimeZone
}

function workspaceTimeZoneError(action: 'read' | 'save', cause: { message: string; code?: string }): Error {
  const code = cause.code ? ` (${cause.code})` : ''
  return new Error(`Unable to ${action} the account workspace time zone${code}: ${cause.message}`, { cause })
}

/** Persist a user's explicit workspace timezone choice for server-side date rules. */
export async function saveAccountWorkspaceTimeZone(
  userId: string,
  timeZone: string,
  clientInput: SupabaseClient | null = getSupabaseClient(),
): Promise<boolean> {
  if (!clientInput) return false
  try {
    const { error } = await clientInput.from('app_settings').upsert({
      id: 'general', user_id: userId, timezone: timeZone, timezone_configured: true,
    }, { onConflict: 'user_id' })
    return !error
  } catch {
    return false
  }
}
