import { describe, expect, it } from 'vitest'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import { selectMissingCheckIns } from './missingCheckIns'

const tracker = (overrides: Partial<StoredTrackerDefinition> = {}) => ({
  id: 't1', name: 'Read', kind: 'habit', status: 'active', deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  startDate: '2026-01-01', schedule: { kind: 'weekdays' }, strictMode: false,
  metrics: [], customFields: [], milestones: [], schemaVersion: 4,
  ...overrides,
} as StoredTrackerDefinition)
const entry = (overrides: Partial<StoredTrackerEntry> = {}) => ({
  id: 'e1', trackerId: 't1', date: '2026-01-05', outcome: 'recorded', values: {}, note: '',
  createdAt: '2026-01-05T12:00:00.000Z', updatedAt: '2026-01-05T12:00:00.000Z', deletedAt: null,
  ...overrides,
} as StoredTrackerEntry)

describe('selectMissingCheckIns', () => {
  const dates = ['2026-01-05', '2026-01-06'] as const
  it('selects only absent eligible opportunities, respecting entries, schedules, periods and holidays', () => {
    const trackers = [tracker(), tracker({ id: 't2', name: 'Walk', schedule: { kind: 'every-day' } })]
    expect(selectMissingCheckIns({ trackers, entries: [entry()], holidays: new Set(['2026-01-06']), dates, today: '2026-01-07', timeZone: 'UTC' }).map(({ tracker: t, date }) => `${t.id}:${date}`))
      .toEqual(['t2:2026-01-05'])
  })
  it('includes all strict-mode dates including holidays and rest days, but excludes dates outside the active period', () => {
    const strict = tracker({ strictMode: true, schedule: { kind: 'weekdays' }, deadline: '2026-01-05' })
    expect(selectMissingCheckIns({ trackers: [strict], entries: [], holidays: new Set(['2026-01-05']), dates, today: '2026-01-07', timeZone: 'UTC' }).map(({ date }) => date)).toEqual(['2026-01-05'])
  })
  it('excludes paused, archived and deleted trackers and all live outcomes including zero/skip', () => {
    const trackers = [tracker(), tracker({ id: 'paused', status: 'paused' }), tracker({ id: 'archived', status: 'archived' }), tracker({ id: 'deleted', deletedAt: '2026-01-02' })]
    const entries = [entry({ outcome: 'skipped' }), entry({ id: 'zero', date: '2026-01-06', values: { amount: 0 } })]
    expect(selectMissingCheckIns({ trackers, entries, holidays: new Set(), dates, today: '2026-01-07', timeZone: 'UTC' })).toEqual([])
  })
  it('does not include tombstoned entries, so a cleared eligible date is missing again', () => {
    const cleared = entry({ deletedAt: '2026-01-07T00:00:00.000Z' })
    expect(selectMissingCheckIns({ trackers: [tracker()], entries: [cleared], holidays: new Set(), dates: ['2026-01-05'], today: '2026-01-07', timeZone: 'UTC' })).toHaveLength(1)
  })
  it('never includes today or future dates even if supplied accidentally', () => {
    expect(selectMissingCheckIns({ trackers: [tracker()], entries: [], holidays: new Set(), dates: ['2026-01-06', '2026-01-07', '2026-01-08'], today: '2026-01-07', timeZone: 'UTC' }).map(({ date }) => date)).toEqual(['2026-01-06'])
  })
})
