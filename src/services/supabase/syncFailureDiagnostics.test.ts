import { describe, expect, it } from 'vitest'
import { classifySyncFailure, reportSyncFailure, SYNC_FAILURE_DIAGNOSTIC_EVENT, syncFailureMessage } from './syncFailureDiagnostics'

describe('safe synchronization failure diagnostics', () => {
  it.each([
    [Object.assign(new Error('private storage details'), { name: 'LocalStorageFailure' }), 'local-storage', 'No records were cleared.'],
    [Object.assign(new Error('private session details'), { name: 'AuthApiError', code: '401' }), 'authentication', 'Reauthenticate'],
    [Object.assign(new Error('permission denied'), { code: '42501' }), 'authorization', 'does not have permission'],
    [Object.assign(new Error('forbidden'), { status: 403 }), 'authorization', 'does not have permission'],
    [new TypeError('private URL and request details'), 'network', 'could not be reached'],
    [Object.assign(new Error('unsupported schema version'), { name: 'ZodError' }), 'schema', 'incompatible'],
    [new Error('private cloud query detail'), 'cloud-request', 'cloud request failed'],
  ] as const)('categorizes a sync failure without displaying its raw message', (error, category, publicText) => {
    expect(classifySyncFailure(error)).toBe(category)
    expect(syncFailureMessage(category)).toContain(publicText)
    expect(syncFailureMessage(category)).not.toContain('private')
  })

  it('emits only safe operation metadata', () => {
    let detail: unknown
    window.addEventListener(SYNC_FAILURE_DIAGNOSTIC_EVENT, ((event: CustomEvent) => { detail = event.detail }) as EventListener, { once: true })
    const result = reportSyncFailure(new Error('email, token, and record contents'))
    expect(detail).toEqual(result)
    expect(Object.keys(result).sort()).toEqual(['category', 'occurredAt', 'operation', 'stage'])
    expect(JSON.stringify(result)).not.toMatch(/email|token|record contents/)
  })
})
