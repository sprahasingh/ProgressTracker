type WorkspaceMutationListener = (ownerUserId: string | null) => void
type WorkspaceDataListener = (ownerUserId: string | null) => void

const listeners = new Set<WorkspaceMutationListener>()
const dataListeners = new Set<WorkspaceDataListener>()

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
  for (const listener of dataListeners) listener(ownerUserId)
}

/** Notify views and sync listeners after a local IndexedDB transaction commits. */
export function publishWorkspaceMutation(ownerUserId: string | null | undefined): void {
  if (ownerUserId === undefined) return
  for (const listener of dataListeners) listener(ownerUserId)
  for (const listener of listeners) listener(ownerUserId)
}
