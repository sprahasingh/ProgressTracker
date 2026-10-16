import { describe, expect, it } from 'vitest'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { calculateConsistency } from './consistency'

const tracker = (overrides: Partial<StoredTrackerDefinition> = {}): StoredTrackerDefinition => ({
  schemaVersion: 1, id: 't1', name: 'Daily', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: 'repeat', accent: 'apricot', schedule: { kind: 'every-day' }, metrics: [
    { id: 'done', name: 'Done', valueType: 'boolean' },
  ], customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null, deletedAt: null, ...overrides,
})

const entry = (date: string, overrides: Partial<StoredTrackerEntry> = {}, trackerId = 't1'): StoredTrackerEntry => ({
  id: `${trackerId}-${date}`, trackerId, date: date as StoredTrackerEntry['date'], outcome: 'recorded',
  values: { done: true }, note: '', createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, deletedAt: null,
  ...overrides,
})

describe('calculateConsistency', () => {
  it('averages daily adherence and excludes today, future dates, and dates without eligible work', () => {
    const result = calculateConsistency({
      trackers: [tracker()], today: '2026-01-04',
      entries: [entry('2026-01-01'), entry('2026-01-04'), entry('2026-01-05')],
    })
    expect(result.days.map((day) => day.date)).toEqual(['2026-01-03', '2026-01-02', '2026-01-01'])
    expect(result.score).toBe(33)
  })

  it('gives each eligible date equal weight when tracker counts differ', () => {
    const first = tracker({ id: 't1' })
    const second = tracker({ id: 't2', name: 'Second' })
    const result = calculateConsistency({
      trackers: [first, second], today: '2026-01-03',
      entries: [entry('2026-01-01', {}, 't1'), entry('2026-01-02', {}, 't1'), entry('2026-01-02', {}, 't2')],
    })
    expect(result.days.map((day) => day.adherence)).toEqual([1, 0.5])
    expect(result.score).toBe(75)
  })

  it('uses only the latest 30 completed eligible dates and returns null without eligible history', () => {
    const result = calculateConsistency({ trackers: [tracker()], today: '2026-02-10', windowSize: 30, entries: [] })
    expect(result.days).toHaveLength(30)
    expect(result.days.at(-1)?.date).toBe('2026-01-11')
    expect(result.score).toBe(0)
    expect(calculateConsistency({ trackers: [], entries: [], today: '2026-02-10' }).score).toBeNull()
  })

  it('respects schedule, Standard Mode holidays, Strict Mode dates, skips, and deleted entries', () => {
    const standard = tracker({ id: 'standard', schedule: { kind: 'selected-weekdays', weekdays: [1] } })
    const strict = tracker({ id: 'strict', strictMode: true, schedule: { kind: 'none' }, startDate: '2026-01-05' })
    const result = calculateConsistency({
      trackers: [standard, strict], holidays: new Set(['2026-01-05']), today: '2026-01-07',
      entries: [
        entry('2026-01-05', {}, 'standard'),
        entry('2026-01-05', { outcome: 'skipped' }, 'strict'),
        entry('2026-01-06', { deletedAt: '2026-01-06T14:00:00.000Z' }, 'strict'),
      ],
    })
    expect(result.days).toEqual([
      { date: '2026-01-06', eligible: 1, completed: 0, adherence: 0 },
      { date: '2026-01-05', eligible: 1, completed: 0, adherence: 0 },
    ])
  })

  it('counts archived trackers only for eligible dates before their archive date', () => {
    const archived = tracker({ id: 'archived', status: 'archived', archivedAt: '2026-01-03T00:00:00.000Z' })
    const result = calculateConsistency({ trackers: [archived], entries: [], today: '2026-01-05' })
    expect(result.days.map((day) => day.date)).toEqual(['2026-01-02', '2026-01-01'])
  })

  it('uses the Success Rule for consistency even when a custom Streak Rule qualifies', () => {
    const independentRules = tracker({
      schemaVersion: 8,
      startDate: '2026-01-02',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' }],
      qualificationRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 5 },
      streakRuleMode: 'custom',
      streakRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 1 },
    })
    const result = calculateConsistency({
      trackers: [independentRules], today: '2026-01-03',
      entries: [entry('2026-01-02', { values: { pages: 1 } })],
    })
    expect(result.days).toMatchObject([{ date: '2026-01-02', completed: 0, eligible: 1, adherence: 0 }])
    expect(result.score).toBe(0)
  })
})
