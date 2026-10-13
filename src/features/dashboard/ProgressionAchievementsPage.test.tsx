import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import type { ProgressionOverview } from '../../services/supabase/progressionRepository'
import appStyles from '../../styles.css?raw'
import { AchievementsPage } from './AchievementsPage'

const mocks = vi.hoisted(() => ({
  getProgressionOverview: vi.fn(),
  getProgressionHistory: vi.fn(),
  listTrackers: vi.fn(),
  listTrackerEntriesBetween: vi.fn(),
  listAccountHolidays: vi.fn(),
  auth: { isOnline: true, syncStatus: 'complete' as string },
}))

vi.mock('../../services/supabase/progressionRepository', () => ({
  getProgressionOverview: mocks.getProgressionOverview,
  getProgressionHistory: mocks.getProgressionHistory,
}))
vi.mock('../../db/localRepository', () => ({ localRepository: {
  listTrackers: mocks.listTrackers,
  listTrackerEntriesBetween: mocks.listTrackerEntriesBetween,
  listAccountHolidays: mocks.listAccountHolidays,
} }))
vi.mock('../../db/useWorkspaceDataChanges', () => ({ useWorkspaceDataChanges: vi.fn() }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({
  status: 'signed-in', user: { id: 'account-1' }, workspaceStatus: 'ready', workspaceUserId: 'account-1', sessionTransitionPending: false, isOnline: mocks.auth.isOnline, syncStatus: mocks.auth.syncStatus,
}) }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))

const today = new Date().toISOString().slice(0, 10)
const tracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'habit-1', name: 'Read each day', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: 'habit', accent: 'apricot', schedule: { kind: 'every-day' }, startDate: '2020-01-01',
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }], customFields: [], milestones: [], createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}
const entry: StoredTrackerEntry = { id: 'entry-1', trackerId: tracker.id, date: today, outcome: 'recorded', values: { done: true }, note: '', createdAt: `${today}T10:00:00.000Z`, updatedAt: `${today}T10:00:00.000Z`, deletedAt: null }
const checkIn = { id: 'xp-1', effectiveDate: today, recordedAt: `${today}T10:00:00.000Z`, xpDelta: 10, eventCategory: 'check_in', reasonCode: 'DAILY_CHECK_IN_COMPLETED', reversesEventId: null, sourceId: entry.id, trackerId: tracker.id, goalId: null, displayName: 'Read each day' }
const reversal = { id: 'reverse-1', effectiveDate: today, recordedAt: `${today}T11:00:00.000Z`, xpDelta: -10, eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: checkIn.id, sourceId: entry.id, trackerId: null, goalId: null, displayName: 'Deleted tracker' }
const streakAward = { id: 'streak-1', effectiveDate: today, recordedAt: `${today}T12:00:00.000Z`, xpDelta: 35, eventCategory: 'streak_milestone', reasonCode: 'STREAK_MILESTONE', reversesEventId: null, sourceId: null, trackerId: tracker.id, goalId: null, displayName: 'Read each day' }
const overview: ProgressionOverview = {
  legacyXpStatus: 'reconstructed',
  confirmedXp: 125,
  officialLevel: { level: 2, currentLevelXp: 100, nextLevelXp: 300, progressXp: 25, requiredXp: 200 },
  provisionalXp: 10,
  provisionalRewards: [{ id: 'check-in:entry-pending', effectiveDate: today, xpDelta: 10 }],
  scoreHistory: [checkIn, reversal, streakAward], streakHistory: [streakAward],
  consistency: { score: 75, eligibleDays: 2, dailyAdherence: [{ date: today, completed: 1, eligible: 1 }, { date: '2026-10-12', completed: 1, eligible: 2 }] },
  achievements: [
    { achievementId: 'first-step', progress: 1, target: 1, currentTier: 1, repeatable: false, earned: true, unlockedAt: `${today}T11:00:00.000Z`, history: [{ id: 'unlock-1', achievementId: 'first-step', tier: 1, generation: 1, eventType: 'unlocked', recordedAt: `${today}T11:00:00.000Z`, sourceEventId: checkIn.id, sourceDate: today, reversesEventId: null }] },
    { achievementId: 'dedicated', progress: 23, target: 100, currentTier: 0, repeatable: true, earned: false, unlockedAt: null, history: [] },
  ],
}

let injectedStylesheet: HTMLStyleElement | null = null
function renderPage() { return render(<MemoryRouter><AchievementsPage /></MemoryRouter>) }

beforeEach(() => {
  injectedStylesheet = document.createElement('style')
  injectedStylesheet.textContent = appStyles
  document.head.append(injectedStylesheet)
  mocks.auth.isOnline = true
  mocks.auth.syncStatus = 'complete'
  vi.stubEnv('VITE_ENABLE_PROGRESSION_UI', 'true')
  mocks.getProgressionOverview.mockResolvedValue(overview)
  mocks.getProgressionHistory.mockResolvedValue({ rows: [checkIn, reversal], hasMore: false })
  mocks.listTrackers.mockResolvedValue([tracker])
  mocks.listTrackerEntriesBetween.mockResolvedValue([entry])
  mocks.listAccountHolidays.mockResolvedValue([])
})

afterEach(() => { cleanup(); injectedStylesheet?.remove(); injectedStylesheet = null; vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('Progression achievements interface', () => {
  it('separates confirmed XP and pending rewards and shows the server level', async () => {
    renderPage()
    expect(await screen.findByText('125')).toBeInTheDocument()
    expect(screen.getByText('+10 XP pending sync')).toBeInTheDocument()
    expect(screen.getByText('LEVEL 2')).toBeInTheDocument()
    expect(screen.getByText('XP reconstructed from past activity')).toBeInTheDocument()
    expect(screen.getByText('25 of 200 XP to level 3')).toBeInTheDocument()
  })

  it('keeps provisional XP clearly pending while the device is offline', async () => {
    mocks.auth.isOnline = false
    mocks.auth.syncStatus = 'offline'
    renderPage()
    expect(await screen.findByText('+10 XP pending sync')).toBeInTheDocument()
    expect(screen.getByText('Saved on this device; confirmation will follow when synchronization completes.')).toBeInTheDocument()
    expect(screen.getByText('125')).toBeInTheDocument()
  })

  it('opens paginated history with date filters and shows reversals and anonymized sources', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /125 confirmed XP/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Score history' })
    expect(within(dialog).getByRole('group', { name: 'Filter score history by date' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '90 days' }))
    expect(mocks.getProgressionHistory).toHaveBeenLastCalledWith('account-1', 0, 30)
    expect(within(dialog).getByText('Award reversed')).toBeInTheDocument()
    expect(within(dialog).getByText('Deleted tracker')).toBeInTheDocument()
    expect(within(dialog).getByText(/Reverses qualifying check-in/)).toBeInTheDocument()
    expect(within(dialog).getByText('Pending server confirmation')).toBeInTheDocument()
  })

  it('renders history in a fixed blurred viewport overlay and closes on outside tap', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /125 confirmed XP/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Score history' })
    const backdrop = dialog.closest('.progression-dialog-backdrop') as HTMLElement
    expect(backdrop.parentElement).toBe(document.body)
    expect(getComputedStyle(backdrop).position).toBe('fixed')
    expect(getComputedStyle(backdrop).display).toBe('flex')
    expect(getComputedStyle(backdrop).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(backdrop).toHaveClass('modal-backdrop')
    expect(appStyles).toMatch(/\.modal-backdrop\s*\{[^}]*-webkit-backdrop-filter:\s*blur\(7px\)[^}]*backdrop-filter:\s*blur\(7px\)/s)
    expect(getComputedStyle(dialog.querySelector('.progression-dialog-content')!).overflowY).toBe('auto')
    expect(document.body.style.overflow).toBe('hidden')
    await user.click(backdrop)
    expect(screen.queryByRole('dialog', { name: 'Score history' })).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
  })

  it('keeps long score histories in the independently scrollable dialog content', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ ...checkIn, id: `history-${index}`, sourceId: `entry-${index}` }))
    mocks.getProgressionHistory.mockResolvedValueOnce({ rows, hasMore: false })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /125 confirmed XP/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Score history' })
    const content = dialog.querySelector('.progression-dialog-content') as HTMLElement
    expect(getComputedStyle(content).overflowY).toBe('auto')
    expect(within(content).getAllByText('Qualifying check-in')).toHaveLength(50)
  })

  it('shows consistency details with eligible-day adherence and exclusions', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /Consistency score 75/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Consistency' })
    expect(within(dialog).getByText('75%')).toBeInTheDocument()
    expect(within(dialog).getByText(/completed trackers divided by eligible trackers/)).toBeInTheDocument()
    expect(within(dialog).getByText('What is excluded?')).toBeInTheDocument()
  })

  it('shows streak progress, upcoming and earned milestone rewards, and goal details link', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /active streaks, view streak details/i }))
    const streakDialog = await screen.findByRole('dialog', { name: 'Streaks & recent activity' })
    expect(within(streakDialog).getByText(/Next streak milestone:/)).toBeInTheDocument()
    expect(within(streakDialog).getByText(/\+35 XP/)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: /1 milestone rewards/ }))
    const milestoneDialog = await screen.findByRole('dialog', { name: 'Milestone rewards' })
    expect(within(milestoneDialog).getByText('Streak milestone')).toBeInTheDocument()
    await user.click(within(milestoneDialog).getByRole('link', { name: 'Goals & planning' }))
    expect(screen.queryByRole('dialog', { name: 'Milestone rewards' })).not.toBeInTheDocument()
  })

  it('separates current active streaks from archived historical streaks', async () => {
    const archivedDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const archived: StoredTrackerDefinition = { ...tracker, id: 'archived-1', name: 'Old reading routine', status: 'archived', archivedAt: `${archivedDate}T12:00:00.000Z` }
    const archivedEntry: StoredTrackerEntry = { ...entry, id: 'archived-entry', trackerId: archived.id, date: archivedDate, createdAt: `${archivedDate}T10:00:00.000Z`, updatedAt: `${archivedDate}T10:00:00.000Z` }
    mocks.listTrackers.mockResolvedValueOnce([tracker, archived])
    mocks.listTrackerEntriesBetween.mockResolvedValueOnce([entry, archivedEntry])
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /active streaks, view streak details/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Streaks & recent activity' })
    expect(within(dialog).getByRole('group', { name: 'Filter streak history' })).toBeInTheDocument()
    expect(within(dialog).getByText('Read each day')).toBeInTheDocument()
    expect(within(dialog).queryByText('Old reading routine')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Archived' }))
    expect(within(dialog).getByText('Old reading routine')).toBeInTheDocument()
    expect(within(dialog).getByText(/Last qualifying activity:/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/current|next streak milestone/i)).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Archived' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens earned and locked badge details with requirements and unlock history', async () => {
    const user = userEvent.setup()
    renderPage()
    const earnedBadge = await screen.findByRole('button', { name: /First Step, earned/ })
    await user.click(earnedBadge)
    const dialog = await screen.findByRole('dialog', { name: 'First Step' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveClass('progression-dialog')
    expect(within(dialog).getByText('Earned')).toBeInTheDocument()
    expect(within(dialog).getByText('Save one qualifying check-in.')).toBeInTheDocument()
    expect(within(dialog).getByText(/Unlocked · First award/)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'First Step' })).not.toBeInTheDocument()
    expect(earnedBadge).toHaveFocus()
    const lockedBadge = screen.getByRole('button', { name: /Dedicated, locked/ })
    expect(lockedBadge).toHaveTextContent('Save 100 qualifying check-ins')
    expect(lockedBadge).toHaveTextContent('23 / 100 check-ins')
    await user.click(lockedBadge)
    expect(await screen.findByRole('dialog', { name: 'Dedicated' })).toHaveTextContent('23 / 100 check-ins')
  })

  it('distinguishes unavailable historical XP from a zero XP balance', async () => {
    mocks.getProgressionOverview.mockResolvedValueOnce({ ...overview, legacyXpStatus: 'unavailable', confirmedXp: 0, officialLevel: { level: 1, currentLevelXp: 0, nextLevelXp: 100, progressXp: 0, requiredXp: 100 }, provisionalXp: 0, provisionalRewards: [], scoreHistory: [], streakHistory: [] })
    renderPage()
    expect(await screen.findByText('Historical XP unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Level 1, 0 confirmed XP/ })).toBeInTheDocument()
    expect(screen.queryByText('XP reconstructed from past activity')).not.toBeInTheDocument()
  })

  it('shows live loading failures with retry instead of rendering zero values', async () => {
    mocks.getProgressionOverview.mockRejectedValueOnce(new Error('offline'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    expect(screen.queryByText('0 XP')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('identifies missing progression schema and exposes the failed resource', async () => {
    const user = userEvent.setup()
    mocks.getProgressionOverview.mockRejectedValueOnce(new Error('progression_events (confirmed XP) request failed PGRST205: table not found'))
    renderPage()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('does not expose a required progression table')
    await user.click(within(alert).getByText('Technical details'))
    expect(alert).toHaveTextContent('progression_events (confirmed XP) request failed PGRST205')
    expect(alert).toHaveTextContent('Apply the progression migrations')
  })

  it('distinguishes an authorization failure from missing connectivity', async () => {
    mocks.getProgressionOverview.mockRejectedValueOnce(new Error('progression_achievement_progress request failed 42501: permission denied'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Supabase rejected a progression read')
  })

  it('keeps the loading state visible while authoritative data is still being fetched', async () => {
    let resolveOverview!: (value: ProgressionOverview) => void
    mocks.getProgressionOverview.mockReturnValueOnce(new Promise<ProgressionOverview>((resolve) => { resolveOverview = resolve }))
    renderPage()
    expect(screen.getByRole('status')).toHaveTextContent('Loading your confirmed progress')
    resolveOverview(overview)
    expect(await screen.findByText('125')).toBeInTheDocument()
  })

  it('shows an empty consistency state instead of inventing a score or history', async () => {
    const user = userEvent.setup()
    mocks.getProgressionOverview.mockResolvedValueOnce({ ...overview, confirmedXp: 0, officialLevel: { level: 1, currentLevelXp: 0, nextLevelXp: 100, progressXp: 0, requiredXp: 100 }, provisionalXp: 0, provisionalRewards: [], scoreHistory: [], streakHistory: [], consistency: { score: null, eligibleDays: 0, dailyAdherence: [] } })
    mocks.getProgressionHistory.mockResolvedValue({ rows: [], hasMore: false })
    renderPage()
    await user.click(await screen.findByRole('button', { name: /Consistency score not available/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Consistency' })
    expect(within(dialog).getByText('No eligible history is available yet.')).toBeInTheDocument()
    expect(within(dialog).getByText('No eligible days yet')).toBeInTheDocument()
    expect(within(dialog).getByText(/Consistency becomes measurable after an eligible tracker day is completed/)).toBeInTheDocument()
    expect(within(dialog).queryByText('0%')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: /Level 1, 0 confirmed XP/ }))
    expect(await screen.findByRole('dialog', { name: 'Score history' })).toHaveTextContent('No score history yet')
  })

  it('keeps the recently unlocked empty state concise when nothing is server-confirmed', async () => {
    const lockedAchievements = overview.achievements.map((badge) => ({ ...badge, progress: 0, currentTier: 0, earned: false, unlockedAt: null, history: [] }))
    mocks.getProgressionOverview.mockResolvedValueOnce({ ...overview, achievements: lockedAchievements })
    renderPage()
    expect(await screen.findByText('Your first confirmed badge will appear here when earned.')).toBeInTheDocument()
    expect(screen.queryByText(/first badge will be unlocked/i)).not.toBeInTheDocument()
  })

  it('retains the established Achievements screen while the progression flag is off', async () => {
    vi.stubEnv('VITE_ENABLE_PROGRESSION_UI', 'false')
    renderPage()
    expect(await screen.findByText('Reward points')).toBeInTheDocument()
    expect(screen.queryByText('CONFIRMED XP')).not.toBeInTheDocument()
  })
})
