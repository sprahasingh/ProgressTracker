export type FeedbackTextResult = { explanation: string | null; error: 'too_long' | 'sensitive_content' | null }

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const credentialPattern = /(?:password|token|secret)\s*[:=]\s*\S+|bearer\s+\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i

export function validateFeedbackExplanation(value: unknown): FeedbackTextResult {
  if (typeof value !== 'string' || !value.trim()) return { explanation: null, error: null }
  const explanation = value.trim()
  if (explanation.length > 400) return { explanation: null, error: 'too_long' }
  if (emailPattern.test(explanation) || credentialPattern.test(explanation)) return { explanation: null, error: 'sensitive_content' }
  return { explanation, error: null }
}
