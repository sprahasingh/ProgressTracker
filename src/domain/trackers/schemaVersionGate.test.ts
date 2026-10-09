import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSchemaV3WriteEnabled } from './schemaVersionGate'

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
