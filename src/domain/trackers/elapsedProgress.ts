const dayMilliseconds = 86_400_000

type PlainDateParts = { year: number; month: number; day: number }

function utcTimestamp(year: number, month: number, day: number): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
}

function parseDate(value: string): PlainDateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(utcTimestamp(year, month, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return { year, month, day }
}

function monthLength(year: number, month: number): number {
  return new Date(utcTimestamp(year, month + 1, 0)).getUTCDate()
}

function addAnchoredMonths(start: PlainDateParts, months: number): number {
  const monthIndex = start.year * 12 + start.month - 1 + months
  const year = Math.floor(monthIndex / 12)
  const month = monthIndex % 12 + 1
  const day = Math.min(start.day, monthLength(year, month))
  return utcTimestamp(year, month, day)
}

/**
 * Formats elapsed calendar time as total months and remaining days.
 * Dates are account-local calendar dates, so UTC arithmetic avoids DST-length
 * days while the caller remains responsible for selecting the workspace date.
 */
export function formatElapsedMonthsAndDays(startDate: string, endDate: string): string | null {
  const start = parseDate(startDate)
  const end = parseDate(endDate)
  if (!start || !end) return null

  const startTime = utcTimestamp(start.year, start.month, start.day)
  const endTime = utcTimestamp(end.year, end.month, end.day)
  if (endTime < startTime) return null

  let months = (end.year - start.year) * 12 + end.month - start.month
  if (addAnchoredMonths(start, months) > endTime) months -= 1
  const dayTime = addAnchoredMonths(start, months)
  const days = Math.floor((endTime - dayTime) / dayMilliseconds)
  const parts: string[] = []
  if (months) parts.push(`${months} ${months === 1 ? 'month' : 'months'}`)
  if (days || parts.length === 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`)
  return parts.join(' ')
}
