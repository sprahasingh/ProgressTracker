import { describe, expect, it } from 'vitest'
import type { StoredTrackerEntry } from '../../db/models'
import type { TrackerDefinition } from '../../domain/trackers/types'
import { buildReminderCandidate, dueLocalSlot, isWithinQuietHours, previousLocalDate } from './reminderRules'

const tracker = { id: 'tracker-1', name: 'DSA', kind: 'habit', status: 'active', deletedAt: null, schedule: { kind: 'every-day' }, metrics: [] } as unknown as TrackerDefinition
const entry = (outcome: 'recorded' | 'skipped'): StoredTrackerEntry => ({ id: 'entry-1', trackerId: tracker.id, date: '2026-10-10', outcome, values: {}, note: '', createdAt: '', updatedAt: '', deletedAt: null })

describe('notification reminder rules', () => {
  it('selects only currently due timezone-local wall-clock slots', () => {
    expect(dueLocalSlot(new Date('2026-10-10T10:30:00Z'), 'Asia/Kolkata', ['16:00', '22:00'])).toBe('16:00')
    expect(dueLocalSlot(new Date('2026-10-10T11:00:00Z'), 'Asia/Kolkata', ['16:00'])).toBeNull()
    expect(dueLocalSlot(new Date('2026-10-10T10:00:00Z'), 'UTC', ['16:00'])).toBeNull()
  })
  it('skips a nonexistent DST wall time and yields the same slot identity for repeated wall time', () => {
    expect(dueLocalSlot(new Date('2026-03-08T07:05:00Z'), 'America/New_York', ['02:30'])).toBeNull()
    expect(dueLocalSlot(new Date('2026-11-01T05:30:00Z'), 'America/New_York', ['01:30'])).toBe('01:30')
    expect(dueLocalSlot(new Date('2026-11-01T06:30:00Z'), 'America/New_York', ['01:30'])).toBe('01:30')
  })
  it('computes the previous local calendar day across month and year boundaries', () => {
    expect(previousLocalDate('2026-01-01')).toBe('2025-12-31')
  })
  it('respects quiet windows that cross midnight and equal-endpoint all-day quiet periods', () => {
    expect(isWithinQuietHours(new Date('2026-10-10T19:00:00Z'), 'Asia/Kolkata', '23:00', '07:00')).toBe(true)
    expect(isWithinQuietHours(new Date('2026-10-10T04:00:00Z'), 'Asia/Kolkata', '23:00', '07:00')).toBe(false)
    expect(isWithinQuietHours(new Date(), 'UTC', '08:00', '08:00')).toBe(true)
  })
  it('groups scheduled unresolved trackers and creates stable date-and-slot identity and deep link', () => {
    const result = buildReminderCandidate({ trackers: [tracker], entries: [], holidays: new Set(), date: '2026-10-10', kind: 'pending', slot: '16:00' })
    expect(result).toMatchObject({ identity: 'pending-reminder:2026-10-10:16:00', trackerIds: ['tracker-1'], href: '/?date=2026-10-10' })
    expect(buildReminderCandidate({ trackers: [tracker], entries: [], holidays: new Set(['2026-10-10']), date: '2026-10-10', kind: 'pending', slot: '16:00' })).toBeNull()
  })
  it('does not remind about skips, deleted trackers, or resolved entries', () => {
    expect(buildReminderCandidate({ trackers: [tracker], entries: [entry('skipped')], holidays: new Set(), date: '2026-10-10', kind: 'overdue', slot: '10:00' })).toBeNull()
    expect(buildReminderCandidate({ trackers: [{ ...tracker, deletedAt: '2026-10-10' }], entries: [], holidays: new Set(), date: '2026-10-10', kind: 'pending', slot: '16:00' })).toBeNull()
  })
  it('keeps partial progress reminders controlled by the existing include-partial setting', () => {
    const partial = entry('recorded')
    expect(buildReminderCandidate({ trackers: [tracker], entries: [partial], holidays: new Set(), date: '2026-10-10', kind: 'pending', slot: '16:00' })).toBeNull()
    expect(buildReminderCandidate({ trackers: [tracker], entries: [partial], holidays: new Set(), date: '2026-10-10', kind: 'pending', includePartial: true, slot: '16:00' })).toMatchObject({ trackerIds: [tracker.id] })
  })
})
