import { describe, expect, it } from 'vitest'
import { getWeekRhythmState } from './weekRhythm'

const futureOpportunity = { isHoliday: false, scheduled: 2, done: 0, hasPartial: false, hasSkipped: false, isToday: false, isFuture: true }

describe('week rhythm day state', () => {
  it('labels a future required date upcoming instead of pending or missed', () => {
    expect(getWeekRhythmState(futureOpportunity)).toBe('upcoming')
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
    expect(getWeekRhythmState({ ...futureOpportunity, hasNoProgress: true, isToday: true, isFuture: false })).toBe('no-progress')
  })

  it('keeps an explicit skip distinct from a derived miss', () => {
    expect(getWeekRhythmState({ ...futureOpportunity, hasSkipped: true })).toBe('skipped')
    expect(getWeekRhythmState({ ...futureOpportunity, hasSkipped: true, isFuture: false })).toBe('skipped')
    expect(getWeekRhythmState({ ...futureOpportunity, hasSkipped: true, isToday: true, isFuture: false })).toBe('skipped')
  })
})
