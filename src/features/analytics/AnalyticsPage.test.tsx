import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import type { ProgressionOverview } from '../../services/supabase/progressionRepository'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { AnalyticsPage } from './AnalyticsPage'
import appStyles from '../../styles.css?raw'
import themeTokens from '../../styles/tokens.css?raw'

const analyticsMocks = vi.hoisted(() => ({
  auth: { signedIn: false },
  getProgressionOverview: vi.fn(),
}))

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({
  status: analyticsMocks.auth.signedIn ? 'signed-in' : 'local-only',
  user: analyticsMocks.auth.signedIn ? { id: 'analytics-account' } : null,
  workspaceStatus: 'ready', workspaceUserId: analyticsMocks.auth.signedIn ? 'analytics-account' : null, sessionTransitionPending: false,
}) }))
vi.mock('../../services/supabase/progressionRepository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/supabase/progressionRepository')>()),
  getProgressionOverview: analyticsMocks.getProgressionOverview,
}))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); analyticsMocks.auth.signedIn = false; analyticsMocks.getProgressionOverview.mockReset(); await db.delete() })

function progressionFixture(date: string, entryId: string): ProgressionOverview {
  const score = (id: string, xpDelta: number, trackerId: string | null, sourceId: string | null) => ({
    id, userId: 'analytics-account', effectiveDate: date, recordedAt: `${date}T12:00:00.000Z`, xpDelta,
    eventCategory: 'check_in', reasonCode: 'DAILY_CHECK_IN_COMPLETED', reversesEventId: null, sourceId,
    trackerId, goalId: null, displayName: 'Progress reward', deletedTracker: false,
  })
  const history = [1, 2].map((tier) => ({
    id: `badge-${tier}`, achievementId: 'dedicated', tier, generation: tier, eventType: 'unlocked' as const,
    recordedAt: `${date}T12:00:00.000Z`, sourceEventId: 'tracker-reward', sourceDate: date,
    reversesEventId: null, retainedAfterTrackerDeletion: false, trackerDisplayName: null,
    rewardReasonCode: null, rewardXpDelta: null,
  }))
  return {
    legacyXpStatus: 'new_account', confirmedXp: 14,
    officialLevel: { level: 1, currentLevelXp: 0, nextLevelXp: 100, progressXp: 14, requiredXp: 100 },
    provisionalXp: 10, provisionalRewards: [{ id: `check-in:${entryId}`, effectiveDate: date, xpDelta: 10 }],
    scoreHistory: [score('tracker-reward', 10, definition.id, entryId), score('account-reward', 4, null, null)],
    streakHistory: [], consistency: { score: null, eligibleDays: 0, dailyAdherence: [] },
    achievements: [{ achievementId: 'dedicated', progress: 100, target: 100, currentTier: 2, validAwardCount: 2, repeatable: true, earned: true, unlockedAt: `${date}T12:00:00.000Z`, history, qualificationDetails: {} }],
  }
}

const definition: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'analytics-run', name: 'Morning run', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: shiftCalendarDate(localCalendarDate(), -3),
  metrics: [
    { id: 'distance', name: 'Distance', valueType: 'quantity', unit: 'km', thresholds: { direction: 'increase', target: 3, streakQualification: 'target' } },
    { id: 'minutes', name: 'Minutes', valueType: 'duration', unit: 'min', thresholds: { direction: 'increase', target: 20, streakQualification: 'target' } },
  ], qualificationRule: { kind: 'all', operands: [
    { kind: 'threshold', metricId: 'distance', level: 'target' }, { kind: 'threshold', metricId: 'minutes', level: 'target' },
  ] }, customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

describe('Analytics page', () => {
  it('groups summaries by definition while keeping account-wide context and tracker detail separate', async () => {
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    await localRepository.saveTracker(definition)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: yesterday, outcome: 'recorded', values: { distance: 5, minutes: 25 }, note: '' })

    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const activity = await screen.findByRole('group', { name: 'Activity' })
    const consistency = screen.getByRole('group', { name: 'Consistency' })
    expect(within(activity).getByText('Check-ins')).toBeInTheDocument()
    expect(within(activity).getByText('Successful check-ins')).toBeInTheDocument()
    expect(within(activity).getByText('Success rate')).toBeInTheDocument()
    expect(within(consistency).getByText('Streak-qualified days')).toBeInTheDocument()
    expect(within(consistency).getByText('Scheduled opportunities')).toBeInTheDocument()
    expect(screen.getByLabelText('Period context')).toHaveTextContent('Holidays')
    const tracker = screen.getByRole('heading', { name: 'Morning run' }).closest('.analytics-tracker') as HTMLElement
    expect(within(tracker).getByText('Current streak')).toBeInTheDocument()
    expect(within(tracker).getByText('Longest streak')).toBeInTheDocument()
    expect(within(tracker).getByText('Scheduling')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'XP & rewards' })).not.toBeInTheDocument()
  })

  it('keeps period XP scopes separate and labels lifetime badge type and award counts accurately', async () => {
    const today = localCalendarDate()
    await localRepository.saveTracker(definition)
    const entry = await localRepository.saveTrackerEntry({ trackerId: definition.id, date: today, outcome: 'recorded', values: { distance: 3, minutes: 20 }, note: '' })
    analyticsMocks.auth.signedIn = true
    analyticsMocks.getProgressionOverview.mockResolvedValueOnce(progressionFixture(today, entry.id))
    const user = userEvent.setup()
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const rewards = await screen.findByRole('group', { name: 'XP & rewards' })
    expect(within(rewards).getByText('Account XP')).toBeInTheDocument()
    expect(within(rewards).getByText('24', { selector: 'strong' })).toBeInTheDocument()
    expect(within(rewards).getByText('Tracker-attributed XP')).toBeInTheDocument()
    expect(within(rewards).getByText('20', { selector: 'strong' })).toBeInTheDocument()
    expect(within(rewards).getByText('Account-wide & unattributed XP')).toBeInTheDocument()
    expect(within(rewards).getByText('4', { selector: 'strong' })).toBeInTheDocument()
    expect(within(rewards).getByText('Badge types earned')).toBeInTheDocument()
    expect(within(rewards).getByText('1', { selector: 'strong' })).toBeInTheDocument()
    await user.click(within(rewards).getByRole('button', { name: 'More about Badge types earned' }))
    expect(await screen.findByRole('dialog', { name: 'Badge types earned' })).toHaveTextContent('Repeatable award occurrences do not increase this type count')
    await user.keyboard('{Escape}')

    await user.selectOptions(screen.getByLabelText('Tracker'), definition.id)
    const selectedRewards = await screen.findByRole('group', { name: 'XP & rewards' })
    expect(within(selectedRewards).getByText('Selected tracker XP')).toBeInTheDocument()
    expect(within(selectedRewards).getByText('20', { selector: 'strong' })).toBeInTheDocument()
    expect(within(selectedRewards).getByText('XP outside selected tracker')).toBeInTheDocument()
    expect(within(selectedRewards).getByText('4', { selector: 'strong' })).toBeInTheDocument()
    expect(within(selectedRewards).getByText('Tracker badge awards')).toBeInTheDocument()
    expect(within(selectedRewards).getByText('2', { selector: 'strong' })).toBeInTheDocument()
    expect(within(selectedRewards).getByText('24', { selector: 'strong' })).toBeInTheDocument()
  })

  it('keeps grouped summaries compact across phone, tablet, and desktop layouts using both theme palettes', () => {
    expect(appStyles).toMatch(/\.analytics-summary-groups\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
    expect(appStyles).toMatch(/@media\s*\(min-width:\s*761px\)\s*and\s*\(max-width:\s*1100px\)[\s\S]*?\.analytics-summary-groups\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(appStyles).toMatch(/@media\s*\(min-width:\s*761px\)\s*and\s*\(max-width:\s*900px\)[\s\S]*?\.analytics-summary-rewards \.analytics-summary-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(appStyles).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.analytics-summary-groups\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(appStyles).toContain('.analytics-summary-group { min-width: 0; padding: 15px 17px; background: var(--surface); }')
    expect(appStyles).toContain('.analytics-summary-stat { display: grid;')
    expect(themeTokens).toMatch(/:root\s*\{[\s\S]*?--surface:\s*#[0-9a-f]+/i)
    expect(themeTokens).toMatch(/\[data-theme='dark'\]\s*\{[\s\S]*?--surface:\s*#[0-9a-f]+/i)
    expect(appStyles).not.toMatch(/\.analytics-summary-group\s*\{[^}]*background:\s*#[0-9a-f]+/i)
  })

  it('preserves keyboard accessible, metric-specific explanations in the grouped summaries', async () => {
    const user = userEvent.setup()
    await localRepository.saveTracker(definition)
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const explanation = await screen.findByRole('button', { name: 'More about Streak-qualified days' })
    explanation.focus()
    expect(explanation).toHaveFocus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Streak-qualified days' })
    expect(dialog).toHaveTextContent('one calendar date can count once for each qualifying tracker')
    expect(dialog).toHaveTextContent('separate from Success Rule matches and success rate')
    await user.keyboard('{Escape}')
    expect(explanation).toHaveFocus()
  })

  it('shows one contextual empty explanation and keeps undefined rates distinct from zero', async () => {
    await localRepository.saveTracker({ ...definition, startDate: shiftCalendarDate(localCalendarDate(), 2) })
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const activity = await screen.findByRole('group', { name: 'Activity' })
    const consistency = screen.getByRole('group', { name: 'Consistency' })
    expect(within(activity).getByText('—', { selector: 'strong' })).toBeInTheDocument()
    expect(within(consistency).getByText('—', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No check-ins or scheduled opportunities in this period.')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.queryByText(/No values recorded in this period/)).not.toBeInTheDocument()
    expect(screen.queryByText('0%', { selector: 'strong' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Distance' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Minutes' })).toBeInTheDocument()
  })

  it('shows workspace-local consistency and distinct per-metric values', async () => {
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    await localRepository.saveTracker(definition)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: yesterday, outcome: 'recorded', values: { distance: 5, minutes: 25 }, note: '' })
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: localCalendarDate(), outcome: 'recorded', values: { distance: 2, minutes: 40 }, note: '' })

    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    expect(await screen.findByRole('heading', { name: /Analytics/ })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Morning run' })).toBeInTheDocument()
    expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Distance analysis' })).toHaveTextContent('average 3.5 km')
    expect(screen.getByRole('region', { name: 'Minutes analysis' })).toHaveTextContent('average 32.5 min')
    expect(screen.getAllByText(/does not add values across dates/)).toHaveLength(2)
  })

  it('exposes exact daily values through touch and keyboard controls without chart hover', async () => {
    const user = userEvent.setup()
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    const today = localCalendarDate()
    await localRepository.saveTracker(definition)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: yesterday, outcome: 'recorded', values: { distance: 5, minutes: 25 }, note: '' })
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: today, outcome: 'recorded', values: { distance: 2, minutes: 40 }, note: '' })

    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const distanceRegion = await screen.findByRole('region', { name: 'Distance analysis' })
    const summary = within(distanceRegion).getByText('View 2 daily values')
    const details = summary.closest('details')!
    expect(details).not.toHaveAttribute('open')
    await user.click(summary)
    const values = within(details).getAllByRole('button')
    expect(values.map((button) => button.getAttribute('aria-label'))).toEqual([
      `${calendarDateLabel(yesterday, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: 5 km`,
      `${calendarDateLabel(today, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: 2 km`,
    ])

    values[0]!.focus()
    expect(values[0]).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await within(details).findByRole('status')).toHaveTextContent(`Distance · ${calendarDateLabel(yesterday, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: 5 km`)
    await user.click(values[1]!)
    expect(within(details).getByRole('status')).toHaveTextContent(`Distance · ${calendarDateLabel(today, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: 2 km`)
    expect(values[1]).toHaveAttribute('aria-pressed', 'true')
  })

  it('limits dense chart details to the same latest fourteen values shown by the chart', async () => {
    const tracker = { ...definition, startDate: shiftCalendarDate(localCalendarDate(), -20) }
    await localRepository.saveTracker(tracker)
    for (let index = 0; index < 16; index += 1) {
      await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: shiftCalendarDate(localCalendarDate(), index - 15), outcome: 'recorded', values: { distance: index + 1, minutes: index + 20 }, note: '' })
    }

    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const distanceRegion = await screen.findByRole('region', { name: 'Distance analysis' })
    const summary = within(distanceRegion).getByText('View 14 daily values')
    await userEvent.setup().click(summary)
    const detailButtons = within(summary.closest('details')!).getAllByRole('button')
    expect(detailButtons).toHaveLength(14)
    expect(detailButtons[0]).toHaveAccessibleName(/: 3 km$/)
    expect(detailButtons.at(-1)).toHaveAccessibleName(/: 16 km$/)
    expect(detailButtons[0]).not.toHaveAccessibleName(/: 1 km$/)
  })

  it('summarizes empty metric datasets once and omits chart detail controls', async () => {
    await localRepository.saveTracker(definition)
    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    expect(await screen.findByText(/No check-ins in this period/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No check-ins in this period.')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.queryByText(/No values recorded in this period/)).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Distance analysis' })).toHaveTextContent('0 values')
    expect(screen.getByRole('region', { name: 'Minutes analysis' })).toHaveTextContent('0 values')
    expect(screen.queryByText(/View \d+ daily values?/)).not.toBeInTheDocument()
  })

  it('announces boolean metric observations as Yes and No', async () => {
    const user = userEvent.setup()
    const yesterday = shiftCalendarDate(localCalendarDate(), -1)
    const tracker: StoredTrackerDefinition = {
      ...definition,
      id: 'analytics-boolean',
      metrics: [{ id: 'completed', name: 'Completed', valueType: 'boolean' }],
      qualificationRule: { kind: 'comparison', metricId: 'completed', operator: 'equals', value: true },
    }
    await localRepository.saveTracker(tracker)
    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: yesterday, outcome: 'recorded', values: { completed: true }, note: '' })
    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: localCalendarDate(), outcome: 'recorded', values: { completed: false }, note: '' })

    render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)

    const region = await screen.findByRole('region', { name: 'Completed analysis' })
    await user.click(within(region).getByText('View 2 daily values'))
    const buttons = within(region).getAllByRole('button')
    expect(buttons[0]).toHaveAccessibleName(new RegExp(`${calendarDateLabel(yesterday, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: Yes`))
    expect(buttons[1]).toHaveAccessibleName(new RegExp(`${calendarDateLabel(localCalendarDate(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: No`))
  })
})
