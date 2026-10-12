export const feedbackCategories = ['bug_report', 'feature_request', 'general_feedback', 'help_support'] as const
export type FeedbackCategory = typeof feedbackCategories[number]
export type DeliveryCategory = FeedbackCategory | 'ai_answer_feedback'

export const feedbackCategoryLabels: Record<DeliveryCategory, string> = {
  bug_report: 'Bug Report', feature_request: 'Feature Request', general_feedback: 'General Feedback',
  help_support: 'Help / Support', ai_answer_feedback: 'AI Answer Feedback',
}

export type FeedbackSubmission = { category: DeliveryCategory; message: string; requestId: string; source?: string; subject?: string; feedbackId?: string; submittedAt?: string; evidenceContext?: { answerCategory?: string; topic?: string; knowledgeVersion?: string; responseId?: string } }
export type FeedbackIdentity = { userId: string; email: string | null }

const emailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const credentialPattern = /(?:password|passcode)\s+(?:is\s+)?[:=]?\s*\S+|(?:access|refresh)[_-]?token\s*[:=]\s*\S+|bearer\s+[a-z0-9._~+/-]+=*|eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/i

export function validateFeedbackSubmission(value: unknown): FeedbackSubmission | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['category', 'message', 'request_id', 'source', 'subject'].includes(key))) return null
  if (typeof input.category !== 'string' || !feedbackCategories.includes(input.category as FeedbackCategory)) return null
  if (typeof input.message !== 'string' || input.message.trim().length < 1 || input.message.trim().length > 2000) return null
  if (input.source !== undefined && !['settings','ai_help_support','other'].includes(String(input.source))) return null
  if (input.subject !== undefined && (typeof input.subject !== 'string' || input.subject.trim().length < 1 || input.subject.trim().length > 160)) return null
  if (credentialPattern.test(input.message)) return null
  if (typeof input.request_id !== 'string' || !uuidPattern.test(input.request_id)) return null
  return {
    category: input.category as FeedbackCategory,
    message: input.message.trim(),
    requestId: input.request_id,
    ...(typeof input.source === 'string' ? { source: input.source } : {}),
    ...(typeof input.subject === 'string' ? { subject: input.subject.trim() } : {}),
  }
}

export function validReplyAddress(value: string | null | undefined): string | null {
  return value && value.length <= 254 && emailPattern.test(value) ? value : null
}

export function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

export function buildFeedbackEmail(input: FeedbackSubmission, identity: FeedbackIdentity, sentAt: Date, appVersion: string) {
  const category = feedbackCategoryLabels[input.category]
  const replyEmail = validReplyAddress(identity.email)
  const timestamp = sentAt.toISOString()
  const message = input.message
  const escapedMessage = escapeEmailHtml(message)
  const escapedReplyEmail = replyEmail ? escapeEmailHtml(replyEmail) : 'Not available'
  return {
    subject: `[ProgressTracker Feedback] ${category}`,
    text: [
      `Feedback type: ${category}`,
      ...(input.feedbackId ? [`Feedback ID: ${input.feedbackId}`] : []),
      ...(input.subject ? [`Subject: ${input.subject}`] : []),
      ...(input.source ? [`Source: ${input.source}`] : []),
      ...(input.evidenceContext?.answerCategory ? [`Answer feedback category: ${input.evidenceContext.answerCategory}`] : []),
      ...(input.evidenceContext?.topic ? [`AI Help topic: ${input.evidenceContext.topic}`] : []),
      ...(input.evidenceContext?.knowledgeVersion ? [`Knowledge bundle: ${input.evidenceContext.knowledgeVersion}`] : []),
      ...(input.evidenceContext?.responseId ? [`Response ID: ${input.evidenceContext.responseId}`] : []),
      `Reply email: ${replyEmail ?? 'Not available'}`,
      `Submitted: ${input.submittedAt ?? timestamp}`,
      `App version: ${appVersion}`,
      '',
      'Message:',
      message,
    ].join('\n'),
    html: `<h2>ProgressTracker feedback: ${category}</h2>${input.feedbackId ? `<p><strong>Feedback ID:</strong> ${escapeEmailHtml(input.feedbackId)}</p>` : ''}${input.subject ? `<p><strong>Subject:</strong> ${escapeEmailHtml(input.subject)}</p>` : ''}${input.source ? `<p><strong>Source:</strong> ${escapeEmailHtml(input.source)}</p>` : ''}${input.evidenceContext?.answerCategory ? `<p><strong>Answer feedback category:</strong> ${escapeEmailHtml(input.evidenceContext.answerCategory)}</p>` : ''}${input.evidenceContext?.topic ? `<p><strong>AI Help topic:</strong> ${escapeEmailHtml(input.evidenceContext.topic)}</p>` : ''}${input.evidenceContext?.knowledgeVersion ? `<p><strong>Knowledge bundle:</strong> ${escapeEmailHtml(input.evidenceContext.knowledgeVersion)}</p>` : ''}${input.evidenceContext?.responseId ? `<p><strong>Response ID:</strong> ${escapeEmailHtml(input.evidenceContext.responseId)}</p>` : ''}<p><strong>Reply email:</strong> ${escapedReplyEmail}</p><p><strong>Submitted:</strong> ${escapeEmailHtml(input.submittedAt ?? timestamp)}</p><p><strong>App version:</strong> ${escapeEmailHtml(appVersion)}</p><hr><p><strong>Message:</strong></p><pre style="white-space:pre-wrap;font:inherit">${escapedMessage}</pre>`,
    replyTo: replyEmail,
  }
}

export type DeliveryConfig = { apiKey: string; from: string; to: string; appVersion: string }
export type DeliveryResult = { accepted: boolean; outcome: 'accepted' | 'rejected' | 'uncertain'; status: number; retryable: boolean; providerMessageId?: string }

export async function deliverFeedbackEmail(
  input: FeedbackSubmission,
  identity: FeedbackIdentity,
  config: DeliveryConfig,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<DeliveryResult> {
  if (!config.apiKey || !validReplyAddress(config.from) || !validReplyAddress(config.to)) return { accepted: false, outcome: 'rejected', status: 503, retryable: false }
  const message = buildFeedbackEmail(input, identity, now, config.appVersion)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetcher('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'api-key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'ProgressTracker Feedback', email: config.from },
        to: [{ email: config.to }],
        ...(message.replyTo ? { replyTo: { email: message.replyTo } } : {}),
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html,
      }),
    })
    if (response.ok) {
      const payload = await response.json().catch(() => null) as { messageId?: unknown } | null
      return typeof payload?.messageId === 'string' && payload.messageId
        ? { accepted: true, outcome: 'accepted', status: response.status, retryable: false, providerMessageId: payload.messageId }
        : { accepted: false, outcome: 'uncertain', status: response.status, retryable: false }
    }
    if (response.status >= 400 && response.status < 500) {
      return { accepted: false, outcome: 'rejected', status: response.status, retryable: response.status === 429 }
    }
    return { accepted: false, outcome: 'uncertain', status: response.status, retryable: false }
  } catch {
    return { accepted: false, outcome: 'uncertain', status: 503, retryable: false }
  } finally {
    clearTimeout(timeout)
  }
}
