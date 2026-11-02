import { describe, expect, it } from 'vitest'
import { calendarBadgeProgress } from './calendarBadgeProgress'

describe('server-authoritative calendar badge progress', () => {
  it.each([
    ['perfect-week', '2026-10-18', 2, 7],
    ['perfect-month', '2026-10-18', 12, 31],
    ['perfect-year', '2026-10-18', 290, 365],
  ] as const)('uses the server progress and target for %s', (achievementId, today, progress, target) => {
    expect(calendarBadgeProgress({
      achievementId,
      today,
      qualificationDetails: { status: 'in_progress', progress, target },
    })).toMatchObject({
      status: 'in_progress', progress, target, label: `${progress} / ${target} confirmed days`,
    })
  })

  it('uses 366 server-confirmed dates for an eligible leap year', () => {
    expect(calendarBadgeProgress({
      achievementId: 'perfect-year', today: '2028-02-29',
      qualificationDetails: { status: 'in_progress', progress: 60, target: 366 },
    })).toMatchObject({ target: 366, label: '60 / 366 confirmed days' })
  })

  it('does not display unavailable qualification as zero progress', () => {
    expect(calendarBadgeProgress({
      achievementId: 'perfect-week', today: '2026-11-01',
      qualificationDetails: { status: 'unavailable', progress: 0, target: 7, message: 'History boundary.' },
    })).toMatchObject({ status: 'unavailable', progress: null, target: 7, label: 'Progress unavailable', message: 'History boundary.' })
  })

  it('keeps confirmed progress visible while separately reporting queued historical verification', () => {
    expect(calendarBadgeProgress({
      achievementId: 'perfect-year', today: '2026-11-01',
      qualificationDetails: {
        status: 'in_progress', progress: 18, target: 365,
        pending_reconciliation: true, pending_dates: 240,
        pending_message: 'Historical dates are queued for server verification.',
      },
    })).toMatchObject({
      status: 'in_progress', progress: 18, target: 365,
      pendingReconciliation: true,
      pendingMessage: 'Historical dates are queued for server verification.',
    })
  })

  it('distinguishes a failed period from an active period while preserving confirmed days', () => {
    expect(calendarBadgeProgress({
      achievementId: 'perfect-month', today: '2026-11-14',
      qualificationDetails: { status: 'failed', progress: 4, target: 30 },
    })).toMatchObject({ status: 'failed', progress: 4, label: '4 / 30 confirmed days' })
  })

  it('distinguishes an earned completed period from an active period', () => {
    expect(calendarBadgeProgress({
      achievementId: 'perfect-week', today: '2026-11-08',
      qualificationDetails: { status: 'earned', progress: 7, target: 7 },
    })).toMatchObject({ status: 'earned', progress: 7, label: '7 / 7 confirmed days' })
  })

  it('keeps the previous server qualified status readable during rollout', () => {
    expect(calendarBadgeProgress({
      achievementId: 'perfect-month', today: '2026-10-31',
      qualificationDetails: { status: 'qualified', progress: 31, target: 31 },
    })).toMatchObject({ status: 'earned', progress: 31 })
  })

  it('uses period-specific calendar targets only as a fallback when details are unavailable', () => {
    expect(calendarBadgeProgress({ achievementId: 'perfect-month', today: '2028-02-29' }))
      .toMatchObject({ status: 'unavailable', progress: null, target: 29 })
    expect(calendarBadgeProgress({ achievementId: 'perfect-year', today: '2028-02-29' }))
      .toMatchObject({ status: 'unavailable', progress: null, target: 366 })
    expect(calendarBadgeProgress({ achievementId: 'perfect-year', today: '2027-06-01' }))
      .toMatchObject({ target: 365 })
  })

  it('returns no calendar progress for unrelated achievements', () => {
    expect(calendarBadgeProgress({ achievementId: 'first-step', today: '2026-10-18' })).toBeNull()
  })
})
