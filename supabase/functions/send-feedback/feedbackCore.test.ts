import { describe, expect, it, vi } from 'vitest'
import { buildFeedbackEmail, deliverFeedbackEmail, validateFeedbackSubmission } from './feedbackCore'

const valid = { category: 'bug_report', message: '  The page froze after saving.  ', request_id: 'd9b71367-a20f-4ef1-b409-8b3cb7810c17' }

describe('general feedback validation and email delivery', () => {
  it('validates category, message length, and idempotency UUID', () => {
    expect(validateFeedbackSubmission(valid)).toEqual({ category: 'bug_report', message: 'The page froze after saving.', requestId: valid.request_id })
    expect(validateFeedbackSubmission({ ...valid, message: '  ' })).toBeNull()
    expect(validateFeedbackSubmission({ ...valid, message: 'x'.repeat(2001) })).toBeNull()
    expect(validateFeedbackSubmission({ ...valid, category: 'other' })).toBeNull()
    expect(validateFeedbackSubmission({ ...valid, request_id: 'bad' })).toBeNull()
    expect(validateFeedbackSubmission({ ...valid, recipient: 'attacker@example.com' })).toBeNull()
  })

  it('safely encodes message content and uses only the canonical recipient from server config', () => {
    const email = buildFeedbackEmail(validateFeedbackSubmission({ ...valid, message: '<script>alert("x")</script>' })!, { userId: 'user-1', email: 'person@example.com' }, new Date('2026-10-12T00:00:00Z'), '0.1.0')
    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
    expect(email.subject).toBe('[ProgressTracker Feedback] Bug Report')
    expect(email.replyTo).toBe('person@example.com')
  })

  it('uses Brevo authentication and request fields with the verified sender and fixed support recipient', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ messageId: '<brevo-id@example.test>' }), { status: 201 }))
    const result = await deliverFeedbackEmail(validateFeedbackSubmission(valid)!, { userId: 'user-1', email: 'person@example.com' }, {
      apiKey: 'server-only-key', from: 'feedback@verified.example', to: 'spraha.progresstracker@gmail.com', appVersion: '0.1.0',
    }, fetcher, new Date('2026-10-12T00:00:00Z'))
    expect(result.accepted).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('https://api.brevo.com/v3/smtp/email', expect.objectContaining({
      headers: expect.objectContaining({ 'api-key': 'server-only-key', 'Content-Type': 'application/json' }),
    }))
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)
    expect(body.sender).toEqual({ name: 'ProgressTracker Feedback', email: 'feedback@verified.example' })
    expect(body.to).toEqual([{ email: 'spraha.progresstracker@gmail.com' }])
    expect(body.replyTo).toEqual({ email: 'person@example.com' })
    expect(body.textContent).toContain('The page froze after saving.')
    expect(body.htmlContent).toContain('ProgressTracker feedback: Bug Report')
    expect(body).not.toHaveProperty('apiKey')
  })

  it('marks definitive provider rejection as safe to retry and recognizes Brevo rate limits', async () => {
    const input = validateFeedbackSubmission(valid)!
    const config = { apiKey: 'server-only-key', from: 'feedback@verified.example', to: 'spraha.progresstracker@gmail.com', appVersion: '0.1.0' }
    const reject = await deliverFeedbackEmail(input, { userId: 'user-1', email: null }, config, vi.fn<typeof fetch>().mockResolvedValue(new Response('bad sender', { status: 400 })))
    expect(reject).toEqual({ accepted: false, outcome: 'rejected', status: 400, retryable: false })
    const limited = await deliverFeedbackEmail(input, { userId: 'user-1', email: null }, config, vi.fn<typeof fetch>().mockResolvedValue(new Response('rate limited', { status: 429 })))
    expect(limited).toEqual({ accepted: false, outcome: 'rejected', status: 429, retryable: true })
  })

  it('marks network timeouts and server failures uncertain so automatic retries cannot duplicate email', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('Timeout', 'AbortError'))
    const result = await deliverFeedbackEmail(validateFeedbackSubmission(valid)!, { userId: 'user-1', email: null }, {
      apiKey: 'server-only-key', from: 'feedback@verified.example', to: 'spraha.progresstracker@gmail.com', appVersion: '0.1.0',
    }, fetcher)
    expect(result).toEqual({ accepted: false, outcome: 'uncertain', status: 503, retryable: false })
    expect((JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).textContent).toContain(valid.message.trim())
    const serverError = await deliverFeedbackEmail(validateFeedbackSubmission(valid)!, { userId: 'user-1', email: null }, {
      apiKey: 'server-only-key', from: 'feedback@verified.example', to: 'spraha.progresstracker@gmail.com', appVersion: '0.1.0',
    }, vi.fn<typeof fetch>().mockResolvedValue(new Response('temporary Brevo error', { status: 503 })))
    expect(serverError).toEqual({ accepted: false, outcome: 'uncertain', status: 503, retryable: false })
  })

  it('treats a successful HTTP response without a message ID as uncertain acceptance', async () => {
    const result = await deliverFeedbackEmail(validateFeedbackSubmission(valid)!, { userId: 'user-1', email: null }, {
      apiKey: 'server-only-key', from: 'feedback@verified.example', to: 'spraha.progresstracker@gmail.com', appVersion: '0.1.0',
    }, vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 201 })))
    expect(result).toEqual({ accepted: false, outcome: 'uncertain', status: 201, retryable: false })
  })
})
