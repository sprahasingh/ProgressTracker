import { afterAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { db, activateWorkspace } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { synchronizeWorkspace } from '../../services/supabase/syncEngine'
import { getEarnedAndLockedBadges, getProgressionOverview } from '../../services/supabase/progressionRepository'
import { getSupabaseClient } from '../../services/supabase/client'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { BadgeCelebrationMonitor } from './BadgeCelebrationDialog'
import { ProgressionAchievementsPage } from './ProgressionAchievementsPage'

const liveAuth = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({
  status: 'signed-in', user: liveAuth.userId ? { id: liveAuth.userId } : null,
  workspaceStatus: 'ready', workspaceUserId: liveAuth.userId,
  sessionTransitionPending: false, isOnline: true, syncStatus: 'complete',
}) }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))

const environment = (globalThis as typeof globalThis & { process: { env: Record<string, string | undefined> } }).process.env
const url = environment.SUPABASE_URL
const anonKey = environment.SUPABASE_ANON_KEY
const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY
const databaseContainer = environment.SUPABASE_DB_CONTAINER
const enabled = environment.RUN_PROGRESS_TRACKER_LOCAL_INTEGRATION === 'true'
const execFileAsync = promisify(execFile)

async function queryLocalDatabase(sql: string): Promise<string> {
  if (!databaseContainer) throw new Error('The isolated PostgreSQL container was not provided to the live celebration test.')
  const result = await execFileAsync('docker', ['exec', databaseContainer, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', sql], { timeout: 10_000 })
  return result.stdout.trim()
}

const suite = describe.skipIf(!enabled)('live Wins and badge celebration flow', () => {
  let admin: SupabaseClient | undefined
  let userId: string | undefined

  afterAll(async () => {
    cleanup()
    if (userId && admin) await admin.auth.admin.deleteUser(userId)
    liveAuth.userId = null
    db.close()
    await db.delete()
    await activateWorkspace(null)
  })

  it('renders newly confirmed API awards in Wins and celebrates them once in sequence', async () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    admin = createClient(url!, serviceRoleKey!, { auth: { persistSession: false, autoRefreshToken: false } })
    const suffix = crypto.randomUUID()
    const email = `wins-celebration-${suffix}@example.test`
    const password = `LocalOnly-${suffix}-Aa9!`
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (createError || !created.user) throw new Error(`Could not create isolated celebration user: ${createError?.message ?? 'missing user'}`)
    userId = created.user.id

    const authClient = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: signedIn, error: signInError } = await authClient.auth.signInWithPassword({ email, password })
    if (signInError || !signedIn.session) throw new Error(`Could not sign in isolated celebration user: ${signInError?.message ?? 'missing session'}`)
    const applicationClient = getSupabaseClient()
    if (!applicationClient) throw new Error('The application client is not configured for the isolated Supabase URL.')
    const sessionResult = await applicationClient.auth.setSession(signedIn.session)
    if (sessionResult.error) throw new Error(`Could not set the application session: ${sessionResult.error.message}`)

    liveAuth.userId = userId
    await activateWorkspace(userId)
    await db.settings.put({ id: 'general', timezone: 'UTC', appearance: 'system', backupReminderDays: null, updatedAt: new Date().toISOString() })
    const now = new Date().toISOString()
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 1, id: crypto.randomUUID(), name: 'Wins integration habit', description: '', kind: 'habit', status: 'active',
      categoryId: null, tags: [], icon: 'repeat', accent: 'apricot', schedule: { kind: 'every-day' },
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }], customFields: [], milestones: [],
      createdAt: now, updatedAt: now, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    await expect(synchronizeWorkspace(userId, authClient)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    const badgesBefore = await getEarnedAndLockedBadges(userId)
    expect(badgesBefore.flatMap((badge) => badge.history).filter((event) => event.eventType === 'unlocked')).toHaveLength(0)

    const dialogView = render(createElement(BadgeCelebrationMonitor, { userId }))
    await waitFor(() => expect(localStorage.getItem(`progress-tracker:achievement-seen:${userId}`)).not.toBeNull())
    const today = localCalendarDate(new Date(), 'UTC')
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome: 'recorded', values: { done: true }, note: 'offline until upload' })
    const originalOperation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', savedEntry.id]).first()
    expect(originalOperation?.status).toBe('pending')
    await expect(synchronizeWorkspace(userId, authClient)).resolves.toMatchObject({ uploaded: 1, failed: 0, conflicts: 0 })

    const serverBadges = await getEarnedAndLockedBadges(userId)
    const unlocked = serverBadges.flatMap((badge) => badge.history).filter((event) => event.eventType === 'unlocked')
    expect(unlocked.map((event) => event.achievementId).sort()).toEqual(['first-step', 'perfect-day'])
    expect(new Set(unlocked.map((event) => event.sourceDate))).toEqual(new Set([today]))
    expect(unlocked.every((event) => event.sourceEventId && Number.isFinite(Date.parse(event.recordedAt)))).toBe(true)
    const overview = await getProgressionOverview(userId)
    expect(overview.confirmedXp).toBe(30)
    expect(overview.achievements.filter((badge) => badge.earned)).toHaveLength(2)

    const pageView = render(createElement(MemoryRouter, null, createElement(ProgressionAchievementsPage)))
    const winsBadgeSummary = await screen.findByRole('article', { name: '2 distinct badge types unlocked' })
    expect(within(winsBadgeSummary).getByText('2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Plus 30 XP this week, open score history/i })).toBeInTheDocument()

    const firstDialog = await screen.findByRole('dialog', { name: /First Step/i })
    expect(within(firstDialog).getByText(/first unlock/i)).toBeInTheDocument()
    expect(within(firstDialog).getByText(/qualifying date/)).toHaveTextContent(today)
    expect(within(firstDialog).getByText(/XP confirmed/)).toHaveTextContent('+10 XP confirmed')
    expect(within(firstDialog).getByRole('button', { name: 'About this celebration' })).toBeInTheDocument()
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Next' }))
    const secondDialog = await screen.findByRole('dialog', { name: /Perfect Day/i })
    expect(within(secondDialog).getByText(/first unlock/i)).toBeInTheDocument()
    fireEvent.click(within(secondDialog).getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const perfectDayCard = await screen.findByRole('button', { name: /Perfect Day, earned/i })
    expect(within(perfectDayCard).getByText(/Most recent ·/)).toBeInTheDocument()
    expect(within(perfectDayCard).getByText('Earned once')).toBeInTheDocument()
    fireEvent.click(perfectDayCard)
    const perfectDayDetail = await screen.findByRole('dialog', { name: 'Perfect Day' })
    expect(within(perfectDayDetail).getByText(/Unlocked · Award 1/)).toBeInTheDocument()
    const displayedAwardTimes = [...perfectDayDetail.querySelectorAll('time')].map((element) => element.getAttribute('datetime'))
    expect(displayedAwardTimes).toContain(unlocked.find((event) => event.achievementId === 'perfect-day')?.recordedAt)
    fireEvent.click(within(perfectDayDetail).getByRole('button', { name: 'Close details' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Re-reading server history and syncing a duplicate operation must not enqueue old awards again.
    const entry = await localRepository.getTrackerEntry(tracker.id, today)
    const duplicate = await authClient.rpc('apply_tracker_sync_operation', {
      p_expected_user_id: userId, p_operation_id: originalOperation!.id, p_entity: 'tracker_entry',
      p_expected_revision: originalOperation!.expectedRevision, p_record: {
        id: entry!.id, tracker_id: tracker.id, entry_date: today, outcome: entry!.outcome,
        entry_values: entry!.values, note: entry!.note, created_at: entry!.createdAt,
        updated_at: entry!.updatedAt, deleted_at: entry!.deletedAt,
      },
    })
    expect(duplicate.error).toBeNull()
    expect(duplicate.data?.status).toBe('applied')
    dialogView.rerender(createElement(BadgeCelebrationMonitor, { userId }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect((await getEarnedAndLockedBadges(userId)).flatMap((badge) => badge.history).filter((event) => event.eventType === 'unlocked')).toHaveLength(2)
    dialogView.unmount()
    const restoredCelebrationView = render(createElement(BadgeCelebrationMonitor, { userId }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // Backdate only this disposable account's initialization fence, as the
    // existing live suite does for its seven-day streak fixture. Five distinct
    // server-confirmed dates exercise ordinary repeat and tier-five celebration.
    const cutover = `${shiftCalendarDate(today, -6)}T00:00:00.000Z`
    const repeatTrackerCreatedAt = `${shiftCalendarDate(today, -5)}T00:00:00.000Z`
    await queryLocalDatabase(`UPDATE public.progression_account_state SET initialized_at='${cutover}'::timestamptz WHERE user_id='${userId}'; UPDATE public.progression_achievement_accounts SET initialized_at='${cutover}'::timestamptz WHERE user_id='${userId}'; UPDATE public.progression_achievement_repeatable_cutover SET recorded_at='${cutover}'::timestamptz;`)
    const repeatTracker: StoredTrackerDefinition = {
      ...tracker, id: crypto.randomUUID(), name: 'Repeat award integration habit',
      createdAt: repeatTrackerCreatedAt, updatedAt: repeatTrackerCreatedAt,
    }
    await localRepository.saveTracker(repeatTracker)
    await expect(synchronizeWorkspace(userId, authClient)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    // The real evaluator intentionally ignores dates before the latest tracker
    // definition change. In this disposable fixture, represent that both
    // schedules have existed since the repeat window began.
    await queryLocalDatabase(`UPDATE public.trackers SET updated_at='${repeatTrackerCreatedAt}'::timestamptz WHERE user_id='${userId}';`)
    for (let offset = -4; offset <= 0; offset += 1) {
      await localRepository.saveTrackerEntry({ trackerId: repeatTracker.id, date: shiftCalendarDate(today, offset), outcome: 'recorded', values: { done: true }, note: 'distinct repeat date' })
    }
    const repeatedSync = await synchronizeWorkspace(userId, authClient)
    const repeatedSyncDiagnostics = (await db.syncOperations.where('ownerUserId').equals(userId).toArray())
      .filter((operation) => operation.entity === 'tracker_entry')
      .map(({ entityId, status, attempts, lastError }) => ({ entityId, status, attempts, lastError }))
    expect(repeatedSync, JSON.stringify(repeatedSyncDiagnostics)).toMatchObject({ uploaded: 5, failed: 0 })
    const repeatedPerfectDay = (await getEarnedAndLockedBadges(userId)).find((badge) => badge.achievementId === 'perfect-day')
    expect(repeatedPerfectDay?.validAwardCount).toBe(5)
    const reversedPerfectDayEvents = new Set(repeatedPerfectDay?.history.filter((event) => event.eventType === 'revoked').map((event) => event.reversesEventId))
    const activePerfectDayEvents = repeatedPerfectDay?.history.filter((event) => event.eventType === 'unlocked' && !reversedPerfectDayEvents.has(event.id)) ?? []
    expect(activePerfectDayEvents.map((event) => event.tier).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    const repeatedPerfectDayCard = await screen.findByRole('button', { name: /Perfect Day, earned/i })
    await waitFor(() => expect(within(repeatedPerfectDayCard).getByText('Earned 5 times')).toBeInTheDocument())
    const repeatLabels: string[] = []
    await screen.findByRole('dialog')
    for (let occurrence = 0; occurrence < 10; occurrence += 1) {
      const dialog = screen.queryByRole('dialog')
      if (!dialog) break
      const title = within(dialog).getByRole('heading', { level: 2 }).textContent ?? ''
      const label = dialog.querySelector('.badge-celebration-occurrence')?.textContent ?? ''
      repeatLabels.push(`${title}:${label}`)
      const dialogText = dialog.textContent
      fireEvent.click(within(dialog).getByRole('button', { name: /^(Next|Finish)$/ }))
      await waitFor(() => {
        const currentDialog = screen.queryByRole('dialog')
        expect(!currentDialog || currentDialog.textContent !== dialogText).toBe(true)
      })
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(repeatLabels.some((label) => label.startsWith('Perfect Day:First Unlock'))).toBe(true)
    expect(repeatLabels.some((label) => label.startsWith('Perfect Day:Earned for the 2nd time'))).toBe(true)
    expect(repeatLabels.some((label) => label.includes('5 valid awards'))).toBe(true)
    expect((await getProgressionOverview(userId)).confirmedXp).toBe(160)
    pageView.unmount()
    restoredCelebrationView.unmount()
  }, 60_000)
})

export { suite as progressionCelebrationLiveIntegrationSuite }
