import { useEffect } from 'react'
import { subscribeToWorkspaceDataChanges } from './workspaceMutationEvents'

/** Refresh a mounted workspace view after local writes or downloaded sync data. */
export function useWorkspaceDataChanges(ownerUserId: string | null | undefined, ready: boolean, refresh: () => void | Promise<void>, refreshOnSyncCompletion = false, refreshAfterSync?: () => void | Promise<void>): void {
  useEffect(() => {
    if (!ready) return
    return subscribeToWorkspaceDataChanges((changedOwner, kind) => {
      if ((ownerUserId === undefined || changedOwner === ownerUserId) && kind === 'data') void refresh()
      else if (ownerUserId === undefined || changedOwner === ownerUserId) {
        if (refreshOnSyncCompletion) void (refreshAfterSync ?? refresh)()
      }
    })
  }, [ownerUserId, ready, refresh, refreshAfterSync, refreshOnSyncCompletion])
}
