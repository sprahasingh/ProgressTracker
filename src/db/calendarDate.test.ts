import { describe, expect, it } from 'vitest'
import { assertCalendarDate, assertDateRange } from './calendarDate'

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
})
