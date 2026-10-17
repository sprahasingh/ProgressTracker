import { describe, expect, it } from 'vitest'
import { localCalendarDate } from '../shared/localDates'
import { calendarBadgeProgress } from './calendarBadgeProgress'

const noMonths = [] as const

describe('calendar badge progress', () => {
  it('counts only confirmed Perfect Days in the current Monday-to-Sunday week', () => {
    const progress = calendarBadgeProgress({
      achievementId: 'perfect-week', today: '2026-10-18',
      confirmedPerfectDayDates: new Set(['2026-10-11', '2026-10-12', '2026-10-15', '2026-10-19']),
      perfectMonthHistory: noMonths,
    })

    expect(progress).toMatchObject({ progress: 2, target: 7, label: '2 / 7 confirmed days' })
  })

  it.each([
    ['2026-04-18', 30],
    ['2026-10-18', 31],
    ['2028-02-15', 29],
  ])('uses the actual month length for %s', (today, target) => {
    const progress = calendarBadgeProgress({
      achievementId: 'perfect-month', today,
      confirmedPerfectDayDates: new Set([today, '2028-02-29']), perfectMonthHistory: noMonths,
    })

    expect(progress?.target).toBe(target)
    expect(progress?.label).toBe(`1 / ${target} confirmed days`)
  })

  it('uses the account calendar date at timezone boundaries', () => {
    const instant = new Date('2026-10-18T18:30:00.000Z')
    const utcDate = localCalendarDate(instant, 'UTC')
    const kolkataDate = localCalendarDate(instant, 'Asia/Kolkata')
    const confirmed = new Set(['2026-10-18'])

    expect(utcDate).toBe('2026-10-18')
    expect(kolkataDate).toBe('2026-10-19')
    expect(calendarBadgeProgress({ achievementId: 'perfect-week', today: utcDate, confirmedPerfectDayDates: confirmed, perfectMonthHistory: noMonths }))
      .toMatchObject({ label: '1 / 7 confirmed days' })
    expect(calendarBadgeProgress({ achievementId: 'perfect-week', today: kolkataDate, confirmedPerfectDayDates: confirmed, perfectMonthHistory: noMonths }))
      .toMatchObject({ label: '0 / 7 confirmed days' })
  })

  it('counts only distinct, active completed months before the current month for Perfect Year', () => {
    const history = [
      { id: 'jan', eventType: 'unlocked' as const, sourceDate: '2026-01-31', sourceReference: { month: '2026-01' }, reversesEventId: null },
      { id: 'feb', eventType: 'unlocked' as const, sourceDate: '2026-02-28', sourceReference: { month: '2026-02' }, reversesEventId: null },
      { id: 'feb-duplicate', eventType: 'unlocked' as const, sourceDate: '2026-02-28', sourceReference: { month: '2026-02' }, reversesEventId: null },
      { id: 'march-reversed', eventType: 'unlocked' as const, sourceDate: '2026-03-31', sourceReference: { month: '2026-03' }, reversesEventId: null },
      { id: 'reversal', eventType: 'revoked' as const, sourceDate: '2026-04-01', sourceReference: null, reversesEventId: 'march-reversed' },
      { id: 'current-month', eventType: 'unlocked' as const, sourceDate: '2026-10-31', sourceReference: { month: '2026-10' }, reversesEventId: null },
      { id: 'next-year', eventType: 'unlocked' as const, sourceDate: '2027-01-31', sourceReference: { month: '2027-01' }, reversesEventId: null },
    ]
    const progress = calendarBadgeProgress({
      achievementId: 'perfect-year', today: '2026-10-18', confirmedPerfectDayDates: new Set(['2026-10-02', '2026-10-18']),
      perfectMonthHistory: history,
    })

    expect(progress).toMatchObject({
      progress: 2,
      target: 12,
      label: '2 / 12 months',
      secondaryLabel: 'Current month: 2 / 31 confirmed days so far',
    })
  })

  it('shows confirmed partial progress and describes unavailable history without calling unknown dates failures', () => {
    const progress = calendarBadgeProgress({
      achievementId: 'perfect-week', today: '2026-10-18', confirmedPerfectDayDates: new Set(['2026-10-12', '2026-10-13']),
      perfectMonthHistory: noMonths, qualificationStatus: 'unavailable',
    })

    expect(progress?.label).toBe('2 / 7 confirmed days')
    expect(progress?.unavailableMessage).toMatch(/cannot be verified/)
    expect(progress?.unavailableMessage).toMatch(/not counted as failed/)
  })

  it('does not project current calendar progress for unrelated achievements', () => {
    expect(calendarBadgeProgress({
      achievementId: 'first-step', today: '2026-10-18', confirmedPerfectDayDates: new Set(), perfectMonthHistory: noMonths,
    })).toBeNull()
  })
})
