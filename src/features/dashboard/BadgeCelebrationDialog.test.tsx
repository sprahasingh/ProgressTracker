import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AchievementHistoryEvent } from '../../services/supabase/progressionRepository'

const mocks = vi.hoisted(() => ({ getBadges: vi.fn(), getXp: vi.fn(), getOverview: vi.fn(), subscribe: vi.fn() }))
let notifyProgressionChange: (() => void) | undefined
vi.mock('../../services/supabase/progressionRepository', () => ({
  getEarnedAndLockedBadges: mocks.getBadges,
  getAchievementAwardXp: mocks.getXp,
  getProgressionOverview: mocks.getOverview,
  subscribeToProgressionChanges: (_userId: string, listener: () => void) => { notifyProgressionChange = listener; mocks.subscribe(listener); return () => {} },
}))
vi.mock('../../components/ui/useModalLayer', () => ({ useModalLayer: vi.fn() }))
vi.mock('../../components/ui/useVisualViewportBounds', () => ({ useVisualViewportBounds: vi.fn() }))
vi.mock('../../components/ui/InfoButton', () => ({ InfoButton: ({ label }: { label: string }) => <button type="button" aria-label={label}>Info</button> }))
vi.mock('./ProgressionBadge', () => ({ ProgressionBadge: ({ achievementId }: { achievementId: string }) => <span>{achievementId} art</span> }))

import { BadgeCelebrationMonitor, badgeCelebrationLevel } from './BadgeCelebrationDialog'

const oldEvent = { id: 'old', achievementId: 'first-step', tier: 1, generation: 1, eventType: 'unlocked' as const, recordedAt: '2026-01-01T10:00:00Z', sourceEventId: null, sourceDate: '2026-01-01', reversesEventId: null, retainedAfterTrackerDeletion: false, trackerDisplayName: null, rewardReasonCode: null, rewardXpDelta: null }
const newEvent = { ...oldEvent, id: 'new', achievementId: 'momentum', recordedAt: new Date(Date.now() + 10_000).toISOString(), sourceDate: '2026-01-02' }

describe('BadgeCelebrationMonitor', () => {
  afterEach(cleanup)
  beforeEach(() => { localStorage.clear(); mocks.getBadges.mockReset().mockResolvedValue([]); mocks.getXp.mockReset().mockResolvedValue(new Map()); mocks.getOverview.mockReset().mockResolvedValue({ confirmedXp: 0, scoreHistory: [] }); mocks.subscribe.mockReset() })

  it('baselines historical XP, combines level jumps, ignores pending XP, and does not repeat a dismissed celebration', async () => {
    let confirmedXp = 0
    let history: Array<{ id: string; recordedAt: string }> = []
    mocks.getOverview.mockImplementation(async () => ({ confirmedXp, provisionalXp: 5000, scoreHistory: history }))
    render(<BadgeCelebrationMonitor userId="level-user" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:level-state:level-user')).toContain('"xp":0'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    confirmedXp = 650
    history = [{ id: 'confirmed-awards', recordedAt: '2026-04-02T10:00:00.000Z' }]
    notifyProgressionChange?.()
    const dialog = await screen.findByRole('dialog', { name: 'Level 4' })
    expect(dialog).toHaveTextContent('advanced from level 1 to level 4')
    expect(dialog).toHaveTextContent('650 confirmed XP')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    notifyProgressionChange?.()
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('updates the level after a confirmed reversal without celebrating and resumes an unacknowledged level-up after remount', async () => {
    let confirmedXp = 90
    let history: Array<{ id: string; recordedAt: string }> = [{ id: 'old-reward', recordedAt: '2026-04-01T10:00:00.000Z' }]
    mocks.getOverview.mockImplementation(async () => ({ confirmedXp, scoreHistory: history }))
    const view = render(<BadgeCelebrationMonitor userId="reversal-user" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:level-state:reversal-user')).toContain('"xp":90'))
    confirmedXp = 110
    history = [...history, { id: 'new-reward', recordedAt: '2026-04-02T10:00:00.000Z' }]
    notifyProgressionChange?.()
    expect(await screen.findByRole('dialog', { name: 'Level 2' })).toBeInTheDocument()
    view.unmount()

    render(<BadgeCelebrationMonitor userId="reversal-user" />)
    expect(await screen.findByRole('dialog', { name: 'Level 2' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    confirmedXp = 80
    history = [...history, { id: 'reversal', recordedAt: '2026-04-03T10:00:00.000Z' }]
    notifyProgressionChange?.()
    await waitFor(() => expect(localStorage.getItem('progress-tracker:level-state:reversal-user')).toContain('"xp":80'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('discards an older confirmed XP response that arrives after a newer ledger snapshot', async () => {
    let releaseOlder!: (value: { confirmedXp: number; scoreHistory: Array<{ id: string; recordedAt: string }> }) => void
    mocks.getOverview
      .mockResolvedValueOnce({ confirmedXp: 0, scoreHistory: [] })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOlder = resolve }))
      .mockResolvedValueOnce({ confirmedXp: 300, scoreHistory: [{ id: 'newest', recordedAt: '2026-04-03T10:00:00.000Z' }] })
    render(<BadgeCelebrationMonitor userId="ordered-user" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:level-state:ordered-user')).toContain('"xp":0'))

    notifyProgressionChange?.()
    await waitFor(() => expect(releaseOlder).toBeTypeOf('function'))
    notifyProgressionChange?.()
    expect(await screen.findByRole('dialog', { name: 'Level 3' })).toBeInTheDocument()
    releaseOlder({ confirmedXp: 200, scoreHistory: [{ id: 'older', recordedAt: '2026-04-02T10:00:00.000Z' }] })
    await waitFor(() => expect(localStorage.getItem('progress-tracker:level-state:ordered-user')).toContain('"xp":300'))
    expect(screen.getByRole('dialog', { name: 'Level 3' })).toHaveTextContent('advanced from level 1 to level 3')
  })

  it('selects grand first unlocks, repeat celebrations, and only the specified repeat milestones', () => {
    expect(badgeCelebrationLevel(false, 1)).toBe('first')
    expect(badgeCelebrationLevel(true, 1)).toBe('first')
    for (const occurrence of [5, 10, 25, 50, 100, 200]) expect(badgeCelebrationLevel(true, occurrence)).toBe('milestone')
    for (const occurrence of [2, 4, 6, 24, 51, 199]) expect(badgeCelebrationLevel(true, occurrence)).toBe('repeat')
    expect(badgeCelebrationLevel(false, 5)).toBe('first')
  })

  it('baselines old history and serially presents only newly confirmed events', async () => {
    let events = [oldEvent]
    mocks.getBadges.mockImplementation(async () => [{ achievementId: 'first-step', history: events }])
    render(<BadgeCelebrationMonitor userId="user-1" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:achievement-seen:user-1')).toContain('old'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    events = [oldEvent, newEvent, { ...newEvent, id: 'newer', tier: 2, sourceDate: '2026-01-03' }]
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled())
    notifyProgressionChange?.()
    expect(await screen.findByRole('heading', { name: 'Momentum' })).toBeInTheDocument()
    expect(screen.getByText('New Achievement Unlocked!')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('dialog').querySelector('button.button-primary')!)
    expect(await screen.findByText('Achievement Earned Again!')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    notifyProgressionChange?.()
    await waitFor(() => expect(mocks.getBadges).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('combines First Step and Perfect Day as one check-in confirmation arrives in separate refreshes', async () => {
    const firstStep = { ...oldEvent, id: 'first-step-new', achievementId: 'first-step', sourceDate: '2026-01-02', recordedAt: new Date(Date.now() + 10_000).toISOString() }
    const perfectDay = { ...firstStep, id: 'perfect-day-new', achievementId: 'perfect-day', sourceEventId: 'perfect-day-ledger-event' }
    let firstStepHistory: AchievementHistoryEvent[] = [oldEvent]
    let perfectDayHistory: AchievementHistoryEvent[] = []
    mocks.getBadges.mockImplementation(async () => [
      { achievementId: 'first-step', repeatable: false, history: firstStepHistory },
      { achievementId: 'perfect-day', repeatable: true, history: perfectDayHistory },
    ])
    const firstView = render(<BadgeCelebrationMonitor userId="first-checkin-user" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:achievement-seen:first-checkin-user')).toContain('old'))

    firstStepHistory = [oldEvent, firstStep]
    notifyProgressionChange?.()
    expect(await screen.findByRole('dialog', { name: 'First Step' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-pending:first-checkin-user') ?? '[]')).toContain(firstStep.id)

    perfectDayHistory = [perfectDay]
    notifyProgressionChange?.()
    const dialog = await screen.findByRole('dialog', { name: '2 achievements unlocked' })
    expect(dialog).toHaveTextContent('New Achievements Unlocked!')
    expect(within(dialog).getByRole('heading', { name: 'First Step' })).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { name: 'Perfect Day' })).toBeInTheDocument()
    expect(within(dialog).getByText('A meaningful beginning, built one check-in at a time.')).toBeInTheDocument()
    expect(within(dialog).getByText('Every eligible tracker was completed on one day.')).toBeInTheDocument()
    expect(within(dialog).getByText('first-step art')).toBeInTheDocument()
    expect(within(dialog).getByText('perfect-day art')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'About First Step celebration' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'About Perfect Day celebration' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-pending:first-checkin-user') ?? '[]')).toEqual(expect.arrayContaining([firstStep.id, perfectDay.id]))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-seen:first-checkin-user') ?? '[]')).toEqual(expect.arrayContaining([firstStep.id, perfectDay.id])))
    notifyProgressionChange?.()
    await waitFor(() => expect(mocks.getBadges).toHaveBeenCalledTimes(4))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    firstView.unmount()
    render(<BadgeCelebrationMonitor userId="first-checkin-user" />)
    await waitFor(() => expect(mocks.getBadges).toHaveBeenCalledTimes(5))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the info control beside the badge title and the close control separate', async () => {
    mocks.getBadges.mockResolvedValue([{ achievementId: 'consistency-star', history: [{ ...newEvent, achievementId: 'consistency-star' }] }])
    render(<BadgeCelebrationMonitor userId="user-1" />)
    const dialog = await screen.findByRole('dialog', { name: 'Consistency Star' })
    const titleRow = dialog.querySelector<HTMLElement>('.badge-celebration-title-row')!
    expect(within(titleRow).getByRole('heading', { name: 'Consistency Star' })).toBeInTheDocument()
    expect(within(titleRow).getByRole('button', { name: 'About this celebration' })).toBeInTheDocument()
    expect(dialog.querySelector('.badge-celebration-close')).toHaveAttribute('aria-label', 'Close celebration')
    expect(titleRow.contains(dialog.querySelector('.badge-celebration-close'))).toBe(false)
  })

  it('does not baseline an award committed while the initial history read is in flight', async () => {
    let resolveInitial!: (value: Array<{ achievementId: string; history: AchievementHistoryEvent[] }>) => void
    mocks.getBadges
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve }))
      .mockResolvedValueOnce([{ achievementId: 'first-step', history: [oldEvent, newEvent] }])
    render(<BadgeCelebrationMonitor userId="user-1" />)
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled())

    notifyProgressionChange?.()
    expect(await screen.findByRole('heading', { name: 'Momentum' })).toBeInTheDocument()
    resolveInitial([{ achievementId: 'first-step', history: [oldEvent, newEvent] }])
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    expect(screen.getByText('New Achievement Unlocked!')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-seen:user-1') ?? '[]')).not.toContain('new')
    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-pending:user-1') ?? '[]')).toContain('new')
  })

  it('persists acknowledgement only after the celebration is dismissed', async () => {
    mocks.getBadges.mockResolvedValue([{ achievementId: 'first-step', history: [oldEvent] }])
    render(<BadgeCelebrationMonitor userId="user-1" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:achievement-seen:user-1')).toEqual('["old"]'))

    mocks.getBadges.mockResolvedValue([{ achievementId: 'momentum', history: [newEvent] }])
    notifyProgressionChange?.()
    expect(await screen.findByRole('heading', { name: 'Momentum' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-seen:user-1') ?? '[]')).not.toContain('new')
    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-pending:user-1') ?? '[]')).toContain('new')
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-seen:user-1') ?? '[]')).toContain('new'))
  })

  it('celebrates a server-confirmed requalification as a new event while retaining prior acknowledgement', async () => {
    const revoked = { ...oldEvent, id: 'old-revoked', eventType: 'revoked' as const, reversesEventId: oldEvent.id }
    const requalified = { ...oldEvent, id: 'requalified', generation: 2, recordedAt: new Date(Date.now() + 10_000).toISOString() }
    mocks.getBadges.mockResolvedValue([{ achievementId: 'first-step', history: [oldEvent] }])
    render(<BadgeCelebrationMonitor userId="user-1" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:achievement-seen:user-1')).toContain('old'))

    mocks.getBadges.mockResolvedValue([{ achievementId: 'first-step', history: [oldEvent, revoked, requalified] }])
    notifyProgressionChange?.()
    expect(await screen.findByRole('dialog', { name: 'First Step' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-seen:user-1') ?? '[]')).toContain('old')
    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-pending:user-1') ?? '[]')).toContain('requalified')
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-seen:user-1') ?? '[]')).toContain('requalified'))
  })

  it('does not mark an award seen when a newer refresh supersedes pending XP attribution', async () => {
    let events: AchievementHistoryEvent[] = [oldEvent]
    mocks.getBadges.mockImplementation(async () => [{ achievementId: 'first-step', history: events }])
    render(<BadgeCelebrationMonitor userId="user-1" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:achievement-seen:user-1')).toContain('old'))

    events = [oldEvent, { ...newEvent, sourceEventId: 'stale-xp-source' }]
    let releaseStale!: (value: Map<string, number>) => void
    mocks.getXp.mockImplementationOnce(() => new Promise<Map<string, number>>((resolve) => { releaseStale = resolve }))
    mocks.getXp.mockResolvedValue(new Map())
    notifyProgressionChange?.()
    expect(await screen.findByRole('heading', { name: 'Momentum' })).toBeInTheDocument()
    expect(releaseStale).toBeTypeOf('function')
    notifyProgressionChange?.()

    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-seen:user-1') ?? '[]')).not.toContain('new')
    expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-pending:user-1') ?? '[]')).toContain('new')
    releaseStale(new Map())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('presents a confirmed award while optional XP attribution is still pending', async () => {
    let events: AchievementHistoryEvent[] = [oldEvent]
    mocks.getBadges.mockImplementation(async () => [{ achievementId: 'first-step', history: events }])
    render(<BadgeCelebrationMonitor userId="user-1" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:achievement-seen:user-1')).toContain('old'))

    let resolveXp!: (value: Map<string, number>) => void
    mocks.getXp.mockImplementation(() => new Promise<Map<string, number>>((resolve) => { resolveXp = resolve }))
    events = [oldEvent, { ...newEvent, id: 'slow-xp', sourceEventId: 'reward-event-1' }]
    notifyProgressionChange?.()

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).not.toHaveTextContent('+10 XP confirmed')
    resolveXp(new Map([['reward-event-1', 10]]))
    expect(await screen.findByText('+10 XP confirmed')).toBeInTheDocument()
  })

  it('removes a queued unlock if the server reverses it before presentation completes', async () => {
    let events: AchievementHistoryEvent[] = [oldEvent]
    mocks.getBadges.mockImplementation(async () => [{ achievementId: 'first-step', history: events }])
    render(<BadgeCelebrationMonitor userId="user-1" />)
    await waitFor(() => expect(localStorage.getItem('progress-tracker:achievement-seen:user-1')).toContain('old'))

    events = [oldEvent, newEvent]
    notifyProgressionChange?.()
    expect(await screen.findByRole('heading', { name: 'Momentum' })).toBeInTheDocument()

    events = [oldEvent, newEvent, { ...newEvent, id: 'undo-new', eventType: 'revoked', reversesEventId: newEvent.id }]
    notifyProgressionChange?.()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Momentum' })).not.toBeInTheDocument()

    notifyProgressionChange?.()
    await waitFor(() => expect(mocks.getBadges).toHaveBeenCalledTimes(4))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
