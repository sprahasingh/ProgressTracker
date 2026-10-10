import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import { TrackerSetupPage } from './TrackerSetupPage'
import styles from '../../styles.css?raw'

const { navigation, routeParams } = vi.hoisted(() => ({ navigation: vi.fn(), routeParams: { trackerId: undefined as string | undefined } }))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigation, useParams: () => routeParams }
})

afterEach(async () => {
  cleanup()
  routeParams.trackerId = undefined
  await db.delete()
})

function renderSetup(path = '/trackers/new') {
  routeParams.trackerId = path.includes('/edit') ? path.split('/')[2] : undefined
  navigation.mockClear()
  return render(<MemoryRouter><TrackerSetupPage /></MemoryRouter>)
}

function precisePlannedGoal(id: string, decimalPlaces: 0 | 1 | 2, increment: number, allocations: Record<string, number>) {
  return {
    schemaVersion: 4 as const, id, name: 'Precision plan', description: '', kind: 'goal' as const, status: 'active' as const,
    categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const }, startDate: '2026-01-05', deadline: '2026-01-06',
    metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' as const, unit: 'pages', precision: { decimalPlaces, increment }, thresholds: { direction: 'increase' as const, target: 1, streakQualification: 'target' as const } }],
    qualificationRule: { kind: 'threshold' as const, metricId: 'pages', level: 'target' as const }, customFields: [], milestones: [],
    goalPlanning: { mode: 'cumulative-deadline' as const, progressSemantics: { pages: 'incremental' as const }, dailyTargets: {}, cumulativeTargets: { pages: 10 }, planningTimeZone: 'UTC', allocations: { pages: allocations } },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
  }
}

describe('tracker setup flow', () => {
  it('requires a useful name before saving', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByText('Enter a name for this tracker.')).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toHaveLength(0)
  })

  it('creates a habit with a daily default and offers an immediate check-in', async () => {
    const user = userEvent.setup()
    renderSetup()
    const name = screen.getByRole('textbox', { name: 'What habit do you want to build?' })
    expect(name).not.toHaveFocus()
    await user.type(name, 'Read every day')
    expect(screen.getByLabelText('Start date').getAttribute('value') ?? (screen.getByLabelText('Start date') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(screen.getByRole('combobox', { name: /How often/ }).closest('.advanced-setup')).not.toHaveAttribute('open')
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Schedule & holidays'))
    expect(screen.getByRole('combobox', { name: /How often/ })).toHaveValue('every-day')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Record my first check-in' })).toHaveAttribute('href', '/')
    expect(await localRepository.listTrackers()).toMatchObject([{ kind: 'habit', name: 'Read every day', schedule: { kind: 'every-day' }, metrics: [{ valueType: 'boolean' }] }])
  })

  it('defaults Strict Mode off and persists it on newly created trackers when enabled', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Daily practice')
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Schedule & holidays'))
    const strictMode = screen.getByRole('checkbox', { name: /Strict Mode/ })
    expect(strictMode).not.toBeChecked()
    await user.click(strictMode)
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ strictMode: true }])
  })

  it('asks before recalculating historical streaks when Strict Mode changes on an existing tracker', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'strict-history', name: 'Read', description: '', kind: 'habit' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' as const },
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    renderSetup('/trackers/strict-history/edit')
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Schedule & holidays'))
    await user.click(await screen.findByRole('checkbox', { name: /Strict Mode/ }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('including past holidays and rest days'))
    expect(await localRepository.getTracker(existing.id)).not.toHaveProperty('strictMode')
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ strictMode: true }))
  })

  it('offers compact numeric unit, target, and precision controls and saves them', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Read pages')
    await user.click(screen.getByRole('radio', { name: 'Number or amount' }))
    expect(screen.getByRole('region', { name: 'Numeric measure settings' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Numeric measure unit' }), 'pages')
    await user.clear(screen.getByRole('spinbutton', { name: 'Per-check-in target' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Per-check-in target' }), '5')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Numeric precision' }), '1')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ schemaVersion: 4, metrics: [{ valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 1, increment: 0.1 }, thresholds: { target: 5 } }] }])
  })

  it.each([320, 360, 390, 430])('keeps the essential setup controls and compact action footer available at %ipx', async (width) => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.dispatchEvent(new Event('resize'))
    renderSetup()
    expect(screen.getByRole('textbox', { name: 'What habit do you want to build?' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Done or not yet' })).toBeInTheDocument()
    expect(screen.getByLabelText('Start date')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create tracker' })).toBeInTheDocument()
    expect(styles).toContain('@media (max-width: 360px)')
    expect(styles).toContain('bottom: calc(64px + env(safe-area-inset-bottom, 0px))')
    expect(styles).toContain('white-space: normal;')
    expect(styles).toContain('overflow-wrap: normal;')
    expect(styles).toContain('.section-header-container { min-width: 0; container-type: inline-size; }')
    expect(styles).toMatch(/@container\s*\(max-width:\s*360px\)/)
    expect(styles).not.toContain('.configuration-heading > div:first-child { flex-basis: 100%;')
    cleanup()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  })

  it('creates a cumulative goal when an optional target and deadline are added', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    await user.type(screen.getByRole('textbox', { name: 'What do you want to achieve?' }), 'Solve DSA problems')
    await user.click(screen.getByText('Add a target or deadline'))
    await user.type(screen.getByRole('spinbutton', { name: 'Total amount' }), '100')
    await user.type(screen.getByRole('textbox', { name: 'What are you counting?' }), 'problems')
    expect(screen.getByLabelText('Goal deadline')).toBeVisible()
    await user.type(screen.getByLabelText('Goal deadline'), '2099-12-31')
    expect(screen.getByRole('spinbutton', { name: 'Total amount' })).toHaveValue(100)
    expect(screen.getByText(/Suggested pace:/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('link', { name: 'Record my first progress' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'View my goal' })).toHaveAttribute('href', '/goals')
    expect(screen.getByRole('link', { name: 'Customize my plan' })).toHaveAttribute('href', expect.stringMatching(/\/trackers\/.*\/edit/))
    const [saved] = await localRepository.listTrackers()
    expect(saved).toMatchObject({
      schemaVersion: 2, kind: 'goal', name: 'Solve DSA problems', schedule: { kind: 'every-day' },
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { [saved!.metrics[0]!.id]: 'incremental' }, cumulativeTargets: { [saved!.metrics[0]!.id]: 100 } },
      metrics: [{ name: 'Progress', valueType: 'quantity', unit: 'problems', thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } }],
    })
    expect(saved?.deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('allows a simple name-only goal without forcing planning details', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    await user.type(screen.getByRole('textbox', { name: 'What do you want to achieve?' }), 'Read books')
    expect(screen.getByRole('radio', { name: 'Number or amount' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ schemaVersion: 1, kind: 'goal', name: 'Read books', metrics: [{ thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } }] }])
    expect((await localRepository.listTrackers())[0]?.metrics[0]?.thresholds?.target).toBeUndefined()
  })

  it('keeps complex measures, nested rules, custom fields, and milestones behind targeted disclosures', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByText('Challenge or project?'))
    await user.click(screen.getByRole('radio', { name: /Project/ }))
    await user.type(screen.getByRole('textbox', { name: 'What project will you move forward?' }), 'Build a portfolio')
    const advanced = screen.getByText('More options').closest('details')
    expect(advanced).not.toHaveAttribute('open')
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    await user.click(screen.getByRole('button', { name: '＋ Add measure' }))
    const measureNames = screen.getAllByRole('textbox').filter((input) => input.getAttribute('aria-label') === 'Name')
    await user.clear(measureNames[1]!)
    await user.type(measureNames[1]!, 'Focus time')
    expect(measureNames[1]).toHaveValue('Focus time')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure 2 value type' }), 'duration')

    const successDisclosure = screen.getByText('Success rule', { selector: 'summary' }).closest('details')!
    await user.click(screen.getByText('Success rule', { selector: 'summary' }))
    expect(successDisclosure).toHaveAttribute('open')
    expect(screen.queryByRole('heading', { name: 'Success rule' })).not.toBeInTheDocument()
    const ruleKinds = screen.getAllByRole('combobox', { name: 'Success condition type' })
    expect(within(ruleKinds[0]!).queryByRole('option', { name: 'Achievement threshold' })).not.toBeInTheDocument()
    await user.selectOptions(ruleKinds[0]!, 'all')
    const nestedRuleKinds = screen.getAllByRole('combobox', { name: 'Success condition type' })
    await user.selectOptions(nestedRuleKinds[1]!, 'any')

    await user.click(screen.getByText('Extra check-in details'))
    await user.click(screen.getByRole('button', { name: '＋ Add field' }))
    await user.type(screen.getByRole('textbox', { name: 'Field name' }), 'Mood')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field type' }), 'single-select')
    const optionInput = screen.getByRole('region', { name: 'Custom fields' }).querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(optionInput, { target: { value: 'Focused\nTired' } })
    expect(optionInput).toHaveValue('Focused\nTired')
    const milestoneDisclosure = screen.getByText('Milestones', { selector: 'summary' }).closest('details')!
    await user.click(screen.getByText('Milestones', { selector: 'summary' }))
    expect(milestoneDisclosure).toHaveAttribute('open')
    expect(screen.queryByRole('heading', { name: 'Milestones' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '＋ Add milestone' }))
    expect(milestoneDisclosure).toHaveAttribute('open')
    const milestoneTitle = screen.getByRole('region', { name: 'Milestones' }).querySelector('input') as HTMLInputElement
    await user.type(milestoneTitle, 'Publish first case study')
    expect(milestoneTitle).toHaveValue('Publish first case study')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    const [saved] = await localRepository.listTrackers()
    expect(saved?.metrics).toHaveLength(2)
    expect(saved?.metrics[1]).toMatchObject({ name: 'Focus time', valueType: 'duration' })
    expect(saved?.qualificationRule).toMatchObject({ kind: 'all', operands: [{ kind: 'any', operands: [expect.any(Object), expect.any(Object)] }, expect.any(Object)] })
    expect(saved?.customFields).toMatchObject([{ name: 'Mood', type: 'single-select', options: ['Focused', 'Tired'] }])
    expect(saved?.milestones).toMatchObject([{ title: 'Publish first case study' }])
  }, 10_000)

  it('edits an existing habit without changing its identity, kind, or schema version', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'edit-tracker', name: 'Old name', description: '', kind: 'habit' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const },
      metrics: [{ id: 'habit-metric', name: 'Completed', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'habit-metric', operator: 'equals' as const, value: true },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup('/trackers/edit-tracker/edit')
    const name = await screen.findByRole('textbox', { name: 'What habit do you want to build?' })
    await user.clear(name)
    await user.type(name, 'Updated name')
    expect(screen.getByText('More options').closest('details')).not.toHaveAttribute('open')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(navigation).toHaveBeenCalledWith('/trackers', expect.any(Object)))
    const saved = await localRepository.getTracker(existing.id)
    expect(saved).toMatchObject({ id: existing.id, name: 'Updated name', createdAt: existing.createdAt, schemaVersion: 1, kind: 'habit' })
  })

  it('keeps a legacy goal per-check-in target when editing it', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'legacy-goal', name: 'Read pages', description: '', kind: 'goal' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' as const },
      startDate: '2026-01-01', deadline: '2026-02-01',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' as const, unit: 'pages', thresholds: { direction: 'increase' as const, target: 10, streakQualification: 'target' as const } }],
      qualificationRule: { kind: 'threshold' as const, metricId: 'pages', level: 'target' as const },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup('/trackers/legacy-goal/edit')
    await user.click(await screen.findByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    const target = screen.getByText(/Target threshold/).closest('label')!.querySelector('input')!
    await user.clear(target)
    await user.type(target, '12')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(navigation).toHaveBeenCalled())
    expect(await localRepository.getTracker(existing.id)).toMatchObject({ schemaVersion: 1, metrics: [{ thresholds: { target: 12 } }] })
  })

  it('sets the least restrictive valid increment for selected precision and saves the v4 definition', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'precision-goal', name: 'Solve problems', description: '', kind: 'goal' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' as const },
      startDate: '2026-01-01', deadline: '2026-02-01',
      metrics: [{ id: 'problems', name: 'Problems', valueType: 'quantity' as const, unit: 'problems', thresholds: { direction: 'increase' as const, target: 1.2, streakQualification: 'target' as const } }],
      qualificationRule: { kind: 'threshold' as const, metricId: 'problems', level: 'target' as const },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup('/trackers/precision-goal/edit')
    await screen.findByRole('textbox', { name: 'What do you want to achieve?' })
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Problems recording precision' }), '1')
    expect(screen.getByRole('combobox', { name: 'Problems allowed increment' })).toHaveValue('0.1')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(navigation).toHaveBeenCalled())
    expect(await localRepository.getTracker(existing.id)).toMatchObject({
      schemaVersion: 4,
      metrics: [{ precision: { decimalPlaces: 1, increment: 0.1 }, thresholds: { target: 1.2 } }],
    })
  })

  it.each([
    { from: 0 as const, fromIncrement: 1, to: 1 as const, toIncrement: 0.1, allocations: { '2026-01-05': 3, '2026-01-06': 4 } },
    { from: 0 as const, fromIncrement: 1, to: 2 as const, toIncrement: 0.01, allocations: { '2026-01-05': 3, '2026-01-06': 4 } },
    { from: 2 as const, fromIncrement: 0.01, to: 1 as const, toIncrement: 0.1, allocations: { '2026-01-05': 3.2, '2026-01-06': 4.5 } },
    { from: 2 as const, fromIncrement: 0.01, to: 0 as const, toIncrement: 1, allocations: { '2026-01-05': 3, '2026-01-06': 4 } },
  ])('changes precision $from to $to and preserves compatible saved allocations', async ({ from, fromIncrement, to, toIncrement, allocations }) => {
    const existing = precisePlannedGoal(`precision-${from}-${to}`, from, fromIncrement, allocations)
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await screen.findByRole('textbox', { name: 'What do you want to achieve?' })
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Pages recording precision' }), String(to))
    expect(screen.getByRole('combobox', { name: 'Pages allowed increment' })).toHaveValue(String(toIncrement))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({
      schemaVersion: 4, metrics: [{ precision: { decimalPlaces: to, increment: toIncrement } }],
      goalPlanning: { cumulativeTargets: { pages: 10 }, allocations: { pages: allocations } },
    }))
  })

  it('blocks a precision decrease that conflicts with saved allocations without changing the goal or progress', async () => {
    const existing = precisePlannedGoal('precision-incompatible-plan', 2, 0.01, { '2026-01-05': 1.25, '2026-01-06': 2.35 })
    await localRepository.saveTracker(existing)
    const progress = await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-01-05', outcome: 'recorded', values: { pages: 1.23 }, note: 'saved progress' })
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await screen.findByRole('textbox', { name: 'What do you want to achieve?' })
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Pages recording precision' }), '1')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Saved daily allocations for Pages (increments of 0.1) do not match the selected precision.')
    expect(alert).toHaveTextContent('Your goal total, allocations, and recorded progress have not changed.')
    expect(alert).not.toHaveTextContent('2026-01-05')
    await expect(localRepository.getTracker(existing.id)).resolves.toMatchObject({
      schemaVersion: 4, metrics: [{ precision: { decimalPlaces: 2, increment: 0.01 } }],
      goalPlanning: { cumulativeTargets: { pages: 10 }, allocations: { pages: { '2026-01-05': 1.25, '2026-01-06': 2.35 } } },
    })
    await expect(db.trackerEntries.get(progress.id)).resolves.toMatchObject({ values: { pages: 1.23 }, note: 'saved progress' })
  })

  it('preserves a custom existing schedule when other settings are edited', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'custom-schedule', name: 'Flexible', description: '', kind: 'habit' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-n-days' as const, interval: 2 },
      metrics: [{ id: 'habit', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'habit', operator: 'equals' as const, value: true },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup('/trackers/custom-schedule/edit')
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(navigation).toHaveBeenCalled())
    expect(await localRepository.getTracker(existing.id)).toMatchObject({ schedule: { kind: 'every-n-days', interval: 2 } })
  })

  it('archives without deleting and can still list the archived tracker', async () => {
    const tracker = {
      schemaVersion: 1 as const, id: 'archive-tracker', name: 'Keep this history', description: '', kind: 'habit' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const },
      metrics: [{ id: 'archive-metric', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'archive-metric', operator: 'equals' as const, value: true },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    await localRepository.archiveTracker(tracker.id)

    expect(await localRepository.listTrackers()).toHaveLength(0)
    expect(await localRepository.listTrackers(true)).toMatchObject([{ id: tracker.id, status: 'archived', archivedAt: expect.any(String) }])
  })
})
