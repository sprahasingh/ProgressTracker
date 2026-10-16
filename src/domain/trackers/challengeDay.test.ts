import { describe, expect, it } from 'vitest'
import { challengeDaysElapsed, firstChallengeDateAtDay, getChallengeDayDisplay } from './challengeDay'
import type { TrackerDefinition } from './types'
import { versionTrackerRuleChange } from './ruleVersions'

const challenge = (startDate: string, deadline: string): TrackerDefinition => ({
  schemaVersion: 1, id: 'challenge', name: 'DSA', description: '', kind: 'challenge', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' }, startDate, deadline, strictMode: false,
  metrics: [], customFields: [], milestones: [], createdAt: `${startDate}T12:00:00.000Z`, updatedAt: `${startDate}T12:00:00.000Z`, archivedAt: null, deletedAt: null,
})

describe('getChallengeDayDisplay', () => {
  it.each([
    ['2026-01-01', '2026-04-10', '2026-01-01', 'Day 1 of 100'],
    ['2026-01-01', '2026-04-10', '2026-01-02', 'Day 2 of 100'],
    ['2026-01-01', '2026-04-10', '2026-01-24', 'Day 24 of 100'],
    ['2026-01-01', '2026-04-10', '2026-04-10', 'Day 100 of 100'],
    ['2024-02-28', '2024-03-01', '2024-02-29', 'Day 2 of 3'],
    ['2026-03-08', '2026-03-08', '2026-03-08', 'Day 1 of 1'],
  ])('labels %s through %s on %s', (start, deadline, date, label) => {
    expect(getChallengeDayDisplay(challenge(start!, deadline!), date!, 'America/Los_Angeles')?.label).toBe(label)
  })

  it('handles upcoming and expired dates without producing day zero or day N+1', () => {
    const tracker = challenge('2026-01-01', '2026-04-10')
    expect(getChallengeDayDisplay(tracker, '2025-12-29')?.label).toBe('Starts in 3 days')
    expect(getChallengeDayDisplay(tracker, '2026-04-11')).toMatchObject({ phase: 'ended', day: 100, label: 'Ended on Day 100' })
  })

  it('does not show a current day after a challenge is marked complete', () => {
    expect(getChallengeDayDisplay({ ...challenge('2026-01-01', '2026-04-10'), status: 'completed' }, '2026-02-01'))
      .toMatchObject({ phase: 'ended', day: null, totalDays: 100, label: 'Challenge completed' })
  })

  it('uses the effective created date when the configured start is missing', () => {
    const tracker = { ...challenge('2026-01-01', '2026-01-03'), startDate: undefined, createdAt: '2026-01-01T12:00:00.000Z' }
    expect(getChallengeDayDisplay(tracker, '2026-01-01', 'America/Los_Angeles')?.label).toBe('Day 1 of 3')
  })

  it('pauses effective challenge numbering on holidays and resumes at the next eligible day', () => {
    const tracker = {
      ...challenge('2026-10-15', '2026-10-20'),
      schemaVersion: 6 as const,
      scheduling: { mode: 'effective' as const, effectiveDays: 3, planningTimeZone: 'UTC' },
    }
    const holidays = new Set(['2026-10-16'])
    expect(getChallengeDayDisplay(tracker, '2026-10-16', 'UTC', holidays)).toMatchObject({
      phase: 'paused', day: null, totalDays: 3, label: 'Holiday · next is Day 2', nextEligibleDate: '2026-10-17',
    })
    expect(getChallengeDayDisplay(tracker, '2026-10-17', 'UTC', holidays)?.label).toBe('Day 2 of 3 · Rest day')
    expect(getChallengeDayDisplay(tracker, '2026-10-18', 'UTC', holidays)?.label).toBe('Day 3 of 3 · Rest day')
  })

  it('advances Include rest days numbering on unscheduled dates and pauses only on holidays', () => {
    const tracker = { ...challenge('2026-10-15', '2026-10-20'), schemaVersion: 7 as const, schedule: { kind: 'weekdays' as const }, scheduling: { mode: 'effective' as const, effectiveDays: 3, effectiveDayCounting: 'all-non-holiday-days' as const } }
    expect(getChallengeDayDisplay(tracker, '2026-10-17')?.label).toBe('Day 3 of 3 · Rest day')
    expect(getChallengeDayDisplay(tracker, '2026-10-16', 'UTC', new Set(['2026-10-16']))?.label).toContain('Holiday')
  })

  it('continues challenge-day numbering across prospective schedule versions', () => {
    const before: TrackerDefinition = {
      ...challenge('2026-10-01', '2026-10-31'),
      schemaVersion: 6,
      scheduling: { mode: 'calendar' },
      schedule: { kind: 'every-day' },
    }
    const after: TrackerDefinition = {
      ...before,
      schedule: { kind: 'weekdays' },
      deadline: undefined,
      scheduling: { mode: 'effective', effectiveDays: 10, effectiveDayCounting: 'planned-activity-days' },
    }
    const versioned = versionTrackerRuleChange({
      before,
      after,
      application: 'apply-from-today',
      today: '2026-10-05',
      historyStartDate: '2026-10-01',
      recordedAt: '2026-10-05T00:00:00.000Z',
    })

    expect(challengeDaysElapsed(versioned, '2026-10-04', 'UTC')).toBe(4)
    expect(getChallengeDayDisplay(versioned, '2026-10-05', 'UTC')?.label).toBe('Day 5 of 10')
    expect(getChallengeDayDisplay(versioned, '2026-10-10', 'UTC')?.label).toBe('Rest day · next is Day 10')
    expect(getChallengeDayDisplay(versioned, '2026-10-12', 'UTC')?.label).toBe('Day 10 of 10')
    expect(firstChallengeDateAtDay(versioned, 10, '2026-10-12', 'UTC')).toBe('2026-10-12')
  })
})
