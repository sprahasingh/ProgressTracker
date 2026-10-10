import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fireEvent } from '@testing-library/dom'
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'
import { localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { GoalsPage } from './GoalsPage'
import goalStyles from '../../styles.css?raw'

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({
  status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false,
}) }))

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete() })

async function openGoalPlan(user: ReturnType<typeof userEvent.setup>, goalName: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(goalName) }))
  await user.click(await screen.findByText('View daily plan'))
}

describe('Goals page allocation preview', () => {
  it('resets expanded tracker details when the route is left and restored with browser history', async () => {
    const user = userEvent.setup()
    const today = localCalendarDate(new Date(), 'UTC')
    const goal: StoredTrackerDefinition = {
      schemaVersion: 4, id: 'route-reset-goal', name: 'Route reset goal', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: shiftCalendarDate(today, 3),
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 0, increment: 1 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'daily-recurring', progressSemantics: { pages: 'incremental' }, dailyTargets: { pages: 2 }, cumulativeTargets: {}, planningTimeZone: 'UTC' },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(goal)
    function HistoryActions() {
      const navigate = useNavigate()
      return <div><button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button></div>
    }
    render(<MemoryRouter initialEntries={['/goals']}><Routes>
      <Route path="/goals" element={<><GoalsPage /><Link to="/calendar">Calendar</Link><HistoryActions /></>} />
      <Route path="/calendar" element={<><p>Calendar route</p><Link to="/goals">Goals</Link><HistoryActions /></>} />
    </Routes></MemoryRouter>)

    const card = await screen.findByRole('button', { name: /Route reset goal/ })
    await user.click(card)
    expect(card).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('link', { name: 'Calendar' }))
    expect(await screen.findByText('Calendar route')).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Goals' }))
    expect(await screen.findByRole('button', { name: /Route reset goal/ })).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', { name: /Route reset goal/ }))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Calendar route')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Forward' }))
    expect(await screen.findByRole('button', { name: /Route reset goal/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('gives goal-plan dates distinct accessible markers for rest days and holidays', async () => {
    const user = userEvent.setup()
    const today = localCalendarDate(new Date(), 'UTC')
    const holidayDate = shiftCalendarDate(today, 1)
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 4, id: 'daily-goal-status-markers', name: 'Daily writing plan', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' }, startDate: shiftCalendarDate(today, -7),
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 0, increment: 1 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'daily-recurring', progressSemantics: { pages: 'incremental' }, dailyTargets: { pages: 5 }, cumulativeTargets: {}, planningTimeZone: 'UTC' },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    await localRepository.saveAccountHolidays([holidayDate], null)
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: /Daily writing plan/ }))
    await user.click(await screen.findByText('View daily plan'))

    const plan = await screen.findByRole('region', { name: 'Daily writing plan daily-recurring plan' })
    const dates = plan.querySelector('.goal-plan-days')!
    expect(dates.querySelector('.goal-plan-day.holiday [data-icon="status-holiday"]')).toBeInTheDocument()
    expect(dates.querySelector('.goal-plan-day.rest [data-icon="status-unscheduled"]')).toBeInTheDocument()
    expect(dates.querySelector('[aria-label*="Rest day"]')).toBeInTheDocument()
    expect(dates.querySelector('[aria-label*="Holiday"]')).toBeInTheDocument()
  })

  it('uses one shared compact information control for all goal summary cards', async () => {
    const today = localCalendarDate(new Date(), 'UTC')
    await localRepository.saveTracker({
      schemaVersion: 4, id: 'goal-info-icons', name: 'Compact info test', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: shiftCalendarDate(today, 2), metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 0, increment: 1 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: {}, cumulativeTargets: { pages: 10 }, planningTimeZone: 'UTC', allocations: { pages: {} } },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    })
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    for (const label of ['In progress', 'Overdue', 'Completed', 'All goals']) {
      expect(await screen.findByRole('button', { name: `More about ${label}` })).toHaveClass('info-button')
    }
    expect(goalStyles).toMatch(/\.info-button::before\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/s)
  })

  it('exposes an unsaved preview without changing the stored plan or check-ins', async () => {
    const user = userEvent.setup()
    // The fixture uses the UTC planning zone, so its entry date and the goal
    // page's planning "today" must be derived in that same zone.
    const today = localCalendarDate(new Date(), 'UTC')
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 4, id: 'goal-preview-integration', name: 'Finish a draft', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: shiftCalendarDate(today, 2),
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 2, increment: 0.01 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: {}, cumulativeTargets: { pages: 10 }, planningTimeZone: 'UTC', allocations: { pages: {} } },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome: 'recorded', values: { pages: 2 }, note: 'Actual work' })
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)

    expect(screen.queryByRole('region', { name: 'Pages allocation preview' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Finish a draft/ })).toHaveAttribute('aria-expanded', 'false')
    await openGoalPlan(user, 'Finish a draft')
    expect(await screen.findByRole('region', { name: 'Pages allocation preview' })).toBeInTheDocument()
    expect(screen.getAllByText('8 pages').length).toBeGreaterThanOrEqual(1)
    const tomorrow = shiftCalendarDate(today, 1)
    fireEvent.change(screen.getByRole('spinbutton', { name: `Allocation for ${tomorrow}` }), { target: { value: '0' } })
    expect(await screen.findByText(/remains unallocated\./)).toBeInTheDocument()

    await waitFor(async () => {
      await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ goalPlanning: tracker.goalPlanning })
      await expect(db.trackerEntries.get(savedEntry.id)).resolves.toMatchObject({ values: { pages: 2 } })
    })
  })

  it('refreshes actual progress and the cumulative suggestion after a guest check-in is saved', async () => {
    const user = userEvent.setup()
    const today = localCalendarDate(new Date(), 'UTC')
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 4, id: 'goal-live-progress', name: 'Practice questions', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: shiftCalendarDate(today, 2),
      metrics: [{ id: 'questions', name: 'Questions', valueType: 'quantity', unit: 'problems', precision: { decimalPlaces: 0, increment: 1 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { questions: 'incremental' }, dailyTargets: {}, cumulativeTargets: { questions: 9 }, planningTimeZone: 'UTC', allocations: { questions: { [shiftCalendarDate(today, 1)]: 4, [shiftCalendarDate(today, 2)]: 5 } } },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    await openGoalPlan(user, 'Practice questions')
    expect(await screen.findByRole('region', { name: 'Questions allocation preview' })).toBeInTheDocument()
    expect(screen.getAllByText('9 problems').length).toBeGreaterThanOrEqual(1)

    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome: 'recorded', values: { questions: 3 }, note: '' })

    await waitFor(() => expect(screen.getAllByText('6 problems').length).toBeGreaterThanOrEqual(1))
    expect(screen.getByText(/automatic suggestions below have been recalculated/)).toBeInTheDocument()
    expect(screen.getByLabelText(`Suggested allocation for ${shiftCalendarDate(today, 1)}`)).toHaveTextContent('3 problems')
    expect(screen.getByLabelText(`Suggested allocation for ${shiftCalendarDate(today, 2)}`)).toHaveTextContent('3 problems')
  })

  it('recalculates displayed future suggestions after progress is created, edited, and deleted without replacing saved allocations', async () => {
    const user = userEvent.setup()
    const today = localCalendarDate(new Date(), 'UTC')
    const tomorrow = shiftCalendarDate(today, 1)
    const nextDay = shiftCalendarDate(today, 2)
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 4, id: 'goal-adaptive-progress', name: 'Practice problems', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: nextDay,
      metrics: [{ id: 'problems', name: 'Problems', valueType: 'quantity', unit: 'problems', precision: { decimalPlaces: 0, increment: 1 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { problems: 'incremental' }, dailyTargets: {}, cumulativeTargets: { problems: 10 }, planningTimeZone: 'UTC', allocations: { problems: { [today]: 4, [tomorrow]: 3, [nextDay]: 3 } } },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    await openGoalPlan(user, 'Practice problems')
    expect(await screen.findByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('3 problems')
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('3 problems')

    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome: 'recorded', values: { problems: 6 }, note: '' })
    await waitFor(() => expect(screen.getByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('2 problems'))
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('2 problems')
    expect(screen.getByRole('spinbutton', { name: `Saved allocation for ${tomorrow}` })).toHaveValue(3)

    await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: today, outcome: 'recorded', values: { problems: 2 }, note: 'edited' })
    await waitFor(() => expect(screen.getByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('4 problems'))
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('4 problems')
    expect(await db.trackers.get(tracker.id)).toMatchObject({ goalPlanning: tracker.goalPlanning })

    cleanup()
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    await openGoalPlan(user, 'Practice problems')
    await waitFor(() => expect(screen.getByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('4 problems'))
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('4 problems')

    await localRepository.deleteTrackerEntry(tracker.id, today)
    await waitFor(() => expect(screen.getByLabelText(`Suggested allocation for ${today}`)).toHaveTextContent('4 problems'))
    expect(screen.getByLabelText(`Suggested allocation for ${tomorrow}`)).toHaveTextContent('3 problems')
    expect(screen.getByLabelText(`Suggested allocation for ${nextDay}`)).toHaveTextContent('3 problems')
    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ goalPlanning: tracker.goalPlanning })
    await expect(db.trackerEntries.where('[trackerId+date]').equals([tracker.id, today]).first()).resolves.toMatchObject({ values: { problems: 2 }, note: 'edited', deletedAt: expect.any(String) })
  })

  it('keeps goals collapsed by default, supports multiple open cards, and refreshes their summaries in place', async () => {
    const user = userEvent.setup()
    const today = localCalendarDate(new Date(), 'UTC')
    const makeGoal = (id: string, name: string, metrics: StoredTrackerDefinition['metrics'], cumulativeTargets: Record<string, number>): StoredTrackerDefinition => ({
      schemaVersion: 4, id, name, description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline: shiftCalendarDate(today, 2),
      metrics, customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: Object.fromEntries(Object.keys(cumulativeTargets).map((key) => [key, 'incremental' as const])), dailyTargets: {}, cumulativeTargets, planningTimeZone: 'UTC', allocations: {} },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    })
    const first = makeGoal('goal-alpha', 'Finish the database course', [
      { id: 'chapters', name: 'Chapters', valueType: 'quantity', unit: 'chapters', precision: { decimalPlaces: 0, increment: 1 } },
      { id: 'lessons', name: 'Lessons', valueType: 'quantity', unit: 'lessons', precision: { decimalPlaces: 0, increment: 1 } },
    ], { chapters: 10, lessons: 20 })
    const second = makeGoal('goal-beta', 'Complete the portfolio', [
      { id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 0, increment: 1 } },
    ], { pages: 5 })
    await localRepository.saveTracker(first)
    await localRepository.saveTracker(second)
    await localRepository.saveTrackerEntry({ trackerId: first.id, date: today, outcome: 'recorded', values: { chapters: 2, lessons: 10 }, note: '' })
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)

    const firstToggle = await screen.findByRole('button', { name: /Finish the database course/ })
    const secondToggle = screen.getByRole('button', { name: /Complete the portfolio/ })
    expect(firstToggle).toHaveAttribute('aria-expanded', 'false')
    expect(secondToggle).toHaveAttribute('aria-expanded', 'false')
    expect(firstToggle).toHaveTextContent('2 / 10 chapters')
    expect(firstToggle).toHaveTextContent('10 / 20 lessons')
    expect(firstToggle.querySelectorAll('.goal-card-progress')).toHaveLength(2)
    expect(screen.queryByRole('region', { name: 'Chapters allocation preview' })).not.toBeInTheDocument()

    await user.click(firstToggle)
    expect(firstToggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(secondToggle)
    expect(firstToggle).toHaveAttribute('aria-expanded', 'true')
    expect(secondToggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(within(firstToggle.closest('.goal-card')!).getByText('View daily plan'))
    const planDisclosure = within(firstToggle.closest('.goal-card')!).getByText('Hide daily plan').closest('summary')!
    expect(planDisclosure).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(planDisclosure.getAttribute('aria-controls')!)).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Chapters allocation preview' })).toBeInTheDocument()

    await localRepository.saveTrackerEntry({ trackerId: first.id, date: today, outcome: 'recorded', values: { chapters: 5, lessons: 10 }, note: 'edited' })
    await waitFor(() => expect(screen.getByRole('button', { name: /Finish the database course/ })).toHaveTextContent('5 / 10 chapters'))
    expect(screen.getByRole('button', { name: /Finish the database course/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /Complete the portfolio/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Chapters allocation preview' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Finish the database course/ }))
    expect(screen.getByRole('button', { name: /Finish the database course/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /Complete the portfolio/ })).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: /Finish the database course/ }))
    expect(screen.getByRole('region', { name: 'Chapters allocation preview' })).toBeInTheDocument()
  })

  it('paginates long allocation schedules while keeping every date reachable', async () => {
    const user = userEvent.setup()
    const today = localCalendarDate(new Date(), 'UTC')
    const deadline = shiftCalendarDate(today, 45)
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 4, id: 'long-goal-plan', name: 'Long research project', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, startDate: today, deadline,
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 0, increment: 1 } }], customFields: [], milestones: [],
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: {}, cumulativeTargets: { pages: 50 }, planningTimeZone: 'UTC', allocations: {} },
      createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    await openGoalPlan(user, tracker.name)
    expect(await screen.findByText(`Dates 1–14 of 46`)).toBeInTheDocument()
    expect(screen.getAllByRole('spinbutton')).toHaveLength(14)
    await user.click(screen.getByRole('button', { name: 'Next dates' }))
    expect(screen.getByText('Dates 15–28 of 46')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: `Allocation for ${shiftCalendarDate(today, 14)}` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous dates' })).toBeEnabled()
  })

  it.each([320, 360, 390, 430, 1280])('keeps long goal summaries responsive at %ipx', async (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    const today = localCalendarDate(new Date(), 'UTC')
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 1, id: `long-goal-${width}`, name: 'Complete the advanced distributed systems capstone course', description: '', kind: 'goal', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [{ id: 'sessions', name: 'Sessions in the advanced lab series', valueType: 'quantity', unit: 'sessions', thresholds: { direction: 'increase', target: 25, streakQualification: 'target' } }],
      qualificationRule: { kind: 'threshold', metricId: 'sessions', level: 'target' }, customFields: [], milestones: [], createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    render(<MemoryRouter><GoalsPage /></MemoryRouter>)
    const summary = await screen.findByRole('button', { name: /Complete the advanced distributed systems capstone course/ })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(summary).toHaveTextContent('Sessions in the advanced lab series')
    expect(goalStyles).toMatch(/\.goal-card-summary-name\s*\{[^}]*overflow-wrap:\s*anywhere/s)
    expect(goalStyles).toMatch(/\.goal-card-summary-metrics\s*\{[^}]*min-width:\s*0/s)
    expect(goalStyles).toMatch(/@media\s*\(max-width:\s*600px\)[\s\S]*?\.goal-card-trigger/)
  })
})
