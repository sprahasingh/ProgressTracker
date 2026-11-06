import { isNetworkFailure, isUnsupportedSchemaFailure } from '../../utils/trackerWriteDiagnostics'

export type SyncFailureCategory = 'local-storage' | 'authentication' | 'authorization' | 'network' | 'schema' | 'cloud-request'
export type SyncFailureDiagnostic = { operation: 'synchronizeWorkspace'; stage: 'initialize' | 'authenticate' | 'authorize' | 'network' | 'validate' | 'request'; category: SyncFailureCategory; occurredAt: string }
export const SYNC_FAILURE_DIAGNOSTIC_EVENT = 'progress-tracker:sync-failure-diagnostic'

function errorParts(error: unknown): { names: string[]; codes: Array<string | number>; messages: string[] } {
  const names: string[] = []; const codes: Array<string | number> = []; const messages: string[] = []
  let current = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const item = current as { name?: unknown; code?: unknown; status?: unknown; message?: unknown; cause?: unknown; inner?: unknown }
    if (typeof item.name === 'string') names.push(item.name)
    if (typeof item.code === 'string' || typeof item.code === 'number') codes.push(item.code)
    if (typeof item.status === 'number') codes.push(item.status)
    if (typeof item.message === 'string') messages.push(item.message)
    current = item.cause ?? item.inner
  }
  return { names, codes, messages }
}

export function classifySyncFailure(error: unknown): SyncFailureCategory {
  const parts = errorParts(error)
  if (parts.names.includes('LocalStorageFailure')) return 'local-storage'
  if (parts.codes.some((code) => ['403', '42501'].includes(String(code)))) return 'authorization'
  if (parts.names.some((name) => /Auth(Api)?Error/.test(name)) || parts.codes.some((code) => ['401', 'PGRST301'].includes(String(code))) || parts.messages.some((message) => /authenticated session|authenticated user|session.*verify/i.test(message))) return 'authentication'
  if (isNetworkFailure(error) || /^5\d\d$/.test(String(parts.codes[0] ?? ''))) return 'network'
  if (isUnsupportedSchemaFailure(error) || parts.names.includes('ZodError')) return 'schema'
  return 'cloud-request'
}

export function syncFailureMessage(category: SyncFailureCategory): string {
  switch (category) {
    case 'local-storage': return 'Local storage failed before synchronization. No records were cleared.'
    case 'authentication': return 'The account session or read authorization could not be verified. Reauthenticate or verify account access, then retry synchronization.'
    case 'authorization': return 'The authenticated account does not have permission to complete this synchronization request. Verify account access before retrying.'
    case 'network': return 'The cloud could not be reached. Local changes remain on this device for retry.'
    case 'schema': return 'The cloud schema or saved record format is incompatible with this app version. No records were cleared.'
    case 'cloud-request': return 'A cloud request failed. Review sync status and any reported conflicts before retrying.'
  }
}

export function reportSyncFailure(error: unknown): SyncFailureDiagnostic {
  const category = classifySyncFailure(error)
  const stage: SyncFailureDiagnostic['stage'] = category === 'local-storage' ? 'initialize'
    : category === 'authentication' ? 'authenticate'
      : category === 'authorization' ? 'authorize'
      : category === 'network' ? 'network'
        : category === 'schema' ? 'validate' : 'request'
  const diagnostic: SyncFailureDiagnostic = { operation: 'synchronizeWorkspace', stage, category, occurredAt: new Date().toISOString() }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<SyncFailureDiagnostic>(SYNC_FAILURE_DIAGNOSTIC_EVENT, { detail: diagnostic }))
  return diagnostic
}
