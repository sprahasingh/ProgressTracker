type WorkspaceMutationListener = (ownerUserId: string) => void

const listeners = new Set<WorkspaceMutationListener>()

/** Subscribe to committed edits in a user-owned tracker workspace. */
export function subscribeToWorkspaceMutations(listener: WorkspaceMutationListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Notify the active app only after an account-owned IndexedDB transaction commits. */
export function publishWorkspaceMutation(ownerUserId: string | null | undefined): void {
  if (!ownerUserId) return
  for (const listener of listeners) listener(ownerUserId)
}
