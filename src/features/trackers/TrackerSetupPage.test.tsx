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
  await db.delete()
})

function renderSetup(path = '/trackers/new') {
  routeParams.trackerId = path.includes('/edit') ? path.split('/')[2] : undefined
  navigation.mockClear()
  return render(<MemoryRouter><TrackerSetupPage /></MemoryRouter>)
}

describe('tracker setup flow', () => {
  it('validates required fields before saving', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByText('Enter a name for this tracker.')).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toHaveLength(0)
  })

  it('creates a locally persisted goal and returns to the tracker library', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByLabelText('What would you like to track?'), 'Run a 10K')
    await user.selectOptions(screen.getByLabelText('Tracker type'), 'goal')
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Distance')
    await user.clear(screen.getByLabelText(/Target threshold/))
    await user.type(screen.getByLabelText(/Target threshold/), '10')
    await user.type(screen.getByLabelText('Unit'), 'km')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    await waitFor(() => expect(navigation).toHaveBeenCalledWith('/trackers', expect.objectContaining({ state: expect.any(Object) })))
    const saved = await localRepository.listTrackers()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ kind: 'goal', name: 'Run a 10K', metrics: [{ name: 'Distance', unit: 'km', thresholds: { target: 10 } }] })
  })

  it('saves multiple measures, nested success rules, select fields, and milestones', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByLabelText('What would you like to track?'), 'Build a portfolio')
    await user.selectOptions(screen.getByLabelText('Tracker type'), 'project')
    await user.click(screen.getByRole('button', { name: '＋ Add measure' }))
    const measureNames = screen.getAllByLabelText('Name')
    await user.clear(measureNames[1]!)
    await user.type(measureNames[1]!, 'Focus time')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure 2 value type' }), 'duration')

    const ruleKinds = screen.getAllByRole('combobox', { name: 'Success condition type' })
    await user.selectOptions(ruleKinds[0]!, 'all')
    const nestedRuleKinds = screen.getAllByRole('combobox', { name: 'Success condition type' })
    await user.selectOptions(nestedRuleKinds[1]!, 'any')

    await user.click(screen.getByRole('button', { name: '＋ Add field' }))
    await user.type(screen.getByLabelText('Field name'), 'Mood')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field type' }), 'single-select')
    fireEvent.change(screen.getByLabelText(/Options/), { target: { value: 'Focused\nTired' } })
    await user.click(screen.getByRole('button', { name: '＋ Add milestone' }))
    await user.type(screen.getByLabelText('Milestone'), 'Publish first case study')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    await waitFor(() => expect(navigation).toHaveBeenCalledWith('/trackers', expect.any(Object)))
    const saved = await localRepository.listTrackers()
    expect(saved[0]?.metrics).toHaveLength(2)
    expect(saved[0]?.metrics[1]).toMatchObject({ name: 'Focus time', valueType: 'duration' })
    expect(saved[0]?.qualificationRule).toMatchObject({ kind: 'all', operands: [{ kind: 'any', operands: [expect.any(Object), expect.any(Object)] }, expect.any(Object)] })
    expect(saved[0]?.customFields).toMatchObject([{ name: 'Mood', type: 'single-select', options: ['Focused', 'Tired'] }])
    expect(saved[0]?.milestones).toMatchObject([{ title: 'Publish first case study' }])
  })

  it('edits setup without replacing existing tracker identity or creation time', async () => {
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
    const name = await screen.findByLabelText('What would you like to track?')
    await user.clear(name)
    await user.type(name, 'Updated name')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(navigation).toHaveBeenCalledWith('/trackers', expect.any(Object)))
    const saved = await localRepository.getTracker(existing.id)
    expect(saved?.id).toBe(existing.id)
    expect(saved?.createdAt).toBe(existing.createdAt)
    expect(saved?.name).toBe('Updated name')
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
