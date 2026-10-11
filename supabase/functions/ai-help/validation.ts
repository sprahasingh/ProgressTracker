export const MAX_BODY_BYTES = 12 * 1024
export const MAX_QUESTION_CHARS = 1500
export const MAX_HISTORY_ITEMS = 6
export const MAX_HISTORY_CHARS = 2000

export type AssistantHistoryItem = { role: 'user' | 'assistant'; content: string }
export type AssistantInput = { question: string; history: AssistantHistoryItem[]; pageContext: string }

export class AssistantInputError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'invalid_request', readonly retryAfterSeconds?: number) { super(message) }
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

export function tokenize(text: string): string[] {
  return [...new Set((text.toLocaleLowerCase().match(/[a-z0-9]{3,}/g) ?? []).map((term) => {
    if (term.length > 5 && term.endsWith('ies')) return `${term.slice(0, -3)}y`
    if (term.length > 4 && term.endsWith('sses')) return term.slice(0, -2)
    if (term.length > 4 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1)
    return term
  }))]
}

export function findVerifiedAnswer(question: string, memory: Array<{ question: string; answer: string }>, history: AssistantHistoryItem[] = []) {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  const trimmed = question.trim()
  const contextDependent = trimmed.split(/\s+/).length <= 4 || /\b(?:it|that|those|them|this|these|other|same)\b/i.test(trimmed) || /^(?:and|what about|how about|why|can i|could i|does it|is it)\b/i.test(trimmed)
  if (history.length && contextDependent) return null
  const normalizedQuestion = normalize(question)
  // Reviewed answers are safe as exact FAQ hits. Keyword overlap is too broad
  // for conversational questions such as “only two types?” or “what about it?”.
  return memory.find((item) => normalize(item.question) === normalizedQuestion) ?? null
}

export function isGeneralConversation(question: string, history: AssistantHistoryItem[]): boolean {
  const privateSignal = /\b(?:i|me|my|mine|we|us|our|ours|tracker named|my tracker)\b|\b\d+(?:\.\d+)?\b|\b\d{4}-\d{2}-\d{2}\b/i
  return ![question, ...history.map(({ content }) => content)].some((text) => privateSignal.test(text))
}

