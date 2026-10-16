import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNetworkFailure, isUnsupportedSchemaFailure, reportTrackerWriteDiagnostic } from './trackerWriteDiagnostics'

afterEach(() => vi.restoreAllMocks())

describe('tracker write diagnostics', () => {
  it('logs safe failure metadata without error text or record identifiers', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    reportTrackerWriteDiagnostic({
      category: 'server-validation-rejection',
      phase: 'server-request',
      schemaVersion: 10,
      entity: 'tracker',
      serverCode: '23514',
    })

    expect(log).toHaveBeenCalledWith('[tracker-write]', {
      category: 'server-validation-rejection',
      phase: 'server-request',
      schemaVersion: 10,
      entity: 'tracker',
      serverCode: '23514',
    })
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/Govind|tracker-id|token|password/i)
  })

  it('classifies unsupported schema and network errors without retaining their messages', () => {
    expect(isUnsupportedSchemaFailure(new Error('Versioned tracker rules need schema v10.'))).toBe(true)
    expect(isUnsupportedSchemaFailure(new Error('stale revision'))).toBe(false)
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkFailure(new Error('tracker definition is invalid'))).toBe(false)
  })
})
