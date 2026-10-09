import { describe, expect, it } from 'vitest'
import { formatTrackerNumber } from './formatNumber'

describe('progress number display', () => {
  it('shows no more than two decimal places without changing stored numbers', () => {
    expect(formatTrackerNumber(3)).toBe('3')
    expect(formatTrackerNumber(3.2)).toBe('3.2')
    expect(formatTrackerNumber(3.236)).toBe('3.24')
    expect(3.236).toBe(3.236)
  })
})
