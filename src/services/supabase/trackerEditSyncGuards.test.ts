import { afterEach, describe, expect, it, vi } from 'vitest'

const { getSupabaseClient } = vi.hoisted(() => ({ getSupabaseClient: vi.fn() }))
vi.mock('./client', () => ({ getSupabaseClient }))

import { hasTrackerEditSyncGuardsContract } from './trackerEditSyncGuards'

afterEach(() => {
  vi.unstubAllEnvs()
  getSupabaseClient.mockReset()
})

describe('tracker edit sync guard contract', () => {
  it('fails closed when the production server does not advertise the contract', async () => {
    vi.stubEnv('PROD', true)
    getSupabaseClient.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'function missing' } }) })
    await expect(hasTrackerEditSyncGuardsContract()).resolves.toBe(false)
  })

  it('fails closed when the server returns an unexpected contract version', async () => {
    vi.stubEnv('PROD', true)
    getSupabaseClient.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: 'tracker-edit-sync-guards:v2', error: null }) })
    await expect(hasTrackerEditSyncGuardsContract()).resolves.toBe(false)
  })

  it('accepts only the exact production server contract', async () => {
    vi.stubEnv('PROD', true)
    getSupabaseClient.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: 'tracker-edit-sync-guards:v1', error: null }) })
    await expect(hasTrackerEditSyncGuardsContract()).resolves.toBe(true)
  })

  it('keeps local development independent of a hosted contract probe', async () => {
    vi.stubEnv('PROD', false)
    await expect(hasTrackerEditSyncGuardsContract()).resolves.toBe(true)
    expect(getSupabaseClient).not.toHaveBeenCalled()
  })
})
