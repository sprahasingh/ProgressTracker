import { tokenize, type AssistantHistoryItem } from './validation.ts'

export const KNOWLEDGE_CATEGORIES = ['core', 'trackers', 'goals', 'schedules', 'history', 'analytics', 'sync', 'privacy', 'account', 'notifications', 'settings', 'other'] as const
export type KnowledgeCategory = typeof KNOWLEDGE_CATEGORIES[number]

export type KnowledgeCandidate = {
  topicId: string
  title: string
  explanation: string
  detailedExplanation: string | null
  featureCategory: KnowledgeCategory
  sourceRefs: string[]
}

export type VerifiedKnowledge = {
  topic_id: string
  title: string
  explanation: string
  detailed_explanation: string | null
  feature_category: KnowledgeCategory
  source_refs: string[]
  source_fingerprints: Record<string, string>
  knowledge_version: string
  status: 'verified' | 'stale'
}

export function hasConflictingVerifiedKnowledge(entries: VerifiedKnowledge[]): boolean {
  const negations = new Set(['not', 'cannot', 'cant', 'unable', 'unavailable', 'unsupported', 'never', 'without'])
  const positive = new Set(['can', 'available', 'supported', 'required', 'requires', 'allowed'])
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const left = entries[leftIndex]!
    for (const right of entries.slice(leftIndex + 1)) {
      if (left.feature_category !== right.feature_category) continue
      const terms = (entry: VerifiedKnowledge) => new Set(tokenize(`${entry.title} ${entry.explanation}`).filter((term) => term.length > 3 && !stopWords.has(term) && !negations.has(term) && !positive.has(term)))
      const leftTerms = terms(left)
      const rightTerms = terms(right)
      const shared = [...leftTerms].filter((term) => rightTerms.has(term)).length
      const overlap = shared / Math.max(1, new Set([...leftTerms, ...rightTerms]).size)
      if (overlap < 0.72) continue
      const leftText = `${left.title} ${left.explanation}`.toLocaleLowerCase()
      const rightText = `${right.title} ${right.explanation}`.toLocaleLowerCase()
      const leftNegative = [...negations].some((word) => new RegExp(`\\b${word}\\b`).test(leftText))
      const rightNegative = [...negations].some((word) => new RegExp(`\\b${word}\\b`).test(rightText))
      const leftPositive = [...positive].some((word) => new RegExp(`\\b${word}\\b`).test(leftText))
      const rightPositive = [...positive].some((word) => new RegExp(`\\b${word}\\b`).test(rightText))
      if (leftNegative && rightPositive || rightNegative && leftPositive) return true
    }
  }
  return false
}

const stopWords = new Set(['about', 'after', 'also', 'are', 'been', 'being', 'can', 'could', 'does', 'for', 'from', 'have', 'into', 'is', 'its', 'may', 'not', 'only', 'should', 'that', 'the', 'their', 'this', 'through', 'what', 'when', 'where', 'which', 'while', 'with', 'would'])
const topicPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const privateContentPattern = /\b(?:i|me|my|mine|we|us|our|ours|your|you|your tracker|your account)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{4}-\d{2}-\d{2}\b|\+?\d[\d ()-]{7,}\d/i

function conceptTerms(text: string): string[] {
  return [...new Set(tokenize(text).map((term) => {
    if (['retired', 'retirement'].includes(term)) return 'retire'
    if (['immutable', 'immutability'].includes(term)) return 'immutable'
    if (['synchronization', 'synchronisation'].includes(term)) return 'sync'
    if (['streaks'].includes(term)) return 'streak'
    return term
  }))]
}

export function normalizeMaintainerEmails(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((email) => email.trim().toLocaleLowerCase()).filter(Boolean))
}

export function isMaintainer(email: string | undefined, allowlist: Set<string>): boolean {
  return Boolean(email && allowlist.has(email.trim().toLocaleLowerCase()))
}

export function parseKnowledgeCandidate(value: unknown, options: {
  allowedSourceRefs: Set<string>
  suppliedSourceRefs: Set<string>
  evidenceFingerprints: Record<string, string>
  sourceExcerpts: string
}): KnowledgeCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.topic_id !== 'string' || !topicPattern.test(candidate.topic_id)) return null
  if (typeof candidate.title !== 'string' || candidate.title.trim().length < 5 || candidate.title.length > 120) return null
  if (typeof candidate.explanation !== 'string' || candidate.explanation.trim().length < 40 || candidate.explanation.length > 1200) return null
  if (candidate.detailed_explanation !== undefined && candidate.detailed_explanation !== null && (typeof candidate.detailed_explanation !== 'string' || candidate.detailed_explanation.length > 2400)) return null
  if (typeof candidate.feature_category !== 'string' || !KNOWLEDGE_CATEGORIES.includes(candidate.feature_category as KnowledgeCategory)) return null
  if (!Array.isArray(candidate.source_refs) || !candidate.source_refs.length || candidate.source_refs.length > 4) return null
  const refs = [...new Set(candidate.source_refs.filter((ref): ref is string => typeof ref === 'string'))]
  if (refs.length !== candidate.source_refs.length || refs.some((ref) => !options.allowedSourceRefs.has(ref) || !options.suppliedSourceRefs.has(ref) || !options.evidenceFingerprints[ref])) return null
  const explanation = candidate.explanation.trim()
  const title = candidate.title.trim()
  const detailed = typeof candidate.detailed_explanation === 'string' ? candidate.detailed_explanation.trim() : ''
  if (privateContentPattern.test(`${title} ${explanation} ${detailed}`)) return null
  if (!candidateHasEvidenceOverlap(`${title} ${explanation} ${detailed}`, options.sourceExcerpts)) return null
  return {
    topicId: candidate.topic_id,
    title,
    explanation,
    detailedExplanation: detailed || null,
    featureCategory: candidate.feature_category as KnowledgeCategory,
    sourceRefs: refs,
  }
}

export function candidateHasEvidenceOverlap(candidateText: string, evidenceText: string): boolean {
  const candidateTerms = new Set(tokenize(candidateText).filter((term) => term.length > 3 && !stopWords.has(term)))
  const evidenceTerms = new Set(tokenize(evidenceText).filter((term) => term.length > 3 && !stopWords.has(term)))
  if (candidateTerms.size < 5 || !evidenceTerms.size) return false
  const overlap = [...candidateTerms].filter((term) => evidenceTerms.has(term)).length
  return overlap >= 3 && overlap / candidateTerms.size >= 0.18
}

export async function createKnowledgeFingerprint(candidate: KnowledgeCandidate): Promise<string> {
  const normalized = `${candidate.topicId}\n${candidate.title.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}\n${candidate.explanation.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}\n${candidate.sourceRefs.slice().sort().join('\n')}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function validateReviewEdits(value: unknown, currentRefs: Set<string>, evidenceFingerprints: Record<string, string>, currentEvidence: string): KnowledgeCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Candidate edits are invalid.')
  const input = value as Record<string, unknown>
  const candidate = {
    topic_id: input.topic_id,
    title: input.title,
    explanation: input.explanation,
    detailed_explanation: input.detailed_explanation ?? null,
    feature_category: input.feature_category,
    source_refs: input.source_refs,
  }
  const parsed = parseKnowledgeCandidate(candidate, {
    allowedSourceRefs: currentRefs,
    suppliedSourceRefs: currentRefs,
    evidenceFingerprints,
    sourceExcerpts: currentEvidence,
  })
  if (!parsed) throw new Error('Edit the candidate using current source evidence and valid topic fields.')
  return parsed
}

export function rankVerifiedKnowledge(question: string, history: AssistantHistoryItem[], entries: readonly VerifiedKnowledge[], limit = 3): VerifiedKnowledge[] {
  const terms = new Set(conceptTerms(question).filter((term) => !stopWords.has(term)))
  const priorUserTerms = new Set(history.filter((item) => item.role === 'user').slice(-2).flatMap((item) => conceptTerms(item.content)))
  return entries.filter((entry) => entry.status === 'verified').map((entry, index) => {
    const text = `${entry.topic_id} ${entry.title} ${entry.explanation} ${entry.detailed_explanation ?? ''} ${entry.feature_category}`
    const entryTerms = new Set(conceptTerms(text))
    const currentMatches = [...terms].filter((term) => entryTerms.has(term)).length
    const contextMatches = [...priorUserTerms].filter((term) => entryTerms.has(term) && !terms.has(term)).length
    const score = currentMatches * 3 + contextMatches * 0.5
    return { entry, score, index }
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(({ entry }) => entry)
}

export function mapFeatureCategory(pageContext: string): KnowledgeCategory {
  if (pageContext === 'today') return 'schedules'
  if (pageContext === 'calendar') return 'schedules'
  if (pageContext === 'trackers') return 'trackers'
  if (pageContext === 'goals') return 'goals'
  if (pageContext === 'analytics') return 'analytics'
  if (pageContext === 'history') return 'history'
  if (pageContext === 'settings') return 'settings'
  return 'other'
}

export function scheduleBestEffortCandidateCollection(task: Promise<unknown>, waitUntil?: (promise: Promise<unknown>) => void): void {
  const safeTask = task.catch(() => undefined)
  if (waitUntil) waitUntil(safeTask)
  else void safeTask
}
