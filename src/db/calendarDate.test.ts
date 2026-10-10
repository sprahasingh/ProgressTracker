import { describe, expect, it } from 'vitest'
import { assertCalendarDate, assertDateRange, calendarDateInTimeZone, mondayFirstWeekday } from './calendarDate'

describe('calendar date validation', () => {
  it('accepts valid leap days and rejects impossible dates', () => {
    expect(() => assertCalendarDate('2024-02-29')).not.toThrow()
    expect(() => assertCalendarDate('2025-02-29')).toThrow('Invalid calendar date')
    expect(() => assertCalendarDate('2026-13-01')).toThrow('Invalid calendar date')
  })

  it('requires ordered date ranges', () => {
    expect(() => assertDateRange('2026-10-01', '2026-10-07')).not.toThrow()
    expect(() => assertDateRange('2026-10-08', '2026-10-07')).toThrow('start date')
  })

  it('maps Monday to the first weekday and Sunday to the last without local-time conversion', () => {
    expect(mondayFirstWeekday('2026-10-05')).toBe(0) // Monday
    expect(mondayFirstWeekday('2026-10-04')).toBe(6) // Sunday
    expect(mondayFirstWeekday('2024-02-29')).toBe(3) // Leap-year Thursday
    expect(mondayFirstWeekday('2025-01-01')).toBe(2) // Year-boundary Wednesday
  })

  it('derives creation dates in the configured zone across UTC midnight and daylight-saving transitions', () => {
    const nearUtcMidnight = '2026-10-01T18:30:00.000Z'
    expect(calendarDateInTimeZone(nearUtcMidnight, 'Asia/Kolkata')).toBe('2026-10-02')
    expect(calendarDateInTimeZone(nearUtcMidnight, 'America/Los_Angeles')).toBe('2026-10-01')
    expect(calendarDateInTimeZone(nearUtcMidnight, 'UTC')).toBe('2026-10-01')
    expect(calendarDateInTimeZone('2026-03-08T09:30:00.000Z', 'America/Los_Angeles')).toBe('2026-03-08')
    expect(calendarDateInTimeZone('2026-03-08T10:30:00.000Z', 'America/Los_Angeles')).toBe('2026-03-08')
  })
})
