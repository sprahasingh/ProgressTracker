import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHECKIN_FEEDBACK_DURATION_MS, scheduleCheckinFeedbackExpiry } from './checkinFeedbackTimer'

describe('check-in feedback timer', () => {
  afterEach(() => vi.useRealTimers())

  it('expires feedback after two seconds', () => {
    vi.useFakeTimers()
    const onExpire = vi.fn()
    scheduleCheckinFeedbackExpiry(onExpire)

    vi.advanceTimersByTime(CHECKIN_FEEDBACK_DURATION_MS - 1)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledOnce()
  })
})
