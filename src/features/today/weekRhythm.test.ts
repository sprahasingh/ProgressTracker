import { describe, expect, it } from 'vitest'
import { getWeekRhythmState } from './weekRhythm'

const futureOpportunity = { isHoliday: false, scheduled: 2, done: 0, hasPartial: false, hasSkipped: false, isToday: false, isFuture: true }

describe('week rhythm day state', () => {
  it('keeps an upcoming scheduled day pending instead of missed', () => {
    expect(getWeekRhythmState(futureOpportunity)).toBe('pending')
  })

  it('marks only an elapsed incomplete opportunity as missed', () => {
    expect(getWeekRhythmState({ ...futureOpportunity, isFuture: false })).toBe('missed')
    expect(getWeekRhythmState({ ...futureOpportunity, isToday: true, isFuture: false })).toBe('today')
  })

  it('preserves rest, holiday, and completion precedence', () => {
    expect(getWeekRhythmState({ ...futureOpportunity, isHoliday: true })).toBe('holiday')
    expect(getWeekRhythmState({ ...futureOpportunity, scheduled: 0 })).toBe('rest')
    expect(getWeekRhythmState({ ...futureOpportunity, done: 2 })).toBe('complete')
    expect(getWeekRhythmState({ ...futureOpportunity, done: 1 })).toBe('partial')
  })
})
