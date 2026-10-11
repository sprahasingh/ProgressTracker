import { describe, expect, it } from 'vitest'
import { validateFeedbackExplanation } from './feedbackCore'

describe('AI Help feedback privacy validation', () => {
  it('accepts short optional text without retaining unrelated conversation content', () => {
    expect(validateFeedbackExplanation('The setting name was different.')).toEqual({ explanation: 'The setting name was different.', error: null })
    expect(validateFeedbackExplanation('   ')).toEqual({ explanation: null, error: null })
  })

  it('rejects overlong explanations, email addresses, passwords, and access tokens', () => {
    expect(validateFeedbackExplanation('x'.repeat(401)).error).toBe('too_long')
    expect(validateFeedbackExplanation('Contact me at person@example.com').error).toBe('sensitive_content')
    expect(validateFeedbackExplanation('password: secret123').error).toBe('sensitive_content')
    expect(validateFeedbackExplanation('Bearer abc123').error).toBe('sensitive_content')
    expect(validateFeedbackExplanation('eyJabcdefghijk.abcdefghijk').error).toBe('sensitive_content')
  })
})
