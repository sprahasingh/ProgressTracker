type WorkspaceMutationListener = (ownerUserId: string | null) => void
type WorkspaceDataListener = (ownerUserId: string | null) => void

const listeners = new Set<WorkspaceMutationListener>()
const dataListeners = new Set<WorkspaceDataListener>()
const workspaceChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
  ? new window.BroadcastChannel('progress-tracker-workspace-data')
  : null

function notifyDataListeners(ownerUserId: string | null): void {
  for (const listener of dataListeners) listener(ownerUserId)
}

workspaceChannel?.addEventListener('message', (event: MessageEvent<{ ownerUserId: string | null }>) => {
  if (event.data && 'ownerUserId' in event.data) notifyDataListeners(event.data.ownerUserId)
})

/** Subscribe to committed edits that should trigger authenticated synchronization. */
export function subscribeToWorkspaceMutations(listener: WorkspaceMutationListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Subscribe to committed local or downloaded workspace data changes. */
export function subscribeToWorkspaceDataChanges(listener: WorkspaceDataListener): () => void {
  dataListeners.add(listener)
  return () => dataListeners.delete(listener)
}

/** Notify views after a remote sync changes their local workspace snapshot. */
export function publishWorkspaceDataChange(ownerUserId: string | null): void {
  notifyDataListeners(ownerUserId)
  workspaceChannel?.postMessage({ ownerUserId })
}

/** Notify views and sync listeners after a local IndexedDB transaction commits. */
export function publishWorkspaceMutation(ownerUserId: string | null | undefined): void {
  if (ownerUserId === undefined) return
  notifyDataListeners(ownerUserId)
  workspaceChannel?.postMessage({ ownerUserId })
  for (const listener of listeners) listener(ownerUserId)
}
