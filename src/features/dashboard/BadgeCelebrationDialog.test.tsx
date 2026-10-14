import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AchievementHistoryEvent } from '../../services/supabase/progressionRepository'

const mocks = vi.hoisted(() => ({ getBadges: vi.fn(), getXp: vi.fn(), subscribe: vi.fn() }))
let notifyProgressionChange: (() => void) | undefined
vi.mock('../../services/supabase/progressionRepository', () => ({
  getEarnedAndLockedBadges: mocks.getBadges,
  getAchievementAwardXp: mocks.getXp,
  subscribeToProgressionChanges: (_userId: string, listener: () => void) => { notifyProgressionChange = listener; mocks.subscribe(listener); return () => {} },
}))
vi.mock('../../components/ui/useModalLayer', () => ({ useModalLayer: vi.fn() }))
vi.mock('../../components/ui/useVisualViewportBounds', () => ({ useVisualViewportBounds: vi.fn() }))
vi.mock('../../components/ui/InfoButton', () => ({ InfoButton: ({ label }: { label: string }) => <button type="button" aria-label={label}>Info</button> }))
vi.mock('./ProgressionBadge', () => ({ ProgressionBadge: ({ achievementId }: { achievementId: string }) => <span>{achievementId} art</span> }))

import { BadgeCelebrationMonitor } from './BadgeCelebrationDialog'

const oldEvent = { id: 'old', achievementId: 'first-step', tier: 1, generation: 1, eventType: 'unlocked' as const, recordedAt: '2026-01-01T10:00:00Z', sourceEventId: null, sourceDate: '2026-01-01', reversesEventId: null, retainedAfterTrackerDeletion: false, trackerDisplayName: null, rewardReasonCode: null, rewardXpDelta: null }
const newEvent = { ...oldEvent, id: 'new', achievementId: 'momentum', recordedAt: new Date(Date.now() + 10_000).toISOString(), sourceDate: '2026-01-02' }

describe('BadgeCelebrationMonitor', () => {
  afterEach(cleanup)
  beforeEach(() => { localStorage.clear(); mocks.getBadges.mockReset(); mocks.getXp.mockReset().mockResolvedValue(new Map()); mocks.subscribe.mockReset() })

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
    expect(screen.getByText('First unlock')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('dialog').querySelector('button.button-primary')!)
    expect(await screen.findByText('Achievement unlocked')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    notifyProgressionChange?.()
    await waitFor(() => expect(mocks.getBadges).toHaveBeenCalledTimes(3))
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
    expect(screen.getByText('First unlock')).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('progress-tracker:achievement-seen:user-1') ?? '[]')).toContain('new'))
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
    expect(await screen.findByText('+10 XP confirmed · listed in your reward history')).toBeInTheDocument()
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
