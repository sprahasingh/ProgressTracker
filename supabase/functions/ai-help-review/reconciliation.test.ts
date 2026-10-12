import { describe, expect, it, vi } from 'vitest'
import { evidenceFingerprints, sourceVersion } from '../ai-help/_generated/sourceBundle'
import { mergeKnowledgePage } from '../_shared/knowledgePagination'
import { resolveReviewListPagination } from './listPagination'
import { runKnowledgeReconciliation, validateEvidenceManifest } from './reconciliation'

const fingerprints = { 'src/example.ts': 'a'.repeat(64) }
const version = '0.1.0+test'

describe('AI Help knowledge freshness reconciliation', () => {
  it('accepts the generated bundle manifest used by the production RPC caller', () => {
    expect(() => validateEvidenceManifest(evidenceFingerprints, sourceVersion)).not.toThrow()
  })

  it('passes the manifest with the SQL RPC argument names and validates a successful JSONB result', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { verified_stale: 0, candidates_stale: 1, duplicate_candidates_stale: 0 }, error: null,
    })
    const stages: string[] = []
    const result = await runKnowledgeReconciliation(rpc, fingerprints, version, (stage) => stages.push(stage))

    expect(rpc).toHaveBeenCalledWith('reconcile_ai_knowledge', {
      p_current_fingerprints: fingerprints,
      p_knowledge_version: version,
    })
    expect(result).toEqual({ data: { verified_stale: 0, candidates_stale: 1, duplicate_candidates_stale: 0 }, error: null })
    expect(stages).toEqual([
      'reconciliation_rpc_invocation', 'reconciliation_rpc_response',
      'reconciliation_result_validation', 'knowledge_freshness_reconciliation_complete',
    ])
  })

  it('propagates a thrown RPC failure to the outer handler instead of masking it', async () => {
    const rpc = vi.fn().mockRejectedValue(new TypeError('private network details'))
    const stages: string[] = []

    await expect(runKnowledgeReconciliation(rpc, fingerprints, version, (stage) => stages.push(stage)))
      .rejects.toMatchObject({ name: 'TypeError' })
    expect(stages).toEqual(['reconciliation_rpc_invocation'])
  })

  it('continues into the candidate-list page after freshness reconciliation succeeds', async () => {
    const result = await runKnowledgeReconciliation(
      vi.fn().mockResolvedValue({ data: { verified_stale: 0, candidates_stale: 0, duplicate_candidates_stale: 0 }, error: null }),
      fingerprints, version, () => {},
    )
    const pagination = resolveReviewListPagination({ status: 'pending', limit: 10, offset: 0 })
    const page = result.error ? null : mergeKnowledgePage({
      candidates: [{ id: 'candidate-1', created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z', reviewed_at: null }],
      verified: [], limit: 10,
      candidateOffset: pagination.candidateOffset,
      verifiedOffset: pagination.verifiedOffset,
      sort: 'newest',
    })
    expect(page?.candidates.map((candidate) => candidate.id)).toEqual(['candidate-1'])
  })

  it('returns a normal RPC error for the caller to log and map to the generic service response', async () => {
    const error = { code: '22023', message: 'private SQL message' }
    const stages: string[] = []
    const result = await runKnowledgeReconciliation(
      vi.fn().mockResolvedValue({ data: null, error }), fingerprints, version, (stage) => stages.push(stage),
    )
    expect(result).toEqual({ data: null, error })
    expect(stages).toEqual(['reconciliation_rpc_invocation', 'reconciliation_rpc_response', 'reconciliation_rpc_returned_error'])
  })

  it('rejects malformed manifests and unexpected response shapes', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { verified_stale: '0', candidates_stale: 0 }, error: null })
    await expect(runKnowledgeReconciliation(rpc, { 'src/example.ts': 'not-a-fingerprint' }, version, () => {}))
      .rejects.toMatchObject({ name: 'ReconciliationResponseError' })
    await expect(runKnowledgeReconciliation(rpc, fingerprints, version, () => {}))
      .rejects.toMatchObject({ name: 'ReconciliationResponseError' })
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
