import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import { ForegroundReminderMonitor } from './ForegroundReminderMonitor'
import type { StoredTrackerDefinition } from '../../db/models'

const mocks = vi.hoisted(() => ({ auth: { status: 'signed-in', user: { id: 'notification-account' } } }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => mocks.auth }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))

const tracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'reminder-tracker', name: 'Read', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [{ id: 'minutes', name: 'Minutes', valueType: 'quantity', thresholds: { direction: 'increase', target: 20, streakQualification: 'target' } }],
  qualificationRule: { kind: 'threshold', metricId: 'minutes', level: 'target' }, customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

afterEach(async () => {
  cleanup()
  // Let a foreground reconciliation already in flight finish before clearing its IndexedDB.
  await new Promise((resolve) => setTimeout(resolve, 25))
  vi.restoreAllMocks()
  await db.delete()
  vi.useRealTimers()
})

describe('foreground reminders', () => {
  beforeEach(() => {
    // Keep the workspace date stable while leaving async timers real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-14T12:15:00.000Z'))
  })

  it('evaluates local progress at the configured timezone slot and deduplicates it', async () => {
    const now = new Date()
    const dueTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
    await localRepository.saveNotificationPreferences({ enabled: true, daily_enabled: true, daily_times: [dueTime], overdue_enabled: false, overdue_times: ['10:00'], remind_partial: false, motivation_mode: 'off', motivation_times: ['18:00'], motivation_weekdays: [0,1,2,3,4,5,6], timezone: 'UTC', quiet_start: null, quiet_end: null, allow_overdue_during_quiet: false, daily_limit: 4, motivation_daily_limit: 1, tracker_ids: null })
    await localRepository.saveTracker(tracker)
    render(<ForegroundReminderMonitor enabled />)
    await waitFor(async () => expect(await localRepository.listAppNotifications()).toHaveLength(1))
    const notification = (await localRepository.listAppNotifications())[0]!
    expect(notification.identity).toBe(`pending-reminder:${now.toISOString().slice(0, 10)}:${dueTime}`)
    expect(notification.title).toContain('1 activity is')
    window.dispatchEvent(new Event('focus'))
    await waitFor(async () => expect(await localRepository.listAppNotifications()).toHaveLength(1))
    expect(await localRepository.listAppNotifications()).toHaveLength(1)
  })

  it('reminds about yesterday as unrecorded, then removes the reminder when the user records or clears a check-in', async () => {
    const now = new Date()
    const today = now.toISOString().slice(0, 10) as `${number}-${number}-${number}`
    const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10) as `${number}-${number}-${number}`
    const dueTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
    await localRepository.saveNotificationPreferences({ enabled: true, daily_enabled: false, daily_times: [], overdue_enabled: true, overdue_times: [dueTime], remind_partial: false, motivation_mode: 'off', motivation_times: [], motivation_weekdays: [0,1,2,3,4,5,6], timezone: 'UTC', quiet_start: null, quiet_end: null, allow_overdue_during_quiet: false, daily_limit: 4, motivation_daily_limit: 1, tracker_ids: null })
    await localRepository.saveTracker(tracker)
    render(<ForegroundReminderMonitor enabled />)
    await waitFor(async () => expect(await localRepository.listAppNotifications()).toHaveLength(1))
    const reminder = (await localRepository.listAppNotifications())[0]!
    expect(reminder).toMatchObject({ identity: `overdue-reminder:${yesterday}:${dueTime}`, title: 'Unrecorded check-in', body: 'You haven\'t recorded your Read check-in for ' + new Date(`${yesterday}T12:00:00.000Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) + '.' })
    expect(await localRepository.getTrackerEntry(tracker.id, yesterday)).toBeUndefined()

    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: yesterday, outcome: 'recorded', values: { minutes: 20 }, note: '' })
    await waitFor(async () => expect(await localRepository.listAppNotifications()).toHaveLength(0))
    expect(await localRepository.getTrackerEntry(tracker.id, yesterday)).toMatchObject({ outcome: 'recorded', values: { minutes: 20 } })

    await localRepository.deleteTrackerEntry(tracker.id, yesterday)
    await waitFor(async () => expect(await localRepository.listAppNotifications()).toHaveLength(1))
    expect(await localRepository.getTrackerEntry(tracker.id, yesterday)).toBeUndefined()
  })
})
