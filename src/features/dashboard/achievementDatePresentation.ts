import type { AchievementHistoryEvent } from '../../services/supabase/progressionRepository'

type AchievementDateEvent = Pick<AchievementHistoryEvent, 'achievementId' | 'sourceDate' | 'sourceReference' | 'recordedAt'>

export type AchievementDatePresentation = {
  date: string | null
  label: string
  recordedAt: string
  recordedAtLabel: string
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number(value.slice(0, 4)) > 0 && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function weekEnd(value: unknown): string | null {
  if (!isCalendarDate(value)) return null
  const start = new Date(`${value}T00:00:00.000Z`)
  if (start.getUTCDay() !== 1) return null
  start.setUTCDate(start.getUTCDate() + 6)
  return start.toISOString().slice(0, 10)
}

function monthEnd(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return null
  const [year, month] = value.split('-').map(Number)
  if (!year || month === undefined || month < 1 || month > 12) return null
  const lastDay = new Date(0)
  lastDay.setUTCHours(0, 0, 0, 0)
  lastDay.setUTCFullYear(year, month, 0)
  return lastDay.toISOString().slice(0, 10)
}

function yearEnd(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 9999) return null
  return `${String(value).padStart(4, '0')}-12-31`
}

export function qualifyingAchievementDate(event: Pick<AchievementDateEvent, 'achievementId' | 'sourceDate' | 'sourceReference'>): { date: string; label: string } | null {
  const reference = event.sourceReference ?? {}
  switch (event.achievementId) {
    case 'perfect-day':
      return isCalendarDate(event.sourceDate) ? { date: event.sourceDate, label: 'Qualifying date' } : null
    case 'perfect-week': {
      const date = weekEnd(reference.week)
      return date ? { date, label: 'Qualifying week ended' } : null
    }
    case 'perfect-month': {
      const date = monthEnd(reference.month)
      return date ? { date, label: 'Qualifying month ended' } : null
    }
    case 'perfect-year': {
      const date = yearEnd(reference.year)
      return date ? { date, label: 'Qualifying year ended' } : null
    }
    default:
      return isCalendarDate(event.sourceDate) ? { date: event.sourceDate, label: 'Achievement date' } : null
  }
}

export function presentAchievementDate(event: AchievementDateEvent): AchievementDatePresentation {
  const qualifying = qualifyingAchievementDate(event)
  return {
    date: qualifying?.date ?? null,
    label: qualifying?.label ?? 'Award recorded',
    recordedAt: event.recordedAt,
    recordedAtLabel: qualifying ? 'Server confirmed' : 'Award recorded',
  }
}

export function formatAchievementCalendarDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T12:00:00.000Z`))
}

export function formatAchievementTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value))
}
