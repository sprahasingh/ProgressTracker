export type ReconciliationCounts = {
  verified_stale: number
  candidates_stale: number
  duplicate_candidates_stale?: number
}

export type ReconciliationRpc = (
  name: 'reconcile_ai_knowledge',
  args: { p_current_fingerprints: Record<string, string>; p_knowledge_version: string },
) => PromiseLike<unknown>

export class ReconciliationResponseError extends Error {
  constructor() {
    super('Invalid reconciliation response.')
    this.name = 'ReconciliationResponseError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateEvidenceManifest(fingerprints: unknown, version: unknown): asserts fingerprints is Record<string, string> {
  if (!isRecord(fingerprints) || !Object.keys(fingerprints).length || typeof version !== 'string' || !version.length) throw new ReconciliationResponseError()
  if (Object.values(fingerprints).some((value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
    throw new ReconciliationResponseError()
  }
}

export function validateReconciliationCounts(value: unknown): ReconciliationCounts {
  if (!isRecord(value)) throw new ReconciliationResponseError()
  const required = ['verified_stale', 'candidates_stale'] as const
  const optional = ['duplicate_candidates_stale'] as const
  if (required.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    || (value.duplicate_candidates_stale !== undefined
      && (!Number.isSafeInteger(value.duplicate_candidates_stale) || (value.duplicate_candidates_stale as number) < 0))) {
    throw new ReconciliationResponseError()
  }
  return {
    verified_stale: value.verified_stale as number,
    candidates_stale: value.candidates_stale as number,
    ...(optional[0] in value ? { duplicate_candidates_stale: value.duplicate_candidates_stale as number } : {}),
  }
}

/** Invokes the RPC without swallowing thrown failures, then checks the JSONB contract. */
export async function runKnowledgeReconciliation(
  rpc: ReconciliationRpc,
  fingerprints: Record<string, string>,
  version: string,
  stage: (operation: string) => void,
) {
  validateEvidenceManifest(fingerprints, version)
  stage('reconciliation_rpc_invocation')
  const response: unknown = await rpc('reconcile_ai_knowledge', {
    p_current_fingerprints: fingerprints,
    p_knowledge_version: version,
  })
  stage('reconciliation_rpc_response')
  if (!isRecord(response) || !('data' in response) || !('error' in response)) throw new ReconciliationResponseError()
  if (response.error) {
    stage('reconciliation_rpc_returned_error')
    return { data: null, error: response.error }
  }

  stage('reconciliation_result_validation')
  const counts = validateReconciliationCounts(response.data)
  stage('knowledge_freshness_reconciliation_complete')
  return { data: counts, error: null }
}
