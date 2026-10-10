import { useEffect } from 'react'
import { subscribeToWorkspaceDataChanges } from './workspaceMutationEvents'

/** Refresh a mounted workspace view after local writes or downloaded sync data. */
export function useWorkspaceDataChanges(ownerUserId: string | null | undefined, ready: boolean, refresh: () => void | Promise<void>): void {
  useEffect(() => {
    if (!ready) return
    return subscribeToWorkspaceDataChanges((changedOwner) => {
      if (ownerUserId === undefined || changedOwner === ownerUserId) void refresh()
    })
  }, [ownerUserId, ready, refresh])
}
