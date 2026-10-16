import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAutomaticBinCleanupEnabled, isHolidayPermanentDeletionEnabled, isPermanentDeletionEnabled, isProgressionUiEnabled, isSchemaV3WriteEnabled, isSchemaV4WriteEnabled, isSchemaV5WriteEnabled, isSchemaV6WriteEnabled, isSchemaV7WriteEnabled, isSchemaV8WriteEnabled, isSchemaV9WriteEnabled, isTrackerSchemaWriteEnabled } from './schemaVersionGate'

afterEach(() => vi.unstubAllEnvs())

describe('schema v3 production write gate', () => {
  it('leaves development writes available for local verification', () => {
    vi.stubEnv('PROD', false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V3', '')
    expect(isSchemaV3WriteEnabled()).toBe(true)
  })

  it('keeps production writes disabled unless the readiness flag is exactly true', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V3', '')
    expect(isSchemaV3WriteEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V3', 'false')
    expect(isSchemaV3WriteEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V3', 'true')
    expect(isSchemaV3WriteEnabled()).toBe(true)
  })
})

describe('schema v4 production write gate', () => {
  it('keeps precision writes disabled until the hosted migration is explicitly verified', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V4', '')
    expect(isSchemaV4WriteEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V4', 'false')
    expect(isSchemaV4WriteEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V4', 'true')
    expect(isSchemaV4WriteEnabled()).toBe(true)
  })
})

describe('schema v5 production write gate', () => {
  it('keeps separate manual allocations disabled until the hosted migration is verified', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V5', '')
    expect(isSchemaV5WriteEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V5', 'false')
    expect(isSchemaV5WriteEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V5', 'true')
    expect(isSchemaV5WriteEnabled()).toBe(true)
  })
})

describe('schema v6 production write gate', () => {
  it('keeps unified scheduling disabled until its hosted migration is verified', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', '')
    expect(isSchemaV6WriteEnabled()).toBe(false)
    expect(isTrackerSchemaWriteEnabled(6)).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', 'true')
    expect(isSchemaV6WriteEnabled()).toBe(true)
    expect(isTrackerSchemaWriteEnabled(6)).toBe(true)
  })
})

describe('schema v7 Effective Days counting gate', () => {
  it('keeps new counting-method writes disabled in production until explicitly enabled', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V7', '')
    expect(isSchemaV7WriteEnabled()).toBe(false)
    expect(isTrackerSchemaWriteEnabled(7)).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V7', 'true')
    expect(isSchemaV7WriteEnabled()).toBe(true)
    expect(isTrackerSchemaWriteEnabled(7)).toBe(true)
  })
})

describe('schema v8 independent streak rule gate', () => {
  it('requires the v8 flag and its v7 scheduling prerequisite in production', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V7', '')
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V8', 'true')
    expect(isSchemaV8WriteEnabled()).toBe(false)
    expect(isTrackerSchemaWriteEnabled(8)).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V7', 'true')
    expect(isSchemaV8WriteEnabled()).toBe(true)
    expect(isTrackerSchemaWriteEnabled(8)).toBe(true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V8', 'false')
    expect(isTrackerSchemaWriteEnabled(8)).toBe(false)
  })
})

describe('schema v9 typed milestone gate', () => {
  it('requires the v9 readiness flag and the v8/v7 prerequisites', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V7', 'true')
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V8', 'true')
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V9', '')
    expect(isSchemaV9WriteEnabled()).toBe(false)
    expect(isTrackerSchemaWriteEnabled(9)).toBe(false)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V9', 'true')
    expect(isSchemaV9WriteEnabled()).toBe(true)
    expect(isTrackerSchemaWriteEnabled(9)).toBe(true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V8', 'false')
    expect(isTrackerSchemaWriteEnabled(9)).toBe(false)
  })
})

describe('permanent deletion production gate', () => {
  it('stays disabled unless explicitly enabled after hosted migration and scheduler verification', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', '')
    expect(isPermanentDeletionEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'false')
    expect(isPermanentDeletionEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_PERMANENT_DELETION', 'true')
    expect(isPermanentDeletionEnabled()).toBe(true)
  })
})

describe('automatic Bin cleanup messaging gate', () => {
  it('stays hidden unless the database schedule and cleanup control have been verified', () => {
    vi.stubEnv('VITE_ENABLE_AUTOMATIC_BIN_CLEANUP', '')
    expect(isAutomaticBinCleanupEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_AUTOMATIC_BIN_CLEANUP', 'false')
    expect(isAutomaticBinCleanupEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_AUTOMATIC_BIN_CLEANUP', 'true')
    expect(isAutomaticBinCleanupEnabled()).toBe(true)
  })
})

describe('holiday permanent deletion gate', () => {
  it('stays disabled until its backend safeguards are explicitly enabled', () => {
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', '')
    expect(isHolidayPermanentDeletionEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'false')
    expect(isHolidayPermanentDeletionEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'true')
    expect(isHolidayPermanentDeletionEnabled()).toBe(true)
  })
})

describe('progression presentation gate', () => {
  it('stays disabled until a release explicitly opts in', () => {
    vi.stubEnv('VITE_ENABLE_PROGRESSION_UI', '')
    expect(isProgressionUiEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_PROGRESSION_UI', 'false')
    expect(isProgressionUiEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_PROGRESSION_UI', 'true')
    expect(isProgressionUiEnabled()).toBe(true)
  })
})
