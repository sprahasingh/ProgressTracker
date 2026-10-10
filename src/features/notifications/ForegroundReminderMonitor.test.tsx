import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete() })

describe('foreground reminders', () => {
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
})
