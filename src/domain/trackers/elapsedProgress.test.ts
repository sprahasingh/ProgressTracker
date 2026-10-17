import { describe, expect, it } from 'vitest'
import { formatElapsedMonthsAndDays } from './elapsedProgress'
import { localCalendarDate } from '../../features/shared/localDates'

describe('calendar elapsed progress', () => {
  it('formats complete months with their remaining calendar days', () => {
    expect(formatElapsedMonthsAndDays('2026-01-01', '2026-09-13')).toBe('8 months 12 days')
    expect(formatElapsedMonthsAndDays('2026-01-01', '2027-02-01')).toBe('13 months')
    expect(formatElapsedMonthsAndDays('2026-01-01', '2026-01-12')).toBe('11 days')
  })

  it('uses month lengths and leap days rather than fixed month or year estimates', () => {
    expect(formatElapsedMonthsAndDays('2024-01-31', '2024-02-29')).toBe('1 month')
    expect(formatElapsedMonthsAndDays('2024-02-29', '2025-02-28')).toBe('12 months')
    expect(formatElapsedMonthsAndDays('2025-02-28', '2025-03-31')).toBe('1 month 3 days')
  })

  it('keeps date-only elapsed math stable across short, zero, and invalid periods', () => {
    expect(formatElapsedMonthsAndDays('2026-03-07', '2026-03-08')).toBe('1 day')
    expect(formatElapsedMonthsAndDays('2026-03-01', '2026-03-22')).toBe('21 days')
    expect(formatElapsedMonthsAndDays('2026-03-08', '2026-03-08')).toBe('0 days')
    expect(formatElapsedMonthsAndDays('2026-03-09', '2026-03-08')).toBeNull()
    expect(formatElapsedMonthsAndDays('not-a-date', '2026-03-08')).toBeNull()
  })

  it('uses account-local dates across a daylight-saving boundary', () => {
    const instant = new Date('2026-03-08T07:30:00.000Z')
    const losAngelesDate = localCalendarDate(instant, 'America/Los_Angeles')
    const newYorkDate = localCalendarDate(instant, 'America/New_York')
    expect(losAngelesDate).toBe('2026-03-07')
    expect(newYorkDate).toBe('2026-03-08')
    expect(formatElapsedMonthsAndDays('2026-03-01', losAngelesDate)).toBe('6 days')
    expect(formatElapsedMonthsAndDays('2026-03-01', newYorkDate)).toBe('7 days')
  })
})
