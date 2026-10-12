import { describe, expect, it } from 'vitest'
import { AssistantInputError, findVerifiedAnswer, isGeneralConversation, normalizeAssistantInput, shouldFailoverToSecondary } from './validation'

describe('AI Help Edge Function validation', () => {
  it('bounds text and history while allowing only safe page context values', () => {
    const input = normalizeAssistantInput({
      question: '  How do goals work?  ', pageContext: 'goals',
      history: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(3000) })),
    })
    expect(input.question).toBe('How do goals work?')
    expect(input.pageContext).toBe('goals')
    expect(input.history).toHaveLength(6)
    expect(input.history[0].content).toHaveLength(2000)
    expect(normalizeAssistantInput({ question: 'Hello', pageContext: '/trackers' }).pageContext).toBe('other')
  })

  it('rejects invalid or oversized questions and unexpected fields', () => {
    expect(() => normalizeAssistantInput({ question: '  ' })).toThrow(AssistantInputError)
    expect(() => normalizeAssistantInput({ question: 'x'.repeat(1501) })).toThrow(AssistantInputError)
    expect(() => normalizeAssistantInput({ question: 'Help', trackerData: {} })).toThrow(AssistantInputError)
  })

  it('accepts only bounded runtime availability observations', () => {
    expect(normalizeAssistantInput({ question: 'Can I restore it?', runtimeAvailability: { 'bin.restore': 'available', 'bin.permanent_delete': 'disabled', unknown: 'enabled', 'bad id': 'available' } }).runtimeAvailability)
      .toEqual({ 'bin.restore': 'available', 'bin.permanent_delete': 'disabled' })
  })

  it('accepts the optional capability version for new clients and remains compatible with older clients', () => {
    expect(normalizeAssistantInput({ question: 'Can I delete my account?', capabilityVersion: '0.1.0+abc123', runtimeAvailability: { 'account.delete': 'available' } })).toMatchObject({ capabilityVersion: '0.1.0+abc123', runtimeAvailability: { 'account.delete': 'available' } })
    expect(normalizeAssistantInput({ question: 'Can I delete my account?', runtimeAvailability: { 'account.delete': 'available' } })).toMatchObject({ runtimeAvailability: { 'account.delete': 'available' } })
    expect(normalizeAssistantInput({ question: 'Can I delete my account?', capabilityVersion: '../../unsafe' })).not.toHaveProperty('capabilityVersion')
  })

  it('never fails over on a provider 429 and allows only bounded transient failover', () => {
    expect(shouldFailoverToSecondary(429)).toBe(false)
    expect(shouldFailoverToSecondary(401)).toBe(true)
    expect(shouldFailoverToSecondary(503)).toBe(true)
    expect(shouldFailoverToSecondary(0)).toBe(true)
    expect(shouldFailoverToSecondary(400)).toBe(false)
  })

  it('uses exact normalized matches from reviewed question memory and rejects broad overlap', () => {
    const memory = [{ question: 'How are streaks calculated?', answer: 'Streaks count scheduled days.' }]
    expect(findVerifiedAnswer('How are streaks calculated?', memory)?.answer).toContain('scheduled days')
    expect(findVerifiedAnswer('How are streaks calculated', memory)?.answer).toContain('scheduled days')
    expect(findVerifiedAnswer('Tell me about private tracker data', memory)).toBeNull()
    expect(findVerifiedAnswer('Do measures only have two types?', [{ question: 'What are measures?', answer: 'A measure records a value.' }])).toBeNull()
    expect(findVerifiedAnswer('Are there only two types?', memory, [{ role: 'user', content: 'What are measures?' }])).toBeNull()
    expect(findVerifiedAnswer('How are streaks calculated?', memory, [{ role: 'user', content: 'Is Sunday a rest day?' }])).toBeNull()
  })

  it('queues only general explanations and excludes personal or context-specific questions', () => {
    expect(isGeneralConversation('How are streaks calculated?', [])).toBe(true)
    expect(isGeneralConversation('How many pages did I log?', [])).toBe(false)
    expect(isGeneralConversation('What about that?', [{ role: 'user', content: 'I recorded 12 pages yesterday.' }])).toBe(false)
  })
})
