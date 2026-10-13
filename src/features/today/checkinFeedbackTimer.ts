export const CHECKIN_FEEDBACK_DURATION_MS = 2000

export function scheduleCheckinFeedbackExpiry(onExpire: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(onExpire, CHECKIN_FEEDBACK_DURATION_MS)
}
