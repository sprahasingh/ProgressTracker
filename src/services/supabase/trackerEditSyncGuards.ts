import { getSupabaseClient } from './client'

/** Probe the installed server contract before persisting a date-effective edit. */
export async function hasTrackerEditSyncGuardsContract(contractProbe?: () => Promise<{ data: unknown; error: unknown }>): Promise<boolean> {
  if (!import.meta.env.PROD) return true
  const client = contractProbe ? null : getSupabaseClient()
  if (!contractProbe && !client) return false
  try {
    const { data, error } = contractProbe
      ? await contractProbe()
      : await client!.rpc('tracker_edit_sync_guards_contract')
    return !error && data === 'tracker-edit-sync-guards:v2'
  } catch {
    return false
  }
}
