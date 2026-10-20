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

  it('aggregates effective tracker outcomes before showing holiday context', () => {
    expect(getDailyActivityStatus(['holiday', 'completed'], true)).toBe('completed')
    expect(getDailyActivityStatus(['holiday', 'partial'], true)).toBe('partial')
    expect(getDailyActivityStatus(['holiday', 'no-progress'], true)).toBe('no-progress')
    expect(getDailyActivityStatus(['holiday', 'skipped'], true)).toBe('skipped')
    expect(getDailyActivityStatus(['holiday', 'missed'], true)).toBe('missed')
    expect(getDailyActivityStatus(['holiday'], true)).toBe('holiday')
  })
})
