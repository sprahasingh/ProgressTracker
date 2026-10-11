import { describe, expect, it } from 'vitest'
import { candidateHasEvidenceOverlap, createKnowledgeFingerprint, isMaintainer, normalizeMaintainerEmails, parseKnowledgeCandidate, rankVerifiedKnowledge, scheduleBestEffortCandidateCollection, validateReviewEdits } from './learningCore'

const sourcePath = 'src/domain/trackers/invariants.ts'
const sourceExcerpts = `SOURCE ${sourcePath} · implementation · assertTrackerInvariant · lines 10-24
A saved measure keeps its original value type. Existing check-ins retain their original interpretation, so the type cannot be changed after the measure is saved.`
const fingerprints = { [sourcePath]: 'source-sha-256' }
const rawCandidate = {
  topic_id: 'measures.type_immutability',
  title: 'Saved measure types stay fixed',
  explanation: 'A saved measure keeps its original value type so existing check-ins preserve their original interpretation.',
  detailed_explanation: null,
  feature_category: 'trackers',
  source_refs: [sourcePath],
}

describe('AI Help verified knowledge workflow helpers', () => {
  it('accepts standalone source-backed candidates and fingerprints only candidate content', async () => {
    const candidate = parseKnowledgeCandidate(rawCandidate, { allowedSourceRefs: new Set([sourcePath]), suppliedSourceRefs: new Set([sourcePath]), evidenceFingerprints: fingerprints, sourceExcerpts })
    expect(candidate).toMatchObject({ topicId: 'measures.type_immutability', sourceRefs: [sourcePath] })
    expect(await createKnowledgeFingerprint(candidate!)).toMatch(/^[a-f0-9]{64}$/)
    expect(await createKnowledgeFingerprint(candidate!)).toBe(await createKnowledgeFingerprint(candidate!))
  })

  it('rejects unsupported, unsupplied, weakly grounded, personal, malformed, and unapproved-category candidates', () => {
    const options = { allowedSourceRefs: new Set([sourcePath]), suppliedSourceRefs: new Set([sourcePath]), evidenceFingerprints: fingerprints, sourceExcerpts }
    expect(parseKnowledgeCandidate(rawCandidate, { ...options, suppliedSourceRefs: new Set() })).toBeNull()
    expect(parseKnowledgeCandidate({ ...rawCandidate, source_refs: ['src/not-indexed.ts'] }, options)).toBeNull()
    expect(parseKnowledgeCandidate({ ...rawCandidate, explanation: 'It is useful.' }, options)).toBeNull()
    expect(parseKnowledgeCandidate({ ...rawCandidate, explanation: 'Your tracker Alpha keeps its original value type so existing check-ins preserve their interpretation.' }, options)).toBeNull()
    expect(parseKnowledgeCandidate({ ...rawCandidate, feature_category: 'billing' }, options)).toBeNull()
    expect(parseKnowledgeCandidate({ ...rawCandidate, topic_id: 'measure type' }, options)).toBeNull()
  })

  it('keeps related concepts with distinct topic identifiers and flags evidence overlap without merging them', () => {
    const retirement = parseKnowledgeCandidate({ ...rawCandidate, topic_id: 'measures.retirement', title: 'Retiring a measure', explanation: 'Retiring a saved measure keeps old check-ins available while preventing new check-ins from recording values for it.' }, { allowedSourceRefs: new Set([sourcePath]), suppliedSourceRefs: new Set([sourcePath]), evidenceFingerprints: fingerprints, sourceExcerpts: `${sourceExcerpts}\nA retired measure remains available in historical entries.` })
    expect(retirement?.topicId).toBe('measures.retirement')
    expect(retirement?.topicId).not.toBe('measures.type_immutability')
    expect(candidateHasEvidenceOverlap('Saved measure keeps its original value type', sourceExcerpts)).toBe(true)
  })

  it('requires current indexed evidence when maintainers edit candidates', () => {
    const edited = validateReviewEdits(rawCandidate, new Set([sourcePath]), fingerprints, sourceExcerpts)
    expect(edited.explanation).toBe(rawCandidate.explanation)
    expect(() => validateReviewEdits({ ...rawCandidate, explanation: 'A measure can always change.' }, new Set([sourcePath]), fingerprints, sourceExcerpts)).toThrow()
  })

  it('uses verified concepts as ranked evidence while preserving topic-specific intent', () => {
    const entries = [
      { topic_id: 'measures.type_immutability', title: 'Measure type changes', explanation: 'Saved measure types stay fixed.', detailed_explanation: null, feature_category: 'trackers' as const, source_refs: [sourcePath], source_fingerprints: fingerprints, knowledge_version: 'v1', status: 'verified' as const },
      { topic_id: 'measures.retirement', title: 'Measure retirement', explanation: 'Retirement preserves history.', detailed_explanation: null, feature_category: 'trackers' as const, source_refs: [sourcePath], source_fingerprints: fingerprints, knowledge_version: 'v1', status: 'verified' as const },
      { topic_id: 'goals.pacing', title: 'Goal pacing', explanation: 'Cumulative target pacing uses its deadline.', detailed_explanation: null, feature_category: 'goals' as const, source_refs: [sourcePath], source_fingerprints: fingerprints, knowledge_version: 'v1', status: 'stale' as const },
    ]
    expect(rankVerifiedKnowledge('Can I change a saved measure type?', [], entries)[0]?.topic_id).toBe('measures.type_immutability')
    expect(rankVerifiedKnowledge('How do I retire a measure?', [], entries)[0]?.topic_id).toBe('measures.retirement')
    expect(rankVerifiedKnowledge('How do cumulative goals work?', [], entries).some((entry) => entry.status === 'stale')).toBe(false)
  })

  it('normalizes and enforces an explicit maintainer email allowlist', () => {
    const allowlist = normalizeMaintainerEmails(' OWNER@example.test, reviewer@example.test ,,')
    expect(isMaintainer('owner@EXAMPLE.test', allowlist)).toBe(true)
    expect(isMaintainer('user@example.test', allowlist)).toBe(false)
    expect(isMaintainer(undefined, allowlist)).toBe(false)
    expect(normalizeMaintainerEmails(undefined).size).toBe(0)
  })

  it('schedules candidate writes as best-effort work that cannot reject the answer path', async () => {
    let background: Promise<unknown> | undefined
    expect(() => scheduleBestEffortCandidateCollection(Promise.reject(new Error('database unavailable')), (task) => { background = task })).not.toThrow()
    await expect(background).resolves.toBeUndefined()
    expect(() => scheduleBestEffortCandidateCollection(Promise.resolve(), undefined)).not.toThrow()
  })
})
