export type WeekRhythmState = 'holiday' | 'rest' | 'complete' | 'partial' | 'no-progress' | 'today' | 'pending' | 'missed'

/** Keep future opportunities pending; only elapsed, incomplete opportunities are missed. */
export function getWeekRhythmState(input: {
  isHoliday: boolean
  scheduled: number
  done: number
  hasPartial: boolean
  hasNoProgress?: boolean
  hasSkipped: boolean
  isToday: boolean
  isFuture: boolean
}): WeekRhythmState {
  if (input.isHoliday) return 'holiday'
  if (input.scheduled === 0) return 'rest'
  if (input.done === input.scheduled) return 'complete'
  if (input.done > 0 || input.hasPartial) return 'partial'
  if (input.hasNoProgress) return 'no-progress'
  if (input.hasSkipped) return input.isFuture ? 'pending' : 'missed'
  if (input.isToday) return 'today'
  return input.isFuture ? 'pending' : 'missed'
}
