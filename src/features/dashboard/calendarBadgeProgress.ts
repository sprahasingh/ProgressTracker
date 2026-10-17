type MonthAwardEvent = {
  id: string
  eventType: 'unlocked' | 'revoked'
  sourceDate: string | null
  sourceReference?: Record<string, unknown> | null
  reversesEventId: string | null
}

export type CalendarBadgeProgress = {
  progress: number
  target: number
  label: string
  secondaryLabel?: string
  unavailableMessage?: string
}

function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Invalid calendar date: ${value}`)
  }
  return date
}

function shiftDate(value: string, days: number): string {
  const date = parseDate(value)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function activeMonthKeys(events: readonly MonthAwardEvent[]): Set<string> {
  const revokedIds = new Set(events.filter((event) => event.eventType === 'revoked' && event.reversesEventId).map((event) => event.reversesEventId))
  const uniqueActive = new Map(events
    .filter((event) => event.eventType === 'unlocked' && !revokedIds.has(event.id))
    .map((event) => [event.id, event]))

  return new Set([...uniqueActive.values()].flatMap((event) => {
    const referenceMonth = event.sourceReference?.month
    const month = typeof referenceMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(referenceMonth)
      ? referenceMonth
      : event.sourceDate?.slice(0, 7)
    return month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? [month] : []
  }))
}

/** Builds display-only progress from confirmed Perfect Day dates and active Perfect Month awards. */
export function calendarBadgeProgress(input: {
  achievementId: string
  today: string
  confirmedPerfectDayDates: ReadonlySet<string>
  perfectMonthHistory: readonly MonthAwardEvent[]
  qualificationStatus?: string
}): CalendarBadgeProgress | null {
  if (!['perfect-week', 'perfect-month', 'perfect-year'].includes(input.achievementId)) return null
  const today = parseDate(input.today)
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth() + 1
  const currentMonth = `${year}-${String(month).padStart(2, '0')}`
  const confirmedInRange = (start: string, end: string) => [...input.confirmedPerfectDayDates]
    .filter((date) => date >= start && date <= end && date <= input.today).length

  const unavailableMessage = ['unavailable', 'waiting'].includes(input.qualificationStatus ?? '')
    ? 'Some dates cannot be verified from available schedule history. They are not counted as failed.'
    : undefined

  if (input.achievementId === 'perfect-week') {
    const mondayOffset = (today.getUTCDay() + 6) % 7
    const start = shiftDate(input.today, -mondayOffset)
    const progress = confirmedInRange(start, shiftDate(start, 6))
    return { progress, target: 7, label: `${progress} / 7 confirmed days`, unavailableMessage }
  }

  const monthStart = `${currentMonth}-01`
  const monthEnd = `${currentMonth}-${String(daysInMonth(year, month)).padStart(2, '0')}`
  const currentMonthDays = confirmedInRange(monthStart, monthEnd)

  if (input.achievementId === 'perfect-month') {
    const target = daysInMonth(year, month)
    return { progress: currentMonthDays, target, label: `${currentMonthDays} / ${target} confirmed days`, unavailableMessage }
  }

  const completedMonths = [...activeMonthKeys(input.perfectMonthHistory)]
    .filter((key) => key.startsWith(`${year}-`) && key < currentMonth).length
  const completedMonthProgress = Math.min(12, completedMonths)
  return {
    progress: completedMonthProgress,
    target: 12,
    label: `${completedMonthProgress} / 12 months`,
    secondaryLabel: `Current month: ${currentMonthDays} / ${daysInMonth(year, month)} confirmed days so far`,
    unavailableMessage,
  }
}
