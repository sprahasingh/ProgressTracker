import { describe, expect, it } from 'vitest'
import { deriveSchedulingDeadline, effectiveDayNumber, effectiveDaysRemaining, isEffectiveDateEligible, nthEffectiveDate, trackerScheduling } from './scheduling'
import type { TrackerDefinition } from './types'

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

  it('counts eligible dates, not check-ins, excluding holidays and scheduled rest days', () => {
    const weekdays = tracker({ kind: 'weekdays' })
    const holidays = new Set(['2026-10-15', '2026-10-19'])
    expect(nthEffectiveDate({ tracker: weekdays, startDate: '2026-10-15', effectiveDays: 3, holidays, timeZone: 'America/New_York' })).toBe('2026-10-21')
    expect(effectiveDayNumber({ tracker: weekdays, date: '2026-10-20', holidays })).toBe(2)
    expect(effectiveDayNumber({ tracker: weekdays, date: '2026-10-16', holidays })).toBe(1)
    expect(effectiveDaysRemaining({ tracker: weekdays, date: '2026-10-19', targetEffectiveDays: 3, holidays })).toBe(2)
    expect(isEffectiveDateEligible(weekdays, '2026-10-15', holidays)).toBe(false)
  })

  it('counts missed dates while a skipped or missing check-in has no scheduling effect', () => {
    const daily = tracker({ kind: 'every-day' })
    expect(nthEffectiveDate({ tracker: daily, startDate: '2026-10-15', effectiveDays: 3, holidays: new Set() })).toBe('2026-10-17')
    expect(effectiveDayNumber({ tracker: daily, date: '2026-10-16', holidays: new Set() })).toBe(2)
  })

  it('honors leap day and fails safely when a schedule has no eligible dates', () => {
    const once = tracker({ kind: 'once', date: '2028-02-29' })
    expect(nthEffectiveDate({ tracker: once, startDate: '2028-02-28', effectiveDays: 1 })).toBe('2028-02-29')
    expect(() => nthEffectiveDate({ tracker: tracker({ kind: 'none' }), startDate: '2026-10-15', effectiveDays: 1, maxSearchDays: 3 })).toThrow(/Could not find/)
  })

  it('derives inclusive duration deadlines and moves only effective deadlines for holidays', () => {
    const daily = tracker({ kind: 'every-day' })
    const effective = { ...daily, scheduling: { mode: 'effective' as const, effectiveDays: 100, planningTimeZone: 'UTC' } }
    expect(deriveSchedulingDeadline({ tracker: effective, holidays: new Set() })).toBe('2027-01-22')
    expect(deriveSchedulingDeadline({ tracker: effective, holidays: new Set(['2026-10-20']) })).toBe('2027-01-23')
    const fixed = { ...daily, deadline: '2027-01-22', scheduling: { mode: 'calendar' as const } }
    expect(deriveSchedulingDeadline({ tracker: fixed, holidays: new Set(['2026-10-20']) })).toBe('2027-01-22')
  })
})
