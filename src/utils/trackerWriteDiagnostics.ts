export type TrackerWriteDiagnosticCategory =
  | 'invalid-tracker-definition'
  | 'unsupported-schema-version'
  | 'local-persistence-failure'
  | 'sync-failure'
  | 'server-validation-rejection'
  | 'revision-conflict'
  | 'network-failure'

export type TrackerWriteDiagnosticPhase =
  | 'editor-validation'
  | 'version-construction'
  | 'local-save'
  | 'payload-validation'
  | 'server-request'
  | 'server-acknowledgement'
  | 'workspace-preflight'

/** Log stable failure categories and safe metadata only; never pass tracker IDs, payloads, or raw errors. */
export function reportTrackerWriteDiagnostic(input: {
  category: TrackerWriteDiagnosticCategory
  phase: TrackerWriteDiagnosticPhase
  schemaVersion?: number
  entity?: 'tracker' | 'tracker_entry' | 'account_holiday' | 'tracker_holiday'
  serverCode?: string
}): void {
  const metadata = {
    category: input.category,
    phase: input.phase,
    ...(Number.isInteger(input.schemaVersion) && input.schemaVersion! >= 1 && input.schemaVersion! <= 10 ? { schemaVersion: input.schemaVersion } : {}),
    ...(input.entity ? { entity: input.entity } : {}),
    ...(input.serverCode && /^[0-9A-Z]{2,5}$/.test(input.serverCode) ? { serverCode: input.serverCode } : {}),
  }
  console.error('[tracker-write]', metadata)
}

export function isNetworkFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  return cause instanceof TypeError || cause.name === 'AbortError' || /network|fetch|connection|timed out|timeout|offline/i.test(cause.message)
}

export function isUnsupportedSchemaFailure(cause: unknown): boolean {
  return cause instanceof Error && /unsupported schema version|schema v\d+|schema version.*(disabled|unsupported|required)/i.test(cause.message)
}
