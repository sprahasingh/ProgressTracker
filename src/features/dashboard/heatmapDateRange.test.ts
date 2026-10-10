import { describe, expect, it } from 'vitest'
import { availableHeatmapYears, heatmapDateRange, subtractCalendarMonths } from './heatmapDateRange'
import type { CalendarDate } from '../../db/models'

describe('heatmap date ranges', () => {
  it('subtracts calendar months and clamps month-end dates, including leap years', () => {
    expect(subtractCalendarMonths('2026-10-31' as CalendarDate, 3)).toBe('2026-07-31')
    expect(subtractCalendarMonths('2026-10-31' as CalendarDate, 6)).toBe('2026-04-30')
    expect(subtractCalendarMonths('2024-08-31' as CalendarDate, 6)).toBe('2024-02-29')
    expect(subtractCalendarMonths('2026-01-31' as CalendarDate, 3)).toBe('2025-10-31')
  })

  it('includes today in rolling ranges and truncates the current year at today', () => {
    expect(heatmapDateRange('2026-10-10' as CalendarDate, 'last3Months')).toEqual({ startDate: '2026-07-10', endDate: '2026-10-10' })
    expect(heatmapDateRange('2026-10-10' as CalendarDate, 'year', 2026)).toEqual({ startDate: '2026-01-01', endDate: '2026-10-10' })
    expect(heatmapDateRange('2026-10-10' as CalendarDate, 'year', 2025)).toEqual({ startDate: '2025-01-01', endDate: '2025-12-31' })
  })

  it('offers tracker-history years through the current year, newest first', () => {
    expect(availableHeatmapYears([{ startDate: '2023-06-01' as CalendarDate, createdAt: '2023-05-01T00:00:00Z' }], '2026-10-10' as CalendarDate)).toEqual([2026, 2025, 2024, 2023])
    expect(availableHeatmapYears([], '2026-10-10' as CalendarDate)).toEqual([2026])
  })
})
