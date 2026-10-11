export const MAX_BODY_BYTES = 12 * 1024
export const MAX_QUESTION_CHARS = 1500
export const MAX_HISTORY_ITEMS = 6
export const MAX_HISTORY_CHARS = 2000

export type AssistantHistoryItem = { role: 'user' | 'assistant'; content: string }
export type AssistantInput = { question: string; history: AssistantHistoryItem[]; pageContext: string }

export class AssistantInputError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const pageContexts = new Set(['today', 'trackers', 'analytics', 'goals', 'calendar', 'history', 'settings', 'other'])

export function normalizeAssistantInput(value: unknown): AssistantInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssistantInputError(400, 'Invalid request.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['question', 'history', 'pageContext'].includes(key))) throw new AssistantInputError(400, 'Invalid request.')
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > MAX_QUESTION_CHARS) throw new AssistantInputError(400, 'Enter a question under 1,500 characters.')
  const pageContext = typeof input.pageContext === 'string' && pageContexts.has(input.pageContext) ? input.pageContext : 'other'
  const history = Array.isArray(input.history) ? input.history.slice(-MAX_HISTORY_ITEMS).flatMap((entry): AssistantHistoryItem[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    if ((item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') return []
    return [{ role: item.role, content: item.content.slice(0, MAX_HISTORY_CHARS) }]
  }) : []
  return { question: input.question.trim(), history, pageContext }
}

/** 429 is a provider-imposed quota signal: never cross credentials in response. */
export function shouldFailoverToSecondary(status: number): boolean {
  return status === 0 || status === 401 || status === 403 || status >= 500
}

export function tokenize(text: string): string[] { return [...new Set(text.toLocaleLowerCase().match(/[a-z0-9]{3,}/g) ?? [])] }

export function findVerifiedAnswer(question: string, memory: Array<{ question: string; answer: string }>) {
  const terms = tokenize(question)
  const normalizedQuestion = question.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
  return memory.map((item) => {
    const knownQuestion = item.question.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
    const sourceText = `${item.question} ${item.answer}`.toLocaleLowerCase()
    const score = terms.filter((term) => sourceText.includes(term)).length
    return { item, score, exact: normalizedQuestion === knownQuestion }
  }).sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score)
    .find(({ score, exact }) => exact || (terms.length > 0 && score >= Math.min(2, terms.length) && score / terms.length >= 0.5))?.item ?? null
}

export function isGeneralConversation(question: string, history: AssistantHistoryItem[]): boolean {
  const privateSignal = /\b(?:i|me|my|mine|we|us|our|ours|tracker named|my tracker)\b|\b\d+(?:\.\d+)?\b|\b\d{4}-\d{2}-\d{2}\b/i
  return ![question, ...history.map(({ content }) => content)].some((text) => privateSignal.test(text))
}

export async function createCandidateFingerprint(answer: string, sourceRefs: string[]): Promise<string> {
  const input = `${sourceRefs.slice().sort().join('\n')}\n${answer.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
