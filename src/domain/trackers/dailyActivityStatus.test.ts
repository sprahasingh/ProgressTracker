import { describe, expect, it } from 'vitest'
import { getDailyActivityStatus } from './dailyActivityStatus'
import type { ActivityStatus } from './activityStatus'

describe('daily calendar activity aggregation', () => {
  it.each([
    [['completed'], 'completed'],
    [['partial'], 'partial'],
    [['no-progress'], 'no-progress'],
    [['pending'], 'pending'],
    [['completed', 'completed'], 'completed'],
    [['completed', 'partial'], 'partial'],
    [['completed', 'no-progress'], 'partial'],
    [['partial', 'no-progress'], 'partial'],
    [['no-progress', 'no-progress'], 'no-progress'],
    [['completed', 'pending'], 'pending'],
    [['completed', 'partial', 'no-progress'], 'partial'],
    [['completed', 'completed', 'completed'], 'completed'],
    [['partial', 'partial', 'partial'], 'partial'],
    [['no-progress', 'no-progress', 'no-progress'], 'no-progress'],
    [['missed'], 'missed'],
    [[], 'no-trackers'],
  ] as Array<[ActivityStatus[], ActivityStatus]>)('maps %j to %s', (statuses, expected) => {
    expect(getDailyActivityStatus(statuses)).toBe(expected)
  })

  it('keeps holiday context as the calendar indicator while retaining tracker outcomes in its summary', () => {
    expect(getDailyActivityStatus(['completed', 'no-progress'], true)).toBe('holiday')
  })
})
