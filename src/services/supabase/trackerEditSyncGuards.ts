import { getSupabaseClient } from './client'

/** Probe the installed server contract before persisting a date-effective edit. */
export async function hasTrackerEditSyncGuardsContract(): Promise<boolean> {
  if (!import.meta.env.PROD) return true
  const client = getSupabaseClient()
  if (!client) return false
  try {
    const { data, error } = await client.rpc('tracker_edit_sync_guards_contract')
    return !error && data === 'tracker-edit-sync-guards:v1'
  } catch {
    return false
  }
}
