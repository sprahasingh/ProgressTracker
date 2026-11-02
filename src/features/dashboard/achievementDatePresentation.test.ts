import { describe, expect, it } from 'vitest'
import { formatAchievementTimestamp, presentAchievementDate, qualifyingAchievementDate } from './achievementDatePresentation'

const recordedAt = '2026-11-01T09:52:00.000Z'

describe('achievement date presentation', () => {
  it('uses the Perfect Day source date while preserving a later server confirmation', () => {
    const result = presentAchievementDate({ achievementId: 'perfect-day', sourceDate: '2026-10-31', sourceReference: {}, recordedAt })
    expect(result).toMatchObject({ date: '2026-10-31', label: 'Qualifying date', recordedAt, recordedAtLabel: 'Server confirmed' })
  })

  it('uses Sunday as the Perfect Week date from a valid Monday period key', () => {
    expect(qualifyingAchievementDate({ achievementId: 'perfect-week', sourceDate: '2026-11-01', sourceReference: { week: '2026-10-26' } }))
      .toEqual({ date: '2026-11-01', label: 'Qualifying week ended' })
  })

  it('uses the final day of the month including leap February', () => {
    expect(qualifyingAchievementDate({ achievementId: 'perfect-month', sourceDate: null, sourceReference: { month: '2024-02' } }))
      .toEqual({ date: '2024-02-29', label: 'Qualifying month ended' })
    expect(qualifyingAchievementDate({ achievementId: 'perfect-month', sourceDate: '2024-02-28', sourceReference: null })).toBeNull()
  })

  it('uses December 31 for Perfect Year and handles leap years without shifting the calendar date', () => {
    expect(qualifyingAchievementDate({ achievementId: 'perfect-year', sourceDate: '2024-12-31', sourceReference: { year: 2024 } }))
      .toEqual({ date: '2024-12-31', label: 'Qualifying year ended' })
  })

  it('uses workspace timezone for confirmation timestamps near a date boundary', () => {
    const result = presentAchievementDate({ achievementId: 'perfect-day', sourceDate: '2026-10-31', sourceReference: null, recordedAt: '2026-11-01T00:30:00.000Z' })
    expect(result.date).toBe('2026-10-31')
    expect(formatAchievementTimestamp(result.recordedAt, 'Asia/Kolkata')).not.toBe(formatAchievementTimestamp(result.recordedAt, 'America/Los_Angeles'))
  })

  it('does not invent a period date for legacy events without a reliable period reference', () => {
    const result = presentAchievementDate({ achievementId: 'perfect-week', sourceDate: '2026-10-31', sourceReference: {}, recordedAt })
    expect(result).toMatchObject({ date: null, label: 'Award recorded', recordedAtLabel: 'Award recorded' })
    expect(formatAchievementTimestamp(result.recordedAt, 'Asia/Kolkata')).toBeTruthy()
  })

  it('retains ordinary achievement source dates when available', () => {
    expect(qualifyingAchievementDate({ achievementId: 'first-step', sourceDate: '2026-10-31', sourceReference: null }))
      .toEqual({ date: '2026-10-31', label: 'Achievement date' })
  })
})
