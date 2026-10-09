import { describe, expect, it } from 'vitest'
import { normalizeSyncTimestamp, normalizeTrackerTimestamps } from './syncTimestamps'

describe('sync timestamp normalization', () => {
  it('keeps valid UTC ISO timestamps in the documented representation', () => {
    expect(normalizeSyncTimestamp('2026-10-09T04:05:06.123Z', 'createdAt')).toBe('2026-10-09T04:05:06.123Z')
  })

  it('normalizes PostgreSQL timestamptz text while preserving microsecond precision', () => {
    expect(normalizeSyncTimestamp('2026-10-09 04:05:06.123456+00', 'createdAt')).toBe('2026-10-09T04:05:06.123456Z')
  })

  it('converts explicit ISO and PostgreSQL offsets to the same UTC instant', () => {
    expect(normalizeSyncTimestamp('2026-10-09T09:35:06.123456+05:30', 'updatedAt')).toBe('2026-10-09T04:05:06.123456Z')
    expect(normalizeSyncTimestamp('2026-10-09 00:05:06-04:00', 'updatedAt')).toBe('2026-10-09T04:05:06Z')
  })

  it('rejects malformed values and invalid calendar dates instead of weakening validation', () => {
    expect(() => normalizeSyncTimestamp('not a timestamp', 'createdAt')).toThrow('Invalid ISO datetime')
    expect(() => normalizeSyncTimestamp('2026-02-30T00:00:00Z', 'updatedAt')).toThrow('Invalid ISO datetime')
    expect(() => normalizeSyncTimestamp('2026-10-09T04:05:06', 'createdAt')).toThrow('Invalid ISO datetime')
  })

  it('normalizes only timestamp fields and preserves their represented instants', () => {
    expect(normalizeTrackerTimestamps({
      id: 'tracker',
      createdAt: '2026-10-09 04:05:06.123456+00',
      updatedAt: '2026-10-09T09:35:06.123456+05:30',
      deletedAt: null,
      name: 'Kept',
    })).toEqual({
      id: 'tracker',
      createdAt: '2026-10-09T04:05:06.123456Z',
      updatedAt: '2026-10-09T04:05:06.123456Z',
      deletedAt: null,
      name: 'Kept',
    })
  })
})
