import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'
import type { ProgressionOverview } from '../../services/supabase/progressionRepository'
import appStyles from '../../styles.css?raw'
import { AchievementsPage } from './AchievementsPage'
import { achievementDefinition } from './achievementCatalog'

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
  activeAchievementOccurrences: (history: Array<{ id: string; eventType: string; reversesEventId: string | null }>) => {
    const reversed = new Set(history.filter((event) => event.eventType === 'revoked' && event.reversesEventId).map((event) => event.reversesEventId))
    return [...new Map(history.filter((event) => event.eventType === 'unlocked' && !reversed.has(event.id)).map((event) => [event.id, event])).values()]
  },
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
const checkIn = { id: 'xp-1', effectiveDate: today, recordedAt: `${today}T10:00:00.000Z`, xpDelta: 10, eventCategory: 'check_in', reasonCode: 'DAILY_CHECK_IN_COMPLETED', reversesEventId: null, sourceId: entry.id, trackerId: tracker.id, goalId: null, displayName: 'Read each day', deletedTracker: false }
const reversal = { id: 'reverse-1', effectiveDate: today, recordedAt: `${today}T11:00:00.000Z`, xpDelta: -10, eventCategory: 'reversal', reasonCode: 'AWARD_REVERSAL', reversesEventId: checkIn.id, sourceId: entry.id, trackerId: null, goalId: null, displayName: 'Deleted tracker', deletedTracker: false }
const streakAward = { id: 'streak-1', effectiveDate: today, recordedAt: `${today}T12:00:00.000Z`, xpDelta: 35, eventCategory: 'streak_milestone', reasonCode: 'STREAK_MILESTONE', reversesEventId: null, sourceId: null, trackerId: tracker.id, goalId: null, displayName: 'Read each day', deletedTracker: false }
const overview: ProgressionOverview = {
  legacyXpStatus: 'reconstructed',
  confirmedXp: 125,
  officialLevel: { level: 2, currentLevelXp: 100, nextLevelXp: 300, progressXp: 25, requiredXp: 200 },
  provisionalXp: 10,
  provisionalRewards: [{ id: 'check-in:entry-pending', effectiveDate: today, xpDelta: 10 }],
  scoreHistory: [checkIn, reversal, streakAward], streakHistory: [streakAward],
  consistency: { score: 75, eligibleDays: 2, dailyAdherence: [{ date: today, completed: 1, eligible: 1 }, { date: '2026-10-12', completed: 1, eligible: 2 }] },
  achievements: [
    { achievementId: 'first-step', progress: 1, target: 1, currentTier: 1, repeatable: false, earned: true, unlockedAt: `${today}T11:00:00.000Z`, history: [{ id: 'unlock-1', achievementId: 'first-step', tier: 1, generation: 1, eventType: 'unlocked', recordedAt: `${today}T11:00:00.000Z`, sourceEventId: checkIn.id, sourceDate: today, reversesEventId: null, retainedAfterTrackerDeletion: false, trackerDisplayName: null, rewardReasonCode: null, rewardXpDelta: null }], qualificationDetails: {} },
    { achievementId: 'dedicated', progress: 23, target: 100, currentTier: 0, repeatable: false, earned: false, unlockedAt: null, history: [], qualificationDetails: {} },
  ],
}

function overviewWithConsistency(details: NonNullable<ProgressionOverview['achievements'][number]['qualificationDetails']>, earned = false): ProgressionOverview {
  const badge = {
    achievementId: 'consistency-star', progress: details.adherence_percent ?? 0, target: 80, currentTier: earned ? 1 : 0,
    repeatable: false, earned, unlockedAt: earned ? `${today}T12:00:00.000Z` : null,
    history: earned ? [{ id: 'consistency-unlock', achievementId: 'consistency-star', tier: 1, generation: 1, eventType: 'unlocked' as const, recordedAt: `${today}T12:00:00.000Z`, sourceEventId: checkIn.id, sourceDate: today, reversesEventId: null, retainedAfterTrackerDeletion: false, trackerDisplayName: null, rewardReasonCode: null, rewardXpDelta: null }] : [],
    qualificationDetails: details,
  }
  return { ...overview, achievements: [...overview.achievements, badge] }
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
  it('keeps badge definitions free of duplicated cadence classifications', () => {
    expect('repeatable' in (achievementDefinition('dedicated') ?? {})).toBe(false)
    expect('awardCadence' in (achievementDefinition('perfect-day') ?? {})).toBe(false)
  })

  it('shows authoritative eligible-day and adherence progress separately for an incomplete window', async () => {
    const user = userEvent.setup()
    mocks.getProgressionOverview.mockResolvedValueOnce(overviewWithConsistency({
      status: 'in_progress', label: 'Consistency Star qualification', eligible_days: 18, eligible_days_target: 30,
      adherence_percent: 80, adherence_target_percent: 80,
    }))
    renderPage()
    const card = await screen.findByRole('button', { name: /Consistency Star, locked/i })
    expect(card).toHaveTextContent('Eligible days: 18 / 30')
    expect(card).toHaveTextContent('Adherence: 80% (target: 80%)')
    expect(card).not.toHaveTextContent('80% / 80%')
    expect(card.querySelector('.progression-level-track')).toBeNull()

    await user.click(card)
    const dialog = await screen.findByRole('dialog', { name: 'Consistency Star' })
    expect(dialog).toHaveTextContent('Eligible days: 18 / 30')
    expect(dialog).toHaveTextContent('Adherence: 80% (target: 80%)')
    expect(dialog.querySelector('.progression-level-track')).toBeNull()
  })

  it('keeps a complete day window visibly unqualified when adherence is below target', async () => {
    mocks.getProgressionOverview.mockResolvedValueOnce(overviewWithConsistency({
      status: 'in_progress', label: 'Consistency Star qualification', eligible_days: 30, eligible_days_target: 30,
      adherence_percent: 79.5, adherence_target_percent: 80,
    }))
    renderPage()
    const card = await screen.findByRole('button', { name: /Consistency Star, locked/i })
    expect(card).toHaveTextContent('Eligible days: 30 / 30')
    expect(card).toHaveTextContent('Adherence: 79.5% (target: 80%)')
    expect(card.querySelector('.progression-level-track')).toBeNull()
  })

  it('shows complete server qualification details for an unlocked Consistency Star', async () => {
    const user = userEvent.setup()
    mocks.getProgressionOverview.mockResolvedValueOnce(overviewWithConsistency({
      status: 'qualified', label: 'Consistency Star qualification', eligible_days: 30, eligible_days_target: 30,
      adherence_percent: 82.3, adherence_target_percent: 80,
    }, true))
    renderPage()
    const card = await screen.findByRole('button', { name: /Consistency Star, earned/i })
    expect(card).toHaveTextContent('Unlocked')
    expect(card).not.toHaveTextContent('80% / 80%')
    await user.click(card)
    const dialog = await screen.findByRole('dialog', { name: 'Consistency Star' })
    expect(dialog).toHaveTextContent('Eligible days: 30 / 30')
    expect(dialog).toHaveTextContent('Adherence: 82.3% (target: 80%)')
  })

  it('separates confirmed XP and pending rewards and shows the server level', async () => {
    renderPage()
    expect(await screen.findByText('125')).toBeInTheDocument()
    expect(screen.getByText('+10 XP pending sync')).toBeInTheDocument()
    expect(screen.getByText('LEVEL 2')).toBeInTheDocument()
    expect(screen.getByText('XP reconstructed from past activity')).toBeInTheDocument()
    expect(screen.getByText('25 of 200 XP this level · 175 XP to level 3')).toBeInTheDocument()
  })

  it('explains XP rewards, reversals, pending confirmation, and exact level thresholds', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'XP and level information' }))
    const dialog = await screen.findByRole('dialog', { name: 'How XP and levels work' })
    expect(dialog).toHaveTextContent('Qualifying check-in: 10 XP')
    expect(dialog).toHaveTextContent('Perfect Day: 20 XP')
    expect(dialog).toHaveTextContent('Goal milestone: 25 XP')
    expect(dialog).toHaveTextContent('Completed goal: 100 XP')
    expect(dialog).toHaveTextContent('50 × (L − 1) × L')
    expect(dialog).toHaveTextContent('Reversals reduce net XP and can lower your level')
    expect(dialog).toHaveTextContent('Offline XP stays pending until the server confirms it')
    expect(dialog).toHaveTextContent('Level 2 · 175 XP to the next level')
    expect(dialog).toHaveTextContent('Level 20')
    expect(dialog).toHaveTextContent('19,000 XP')
  })

  it('opens per-badge information with exact requirement and a reliable percentage meter', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'More about Dedicated' }))
    const dialog = await screen.findByRole('dialog', { name: 'Dedicated badge information' })
    expect(dialog).toHaveTextContent('Reach 100 qualifying saved check-ins.')
    expect(dialog).toHaveTextContent('Current progress: 23 / 100 check-ins.')
    expect(dialog).toHaveTextContent('23%')
    expect(dialog.querySelector('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '23')
  })

  it('keeps provisional XP clearly pending while the device is offline', async () => {
    mocks.auth.isOnline = false
    mocks.auth.syncStatus = 'offline'
    renderPage()
    expect(await screen.findByText('+10 XP pending sync')).toBeInTheDocument()
    expect(screen.getByText('Saved on this device; confirmation will follow when synchronization completes.')).toBeInTheDocument()
    expect(screen.getByText('125')).toBeInTheDocument()
  })

  it('renders retained Wins with recorded tracker context and a non-navigable deletion tag', async () => {
    const user = userEvent.setup()
    const retainedUnlock = {
      ...overview.achievements[0]!,
      history: overview.achievements[0]!.history.map((event) => ({
        ...event, sourceEventId: null, retainedAfterTrackerDeletion: true, trackerDisplayName: 'Read each day',
        rewardReasonCode: 'DAILY_CHECK_IN_COMPLETED', rewardXpDelta: 10,
      })),
    }
    const retainedStreak = { ...streakAward, trackerId: null, displayName: 'Read each day', deletedTracker: true }
    const retainedHistory = [retainedStreak]
    mocks.getProgressionOverview.mockResolvedValueOnce({
      ...overview,
      scoreHistory: retainedHistory,
      streakHistory: retainedHistory,
      achievements: [retainedUnlock, overview.achievements[1]!],
    })
    mocks.getProgressionHistory.mockResolvedValueOnce({ rows: retainedHistory, hasMore: false })
    mocks.listTrackers.mockResolvedValueOnce([])
    mocks.listTrackerEntriesBetween.mockResolvedValueOnce([])

    renderPage()

    expect(await screen.findByText('125')).toBeInTheDocument()
    expect(screen.getByText('LEVEL 2')).toBeInTheDocument()
    expect(screen.getByText('Streak milestone')).toBeInTheDocument()
    expect(screen.getByText('Read each day')).toBeInTheDocument()
    expect(screen.getByText('Deleted tracker')).toBeInTheDocument()
    const rewardLine = screen.getByText('Streak milestone').closest('li')!
    expect(rewardLine.querySelector('a')).toBeNull()
    expect(rewardLine.querySelector('.progression-deleted-tracker-tag')).toHaveTextContent('Deleted tracker')
    const badge = screen.getByRole('button', { name: /First Step, earned/ })
    await user.click(badge)
    const dialog = await screen.findByRole('dialog', { name: 'First Step' })
    expect(within(dialog).getByText(/Retained historical achievement/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Unlocked.*First award/)).toBeInTheDocument()
    expect(within(dialog).getByText('Read each day')).toBeInTheDocument()
    expect(within(dialog).getByText('Earned for: Qualifying check-in')).toBeInTheDocument()
    expect(within(dialog).getByText('Deleted tracker')).toBeInTheDocument()
    const earnedTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date(`${today}T11:00:00.000Z`))
    expect(within(dialog).getByText(earnedTimestamp)).toBeInTheDocument()
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
    const activeReward = within(dialog).getByText('Qualifying check-in').closest('li')!
    expect(activeReward.querySelector('.progression-deleted-tracker-tag')).toBeNull()
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
    expect(within(dialog).getByText('Unlocked')).toBeInTheDocument()
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

  it('uses the server cadence and valid count supplied in the shared achievement state', async () => {
    const dedicated = { ...overview.achievements[1]!, progress: 200, currentTier: 2, repeatable: true, earned: true, validAwardCount: 2, unlockedAt: `${today}T11:00:00.000Z` }
    const momentum = { ...overview.achievements[1]!, achievementId: 'momentum', progress: 0, target: 3, repeatable: false }
    const firstFlameState = { ...momentum, achievementId: 'first-flame', target: 7 }
    mocks.getProgressionOverview.mockResolvedValueOnce({ ...overview, achievements: [overview.achievements[0]!, momentum, firstFlameState, dedicated] })
    renderPage()

    const momentumBadge = await screen.findByRole('button', { name: /Momentum, locked/ })
    expect(momentumBadge.querySelector('.badge-threshold-value')).toHaveTextContent('3')
    expect(momentumBadge.querySelector('.badge-threshold-unit')).toHaveTextContent('DAYS')
    const firstFlame = screen.getByRole('button', { name: /First Flame, locked/ })
    expect(firstFlame.querySelector('.badge-threshold-value')).toHaveTextContent('7')
    const repeatableBadge = screen.getByRole('button', { name: /Dedicated, earned/ })
    expect(repeatableBadge.querySelector('.badge-threshold-value')).toHaveTextContent('100')
    expect(repeatableBadge).toHaveTextContent('Unlocked')
    expect(repeatableBadge).toHaveTextContent('Earned 2 times')
    expect(repeatableBadge).not.toHaveTextContent('×2 earned')
    expect(screen.getByRole('button', { name: '2 distinct badge types unlocked. Show all badges' })).toHaveTextContent('2 unlocked')
    expect(appStyles).toContain('.progression-overview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }')
  })

  it('opens a modal containing only active unlocked badges from the whole card button', async () => {
    const user = userEvent.setup()
    renderPage()
    const card = await screen.findByRole('button', { name: /distinct badge types unlocked\. Show all badges/ })
    card.focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'All badges' })
    expect(dialog).toHaveTextContent('First Step')
    expect(dialog).not.toHaveTextContent('Momentum')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'All badges' })).not.toBeInTheDocument()
  })

  it('counts unique valid repeatable awards and shows their latest award date and occurrence history', async () => {
    const unlocked = (id: string, tier: number, sourceDate: string) => ({ id, achievementId: 'perfect-week', tier, generation: 1, eventType: 'unlocked' as const, recordedAt: `${sourceDate}T12:00:00.000Z`, sourceEventId: null, sourceDate, reversesEventId: null, retainedAfterTrackerDeletion: false, trackerDisplayName: null, rewardReasonCode: null, rewardXpDelta: null })
    const first = unlocked('week-1', 1, '2026-09-06')
    const second = unlocked('week-2', 2, '2026-09-13')
    const reversed = unlocked('week-3', 3, '2026-09-20')
    const badge = { achievementId: 'perfect-week', progress: 2, target: 1, currentTier: 2, repeatable: true, earned: true, unlockedAt: `${today}T12:00:00.000Z`, history: [first, second, second, reversed, { ...reversed, id: 'week-3-reversal', eventType: 'revoked' as const, reversesEventId: 'week-3' }] }
    mocks.getProgressionOverview.mockResolvedValueOnce({ ...overview, achievements: [overview.achievements[0]!, overview.achievements[1]!, badge] })
    const user = userEvent.setup()
    renderPage()

    const card = await screen.findByRole('button', { name: /Perfect Week, earned/ })
    expect(card).toHaveTextContent('Earned 2 times')
    expect(card).not.toHaveTextContent('Earned 3 times')
    await user.click(card)
    const dialog = await screen.findByRole('dialog', { name: 'Perfect Week' })
    expect(dialog).toHaveTextContent('Earned 2 times')
    expect(dialog).toHaveTextContent('Most recent')
    expect(dialog).toHaveTextContent('Sep 13, 2026')
    expect(within(dialog).getByText(/Award 2/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Revoked · Award 3/)).toBeInTheDocument()
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
    expect(within(dialog).getByText(/Today’s eligible activity will count after the date closes in UTC/)).toBeInTheDocument()
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
