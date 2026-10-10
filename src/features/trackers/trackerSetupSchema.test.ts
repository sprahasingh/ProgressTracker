import { describe, expect, it } from 'vitest'
import { trackerSetupSchema } from './trackerSetupSchema'

const base = {
  name: 'Test tracker', description: '', schedule: 'every-day', startDate: '2026-01-05', deadline: '', strictMode: false,
}
const today = new Date().toISOString().slice(0, 10)

describe('tracker setup date range', () => {
  it.each(['habit', 'goal', 'challenge', 'project'] as const)('%s accepts past, current, and future starts without a deadline', (kind) => {
    for (const startDate of ['2025-12-31', today, '2099-12-31']) {
      expect(trackerSetupSchema.safeParse({ ...base, kind, startDate }).success).toBe(true)
    }
  })

  it.each(['habit', 'goal', 'challenge', 'project'] as const)('%s accepts a start date equal to its deadline', (kind) => {
    expect(trackerSetupSchema.safeParse({ ...base, kind, startDate: '2099-12-31', deadline: '2099-12-31' }).success).toBe(true)
  })

  it.each(['habit', 'goal', 'challenge', 'project'] as const)('%s clearly rejects a start date after its deadline', (kind) => {
    const result = trackerSetupSchema.safeParse({ ...base, kind, startDate: '2099-12-31', deadline: '2099-12-30' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({
      path: ['startDate'],
      message: 'Start date must be on or before the deadline. Choose an earlier start date or move the deadline to this date.',
    }))
  })
})
