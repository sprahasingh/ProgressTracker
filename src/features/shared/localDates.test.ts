import { describe, expect, it } from 'vitest'
import { localCalendarDate, shiftCalendarDate } from './localDates'

describe('workspace calendar dates', () => {
  it('uses the configured timezone on opposite sides of midnight', () => {
    const instant = new Date('2027-01-01T00:30:00.000Z')
    expect(localCalendarDate(instant, 'UTC')).toBe('2027-01-01')
    expect(localCalendarDate(instant, 'America/Los_Angeles')).toBe('2026-12-31')
    expect(localCalendarDate(instant, 'Asia/Kolkata')).toBe('2027-01-01')
  })

  it('shifts dates over month, leap-day, and year boundaries without timezone drift', () => {
    expect(shiftCalendarDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftCalendarDate('2028-02-28', 1)).toBe('2028-02-29')
    expect(shiftCalendarDate('2028-02-29', 1)).toBe('2028-03-01')
    expect(shiftCalendarDate('2027-01-01', -1)).toBe('2026-12-31')
  })
})
