import { describe, expect, it } from 'vitest'
import { detectNotificationCapabilities, notificationDeepLink } from './capabilities'

describe('notification capability detection', () => {
  it('recognizes a secure installed web-push capable runtime without claiming delivery configured', () => {
    const result = detectNotificationCapabilities({ isSecureContext: true, serviceWorker: {}, Notification: { permission: 'granted' }, PushManager: {}, standalone: true })
    expect(result).toMatchObject({ level: 'web-push-capable', standalone: true, permission: 'granted' })
    expect(result.reason).toMatch(/server configuration/)
  })
  it('keeps unsupported and denied platforms out of nonfunctional push controls', () => {
    expect(detectNotificationCapabilities({ isSecureContext: true, Notification: { permission: 'default' } }).level).toBe('in-app-only')
    expect(detectNotificationCapabilities({ isSecureContext: true, Notification: { permission: 'denied' }, serviceWorker: {}, PushManager: {} })).toMatchObject({ level: 'disabled', permission: 'denied' })
    expect(detectNotificationCapabilities({ isSecureContext: false, Notification: { permission: 'granted' }, serviceWorker: {}, PushManager: {} }).level).toBe('in-app-only')
  })
  it('explains the iOS Home Screen requirement while keeping installed-app capability feature-based', () => {
    const tab = detectNotificationCapabilities({ isSecureContext: true, serviceWorker: {}, Notification: { permission: 'default' }, PushManager: {}, userAgent: 'Mozilla/5.0 (iPhone)', standalone: false })
    expect(tab.level).toBe('in-app-only')
    expect(tab.reason).toMatch(/Home Screen/)
    const installed = detectNotificationCapabilities({ isSecureContext: true, serviceWorker: {}, Notification: { permission: 'granted' }, PushManager: {}, userAgent: 'Mozilla/5.0 (iPhone)', standalone: true })
    expect(installed.level).toBe('web-push-capable')
  })
  it('keeps deep links under the configured GitHub Pages base path', () => {
    expect(notificationDeepLink('https://example.test/ProgressTracker/', '/history', { date: '2026-10-10' })).toBe('https://example.test/ProgressTracker/#/history?date=2026-10-10')
  })
})
