import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import { TrackerSetupPage } from './TrackerSetupPage'

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
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Read every day')
    expect(screen.getByRole('combobox', { name: /How often/ })).toHaveValue('every-day')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Record my first check-in' })).toHaveAttribute('href', '/')
    expect(await localRepository.listTrackers()).toMatchObject([{ kind: 'habit', name: 'Read every day', schedule: { kind: 'every-day' }, metrics: [{ valueType: 'boolean' }] }])
  })

  it('creates a cumulative goal with an amount, unit, 30-day deadline, and separate check-in threshold', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    await user.type(screen.getByRole('textbox', { name: 'What do you want to achieve?' }), 'Solve DSA problems')
    await user.type(screen.getByRole('spinbutton', { name: 'Total amount' }), '100')
    await user.type(screen.getByRole('textbox', { name: 'What are you counting?' }), 'problems')
    expect(screen.getByLabelText('Goal deadline')).toBeVisible()
    expect((screen.getByLabelText('Goal deadline') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
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
      metrics: [{ name: 'Progress', valueType: 'quantity', unit: 'problems', thresholds: { target: 1 } }],
    })
    expect(saved?.deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('validates the goal unit and amount rather than silently creating an empty target', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    await user.type(screen.getByRole('textbox', { name: 'What do you want to achieve?' }), 'Read books')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByText('Enter a total greater than zero, such as 100.')).toBeInTheDocument()
    expect(screen.getByText('Add what you are counting, such as problems or pages.')).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toHaveLength(0)
  })

  it('keeps complex measures, nested rules, custom fields, and milestones behind targeted disclosures', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Project/ }))
    await user.type(screen.getByRole('textbox', { name: 'What project will you move forward?' }), 'Build a portfolio')
    const advanced = screen.getByText('Advanced options').closest('details')
    expect(advanced).not.toHaveAttribute('open')
    await user.click(screen.getByText('Advanced options'))
    await user.click(screen.getByText('Measures and success levels'))
    await user.click(screen.getByRole('button', { name: '＋ Add measure' }))
    const measureNames = screen.getAllByRole('textbox').filter((input) => input.getAttribute('aria-label') === 'Name')
    await user.clear(measureNames[1]!)
    await user.type(measureNames[1]!, 'Focus time')
    expect(measureNames[1]).toHaveValue('Focus time')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure 2 value type' }), 'duration')

    await user.click(screen.getByText('Success conditions'))
    const ruleKinds = screen.getAllByRole('combobox', { name: 'Success condition type' })
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
    await user.click(screen.getByText('Milestones', { selector: 'summary' }))
    await user.click(screen.getByRole('button', { name: '＋ Add milestone' }))
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
  })

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
    expect(screen.getByText('Advanced options').closest('details')).not.toHaveAttribute('open')
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
    const target = await screen.findByRole('spinbutton', { name: 'Quick target' })
    await user.clear(target)
    await user.type(target, '12')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(navigation).toHaveBeenCalled())
    expect(await localRepository.getTracker(existing.id)).toMatchObject({ schemaVersion: 1, metrics: [{ thresholds: { target: 12 } }] })
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
