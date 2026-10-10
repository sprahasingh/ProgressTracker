/** A theme-aware, non-sensitive placeholder shown while a workspace is verified. */
export function WorkspaceLoadingState() {
  return (
    <section className="workspace-startup" role="status" aria-label="Preparing your workspace">
      <span className="workspace-startup-line workspace-startup-line-heading" aria-hidden="true" />
      <span className="workspace-startup-line workspace-startup-line-wide" aria-hidden="true" />
      <span className="workspace-startup-line workspace-startup-line-short" aria-hidden="true" />
      <span className="workspace-startup-card" aria-hidden="true" />
    </section>
  )
}
