export type CalendarBadgeStatus = 'in_progress' | 'failed' | 'unavailable' | 'waiting' | 'earned'

export type CalendarBadgeProgress = {
  status: CalendarBadgeStatus
  progress: number | null
  target: number
  label: string
  message?: string
  periodStart?: string
  periodEnd?: string
  pendingReconciliation?: boolean
  pendingMessage?: string
}

type QualificationDetails = {
  status?: string
  progress?: number
  target?: number
  message?: string
  period_start?: string
  period_end?: string
  pending_reconciliation?: boolean
  pending_dates?: number
  pending_message?: string | null
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function daysInYear(year: number): number {
  return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000
}

function fallbackTarget(achievementId: string, today: string): number {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  if (achievementId === 'perfect-week') return 7
  if (achievementId === 'perfect-month') return daysInMonth(year, month)
  return daysInYear(year)
}

/** Uses the server's date-effective qualification result; clients never infer an award. */
export function calendarBadgeProgress(input: {
  achievementId: string
  today: string
  qualificationDetails?: QualificationDetails
}): CalendarBadgeProgress | null {
  if (!['perfect-week', 'perfect-month', 'perfect-year'].includes(input.achievementId)) return null

  const details = input.qualificationDetails
  const target = Number.isFinite(details?.target) && details!.target! > 0
    ? Math.floor(details!.target!)
    : fallbackTarget(input.achievementId, input.today)
  const rawStatus = details?.status === 'qualified' ? 'earned' : details?.status
  const status = ['in_progress', 'failed', 'unavailable', 'waiting', 'earned'].includes(rawStatus ?? '')
    ? rawStatus as CalendarBadgeStatus
    : 'unavailable'
  const progress = status === 'unavailable' || status === 'waiting'
    ? null
    : Number.isFinite(details?.progress)
      ? Math.min(target, Math.max(0, Math.floor(details!.progress!)))
      : null
  const label = progress === null
    ? status === 'waiting' ? 'Waiting for confirmation' : 'Progress unavailable'
    : `${progress} / ${target} confirmed days`

  return {
    status,
    progress,
    target,
    label,
    message: details?.message,
    periodStart: details?.period_start,
    periodEnd: details?.period_end,
    pendingReconciliation: details?.pending_reconciliation === true,
    pendingMessage: details?.pending_message ?? undefined,
  }
}
