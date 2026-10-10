import { describe, expect, it } from 'vitest'
import { chooseMotivation } from './motivation'

describe('motivational message selection', () => {
  it('does not fall back from Custom Only when no enabled custom messages exist', () => {
    expect(chooseMotivation({ mode: 'custom', customMessages: [], recentMessages: [], sequence: 0 })).toBeNull()
  })
  it('avoids immediate repeats and alternates fairly in Both mode', () => {
    const first = chooseMotivation({ mode: 'both', customMessages: ['You can do this.'], recentMessages: [], sequence: 0 })
    expect(first?.source).toBe('general')
    const second = chooseMotivation({ mode: 'both', customMessages: ['You can do this.'], recentMessages: [first!.message], sequence: 0, lastSource: first!.source })
    expect(second).toEqual({ source: 'custom', message: 'You can do this.' })
    expect(chooseMotivation({ mode: 'general', customMessages: ['unused'], recentMessages: [], sequence: 0 })?.source).toBe('general')
  })
})
