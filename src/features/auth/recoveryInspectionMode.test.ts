import { afterEach, describe, expect, it } from 'vitest'
import { isTrackerRecoveryInspectionMode } from './recoveryInspectionMode'

afterEach(() => window.history.replaceState({}, '', '/'))

describe('recovery inspection deep links', () => {
  it('recognizes the GitHub Pages hash route with the Sync & Data section anchor', () => {
    window.history.replaceState({}, '', '/ProgressTracker/#/settings?recoveryPreview=1#sync-data')
    expect(isTrackerRecoveryInspectionMode()).toBe(true)
  })

  it('does not enter inspection mode during ordinary Settings or Account navigation', () => {
    window.history.replaceState({}, '', '/ProgressTracker/#/settings#sync-data')
    expect(isTrackerRecoveryInspectionMode()).toBe(false)
    window.history.replaceState({}, '', '/ProgressTracker/#/auth')
    expect(isTrackerRecoveryInspectionMode()).toBe(false)
  })

  it('requires the Settings route even when the recovery query is present', () => {
    window.history.replaceState({}, '', '/ProgressTracker/#/auth?recoveryPreview=1')
    expect(isTrackerRecoveryInspectionMode()).toBe(false)
  })
})
