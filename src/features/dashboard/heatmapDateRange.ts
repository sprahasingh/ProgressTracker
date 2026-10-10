import type { CalendarDate } from '../../db/models'
import { assertCalendarDate } from '../../db/calendarDate'

export type HeatmapRangeSelection = 'auto' | 'last3Months' | 'last6Months' | 'last12Months' | 'year'
export type HeatmapDateRangeOption = Exclude<HeatmapRangeSelection, 'auto'>

/** Rolling ranges include today and begin on the same day N calendar months earlier (clamped at month end). */
export function subtractCalendarMonths(value: CalendarDate, months: number): CalendarDate {
  const [year, month, day] = value.split('-').map(Number)
  const targetMonthIndex = year! * 12 + month! - 1 - months
  const targetYear = Math.floor(targetMonthIndex / 12)
  const targetMonth = targetMonthIndex % 12 + 1
  const finalDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()
  const result = `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day!, finalDay)).padStart(2, '0')}`
  assertCalendarDate(result)
  return result as CalendarDate
}

export function heatmapDateRange(today: CalendarDate, selection: HeatmapDateRangeOption, year?: number): { startDate: CalendarDate; endDate: CalendarDate } {
  if (selection === 'year') {
    const selectedYear = year ?? Number(today.slice(0, 4))
    return {
      startDate: `${selectedYear}-01-01` as CalendarDate,
      endDate: selectedYear === Number(today.slice(0, 4)) ? today : `${selectedYear}-12-31` as CalendarDate,
    }
  }
  const months = selection === 'last3Months' ? 3 : selection === 'last6Months' ? 6 : 12
  return { startDate: subtractCalendarMonths(today, months), endDate: today }
}

export function availableHeatmapYears(trackers: readonly { startDate?: string | null; createdAt: string }[], today: CalendarDate): number[] {
  const currentYear = Number(today.slice(0, 4))
  const earliest = trackers.reduce<CalendarDate>((date, tracker) => {
    const created = (tracker.startDate ?? tracker.createdAt.slice(0, 10)) as CalendarDate
    return created < date ? created : date
  }, today)
  return Array.from({ length: currentYear - Number(earliest.slice(0, 4)) + 1 }, (_, index) => currentYear - index)
}

export function isHistoricalHeatmapYear(year: number, today: CalendarDate): boolean {
  return year < Number(today.slice(0, 4))
}
