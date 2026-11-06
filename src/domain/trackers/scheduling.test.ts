import { describe, expect, it } from 'vitest'
import { deriveSchedulingDeadline, effectiveDayNumber, effectiveDaysRemaining, isEffectiveDateEligible, nthEffectiveDate, trackerScheduling } from './scheduling'
import type { TrackerDefinition } from './types'
import { versionTrackerRuleChange } from './ruleVersions'

const tracker = (schedule: TrackerDefinition['schedule']): TrackerDefinition => ({
  schemaVersion: 1, id: 'schedule-test', name: 'Study', description: '', kind: 'challenge', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule, startDate: '2026-10-15', metrics: [], customFields: [], milestones: [],
  createdAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:00:00.000Z', archivedAt: null, deletedAt: null,
})

describe('unified scheduling calculations', () => {
  it('keeps legacy deadline trackers calendar bound and deadline free trackers ongoing', () => {
    expect(trackerScheduling({ deadline: '2026-10-31' }).mode).toBe('calendar')
    expect(trackerScheduling({}).mode).toBe('ongoing')
  })

  it('counts every calendar date regardless of recurrence, excluding only marked holidays', () => {
    const weekdays = tracker({ kind: 'weekdays' })
    const holidays = new Set(['2026-10-15', '2026-10-19'])
    expect(nthEffectiveDate({ tracker: weekdays, startDate: '2026-10-15', effectiveDays: 3, holidays, timeZone: 'America/New_York' })).toBe('2026-10-18')
    expect(effectiveDayNumber({ tracker: weekdays, date: '2026-10-20', holidays })).toBe(4)
    expect(effectiveDayNumber({ tracker: weekdays, date: '2026-10-16', holidays })).toBe(1)
    expect(effectiveDaysRemaining({ tracker: weekdays, date: '2026-10-19', targetEffectiveDays: 3, holidays })).toBe(0)
    expect(isEffectiveDateEligible(weekdays, '2026-10-15', holidays)).toBe(false)
    expect(isEffectiveDateEligible(weekdays, '2026-10-17', holidays)).toBe(true)
    expect(isEffectiveDateEligible(weekdays, '2026-10-18', holidays)).toBe(true)
  })

  it('counts missed dates while a skipped or missing check-in has no scheduling effect', () => {
    const daily = tracker({ kind: 'every-day' })
    expect(nthEffectiveDate({ tracker: daily, startDate: '2026-10-15', effectiveDays: 3, holidays: new Set() })).toBe('2026-10-17')
    expect(effectiveDayNumber({ tracker: daily, date: '2026-10-16', holidays: new Set() })).toBe(2)
  })

  it('honors leap day and counts dates even when recurrence is none', () => {
    const once = tracker({ kind: 'once', date: '2028-02-29' })
    expect(nthEffectiveDate({ tracker: once, startDate: '2028-02-28', effectiveDays: 1 })).toBe('2028-02-28')
    expect(nthEffectiveDate({ tracker: tracker({ kind: 'none' }), startDate: '2026-10-15', effectiveDays: 1 })).toBe('2026-10-15')
  })

  it('uses November calendar dates and recalculates in both directions when holidays change', () => {
    const daily = tracker({ kind: 'every-day' })
    const holidays = new Set(['2026-11-08', '2026-11-15'])
    const november = { ...daily, startDate: '2026-11-01' }
    expect(nthEffectiveDate({ tracker: daily, startDate: '2026-11-01', effectiveDays: 30 })).toBe('2026-11-30')
    expect(nthEffectiveDate({ tracker: daily, startDate: '2026-11-01', effectiveDays: 30, holidays })).toBe('2026-12-02')
    expect(nthEffectiveDate({ tracker: daily, startDate: '2026-11-01', effectiveDays: 30, holidays: new Set() })).toBe('2026-11-30')
    expect(effectiveDayNumber({ tracker: november, date: '2026-11-07' })).toBe(7)
    expect(effectiveDayNumber({ tracker: november, date: '2026-11-08', holidays })).toBeNull()
    expect(effectiveDayNumber({ tracker: november, date: '2026-11-09', holidays })).toBe(8)
    // November 11 is a public holiday in some places; it counts unless the user marks it.
    expect(effectiveDayNumber({ tracker: november, date: '2026-11-11' })).toBe(11)
  })


  it('counts only recurrence-matching activity days when selected, with holidays extending the deadline', () => {
    const weekdays = { ...tracker({ kind: 'weekdays' }), startDate: '2026-11-01', scheduling: { mode: 'effective' as const, effectiveDays: 30, effectiveDayCounting: 'planned-activity-days' as const } }
    expect(nthEffectiveDate({ tracker: weekdays, startDate: '2026-11-01', effectiveDays: 30 })).toBe('2026-12-11')
    expect(nthEffectiveDate({ tracker: { ...weekdays, schedule: { kind: 'selected-weekdays', weekdays: [6] } }, startDate: '2026-11-01', effectiveDays: 5 })).toBe('2026-12-05')
    expect(nthEffectiveDate({ tracker: weekdays, startDate: '2026-11-01', effectiveDays: 30, holidays: new Set(['2026-11-02', '2026-11-03']) })).toBe('2026-12-15')
    expect(isEffectiveDateEligible(weekdays, '2026-11-07')).toBe(false)
    expect(isEffectiveDateEligible({ ...weekdays, scheduling: { ...weekdays.scheduling!, effectiveDayCounting: 'all-non-holiday-days' } }, '2026-11-07')).toBe(true)
  })

  it('uses remaining specific dates after holidays and bounds finite once schedules with no eligible date', () => {
    const selectedDates = {
      ...tracker({ kind: 'specific-dates', dates: ['2026-10-15', '2026-10-16', '2026-10-18'] }),
      scheduling: { mode: 'effective' as const, effectiveDays: 2, effectiveDayCounting: 'planned-activity-days' as const },
    }
    expect(nthEffectiveDate({ tracker: selectedDates, startDate: '2026-10-15', effectiveDays: 2, holidays: new Set(['2026-10-15']) })).toBe('2026-10-18')

    const once = {
      ...tracker({ kind: 'once', date: '2026-10-15' }),
      scheduling: { mode: 'effective' as const, effectiveDays: 1, effectiveDayCounting: 'planned-activity-days' as const },
    }
    expect(() => nthEffectiveDate({ tracker: once, startDate: '2026-10-15', effectiveDays: 1, holidays: new Set(['2026-10-15']), maxSearchDays: 5 }))
      .toThrow(/Could not find 1 eligible days within 5 calendar days/)
  })

  it('exhausts finite schedules at their candidate dates under the default production search limit', () => {
    class CountingHolidays extends Set<string> {
      evaluations = 0
      override has(value: string): boolean { this.evaluations += 1; return super.has(value) }
    }

    const once = {
      ...tracker({ kind: 'once', date: '2026-10-15' }),
      scheduling: { mode: 'effective' as const, effectiveDays: 1, effectiveDayCounting: 'planned-activity-days' as const },
    }
    const onceHoliday = new CountingHolidays(['2026-10-15'])
    expect(() => nthEffectiveDate({ tracker: once, startDate: '2026-10-15', effectiveDays: 1, holidays: onceHoliday }))
      .toThrow(/Could not find 1 eligible days within 366000 calendar days/)
    expect(onceHoliday.evaluations).toBe(1)

    const selectedDates = {
      ...tracker({ kind: 'specific-dates', dates: ['2026-10-15', '2026-10-20', '2026-11-01'] }),
      scheduling: { mode: 'effective' as const, effectiveDays: 3, effectiveDayCounting: 'planned-activity-days' as const },
    }
    const excludedDates = new CountingHolidays(['2026-10-15', '2026-10-20', '2026-11-01'])
    expect(() => nthEffectiveDate({ tracker: selectedDates, startDate: '2026-10-15', effectiveDays: 3, holidays: excludedDates }))
      .toThrow(/Could not find 3 eligible days within 366000 calendar days/)
    expect(excludedDates.evaluations).toBe(3)

    const oneAvailable = new CountingHolidays(['2026-10-15', '2026-10-20'])
    expect(nthEffectiveDate({ tracker: selectedDates, startDate: '2026-10-15', effectiveDays: 1, holidays: oneAvailable })).toBe('2026-11-01')
    expect(oneAvailable.evaluations).toBe(3)
  })

  it('keeps searching when a future rule version introduces recurring eligible dates', () => {
    const once = {
      ...tracker({ kind: 'once', date: '2026-10-15' }),
      scheduling: { mode: 'effective' as const, effectiveDays: 2, effectiveDayCounting: 'planned-activity-days' as const },
    }
    const transitioned = versionTrackerRuleChange({
      before: once,
      after: { ...once, schedule: { kind: 'every-day' as const } },
      application: 'apply-from-today',
      today: '2026-10-17',
      historyStartDate: '2026-10-15',
      recordedAt: '2026-10-17T00:00:00.000Z',
    })
    expect(nthEffectiveDate({ tracker: transitioned, startDate: '2026-10-15', effectiveDays: 2, holidays: new Set(['2026-10-15']) }))
      .toBe('2026-10-18')
  })

  it('preserves v6 Effective Days as every non-holiday date and forces No Recurrence to flexible duration counting', () => {
    const legacyV6 = { ...tracker({ kind: 'weekdays' }), schemaVersion: 6 as const, scheduling: { mode: 'effective' as const, effectiveDays: 3 } }
    expect(nthEffectiveDate({ tracker: legacyV6, startDate: '2026-11-01', effectiveDays: 3 })).toBe('2026-11-03')
    const noRecurrence = { ...legacyV6, schedule: { kind: 'none' as const }, scheduling: { ...legacyV6.scheduling, effectiveDayCounting: 'planned-activity-days' as const } }
    expect(nthEffectiveDate({ tracker: noRecurrence, startDate: '2026-11-01', effectiveDays: 3 })).toBe('2026-11-03')
  })

  it('caps Effective Day numbering at the configured duration after the projected end', () => {
    const effective = { ...tracker({ kind: 'every-day' }), scheduling: { mode: 'effective' as const, effectiveDays: 3, effectiveDayCounting: 'all-non-holiday-days' as const } }
    expect(effectiveDayNumber({ tracker: effective, date: '2026-10-20' })).toBe(3)
    expect(effectiveDaysRemaining({ tracker: effective, date: '2026-10-20', targetEffectiveDays: 3 })).toBe(0)
  })

  it('derives inclusive duration deadlines and moves only effective deadlines for holidays', () => {
    const daily = tracker({ kind: 'every-day' })
    const effective = { ...daily, scheduling: { mode: 'effective' as const, effectiveDays: 100, planningTimeZone: 'UTC' } }
    expect(deriveSchedulingDeadline({ tracker: effective, holidays: new Set() })).toBe('2027-01-22')
    expect(deriveSchedulingDeadline({ tracker: effective, holidays: new Set(['2026-10-20']) })).toBe('2027-01-23')
    const fixed = { ...daily, deadline: '2027-01-22', scheduling: { mode: 'calendar' as const } }
    expect(deriveSchedulingDeadline({ tracker: fixed, holidays: new Set(['2026-10-20']) })).toBe('2027-01-22')
  })

  it('derives deadlines across a calendar-year boundary without changing inclusive counting', () => {
    const effective = {
      ...tracker({ kind: 'every-day' }), startDate: '2026-12-31',
      scheduling: { mode: 'effective' as const, effectiveDays: 2, planningTimeZone: 'UTC' },
    }
    expect(deriveSchedulingDeadline({ tracker: effective })).toBe('2027-01-01')
  })

  it.each(['Asia/Calcutta', 'Asia/Kolkata'])('reproduces the 92-day planned-activity deadline with %s', (timeZone) => {
    const effective: TrackerDefinition = {
      ...tracker({ kind: 'every-day' }),
      schemaVersion: 6,
      name: '92 Day DSA',
      startDate: '2026-10-29',
      deadline: '2027-01-28',
      scheduling: {
        mode: 'effective', effectiveDays: 92,
        effectiveDayCounting: 'planned-activity-days', planningTimeZone: timeZone,
      },
    }
    expect(() => new Intl.DateTimeFormat('en', { timeZone })).not.toThrow()
    expect(() => deriveSchedulingDeadline({ tracker: effective, timeZone })).not.toThrow()
    expect(deriveSchedulingDeadline({ tracker: effective, timeZone })).toBe('2027-01-28')
    expect(deriveSchedulingDeadline({ tracker: effective, timeZone, holidays: new Set(['2026-11-05']) })).toBe('2027-01-29')
    expect(deriveSchedulingDeadline({ tracker: effective, timeZone, holidays: new Set(['2026-10-10', '2026-10-11']) })).toBe('2027-01-28')
  })
})
