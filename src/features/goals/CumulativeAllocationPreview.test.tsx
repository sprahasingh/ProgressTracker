import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TrackerDefinition } from '../../domain/trackers/types'
import { CumulativeAllocationPreview } from './CumulativeAllocationPreview'

const tracker: TrackerDefinition = {
  schemaVersion: 2, id: 'preview-ui-goal', name: 'Write a guide', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' }, startDate: '2026-01-05', deadline: '2026-01-07',
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' }], customFields: [], milestones: [],
  goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: {}, cumulativeTargets: { pages: 10 } },
  createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('cumulative allocation preview UI', () => {
  it('labels values as a preview, tracks manual edits, and immediately redistributes automatic dates', () => {
    render(<CumulativeAllocationPreview tracker={tracker} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-05" timeZone="Asia/Kolkata" onSave={vi.fn()} manualPlanWritesEnabled />)

    expect(screen.getByText(/Auto amounts recalculate from remaining work/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Daily schedule/))
    expect(screen.getByText('3.34 pages')).toBeInTheDocument()
    expect(screen.getAllByText('Auto')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan for 2026-01-05' }))
    expect(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-05' })).toHaveValue(3.34)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-05' }), { target: { value: '5' } })
    expect(screen.getByText('UNSAVED CHANGES')).toBeInTheDocument()
    expect(screen.queryByText(/allocated beyond the remaining target/)).not.toBeInTheDocument()
    expect(screen.getAllByText('Auto')).toHaveLength(2)
    expect(screen.getByText('Manual')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Completed' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Planned' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save manual changes' })).toBeInTheDocument()
  })

  it('saves only explicit manual allocations through the existing tracker sync payload', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CumulativeAllocationPreview tracker={tracker} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-05" timeZone="Asia/Kolkata" onSave={onSave} manualPlanWritesEnabled />)
    fireEvent.click(screen.getByText(/Daily schedule/))
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan for 2026-01-05' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-05' }), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save manual changes' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ schemaVersion: 5, goalPlanning: { planningTimeZone: 'Asia/Kolkata', allocations: {}, manualAllocations: { pages: { '2026-01-05': 4 } } } })

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-05' }), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }))
    expect(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-05' })).toHaveValue(3.34)
    expect(screen.queryByText('UNSAVED CHANGES')).not.toBeInTheDocument()
  })

  it('warns about ambiguous legacy allocations and keeps historical planned values', async () => {
    const savedGoal: TrackerDefinition = {
      ...tracker,
      schemaVersion: 4,
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 0, increment: 1 } }],
      goalPlanning: { ...tracker.goalPlanning!, planningTimeZone: 'UTC', allocations: { pages: { '2026-01-05': 1.5, '2026-01-06': 3, '2026-01-07': 4 } } },
    }
    const onSave = vi.fn()
    render(<CumulativeAllocationPreview tracker={savedGoal} entries={[{
      id: 'done-today', trackerId: savedGoal.id, date: '2026-01-05', outcome: 'recorded', values: { pages: 4 }, note: '',
      createdAt: '2026-01-05T09:00:00.000Z', updatedAt: '2026-01-05T09:00:00.000Z', deletedAt: null,
    }]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-06" timeZone="UTC" onSave={onSave} manualPlanWritesEnabled />)

    expect(screen.getByText(/does not identify which dates you edited/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan for 2026-01-07' }))
    expect(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-07' })).toHaveValue(3)
    expect(screen.getByText('1.5 pages')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Planned' })).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('recalculates generated amounts after check-in edits without rewriting tracker data', () => {
    const savedGoal: TrackerDefinition = {
      ...tracker,
      schemaVersion: 4,
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 0, increment: 1 } }],
      goalPlanning: { ...tracker.goalPlanning!, planningTimeZone: 'UTC', cumulativeTargets: { pages: 12 }, allocations: { pages: { '2026-01-06': 3, '2026-01-07': 3 } } },
    }
    const view = render(<CumulativeAllocationPreview tracker={savedGoal} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-06" timeZone="UTC" onSave={vi.fn()} manualPlanWritesEnabled />)
    fireEvent.click(screen.getByText(/Daily schedule/))
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan for 2026-01-06' }))
    const allocationInput = screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-06' })
    expect(allocationInput).toHaveValue(6)

    view.rerender(<CumulativeAllocationPreview tracker={savedGoal} entries={[{
      id: 'done-today', trackerId: savedGoal.id, date: '2026-01-06', outcome: 'recorded', values: { pages: 4 }, note: '',
      createdAt: '2026-01-06T09:00:00.000Z', updatedAt: '2026-01-06T09:00:00.000Z', deletedAt: null,
    }]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-06" timeZone="UTC" onSave={vi.fn()} manualPlanWritesEnabled />)

    expect(screen.queryByRole('button', { name: 'Edit plan for 2026-01-06' })).not.toBeInTheDocument()
    expect(screen.getByText('3 pages')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan for 2026-01-07' }))
    expect(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-07' })).toHaveValue(8)
    expect(savedGoal.goalPlanning?.allocations?.pages).toEqual({ '2026-01-06': 3, '2026-01-07': 3 })
  })

  it('requires an explicit choice for ambiguous legacy plans and preserves them only when requested', () => {
    const savedGoal: TrackerDefinition = {
      ...tracker, schemaVersion: 4,
      goalPlanning: { ...tracker.goalPlanning!, planningTimeZone: 'UTC', allocations: { pages: { '2026-01-06': 3, '2026-01-07': 4 } } },
    }
    const onSave = vi.fn()
    render(<CumulativeAllocationPreview tracker={savedGoal} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-05" timeZone="UTC" onSave={onSave} manualPlanWritesEnabled />)
    fireEvent.click(screen.getByText(/Daily schedule/))
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan for 2026-01-05' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-05' }), { target: { value: '5' } })
    expect(screen.getByRole('button', { name: 'Save manual changes' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep previous future values as manual' }))
    expect(screen.getByRole('button', { name: 'Save manual changes' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan for 2026-01-06' }))
    expect(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-06' })).toHaveValue(3)
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan for 2026-01-07' }))
    expect(screen.getByRole('spinbutton', { name: 'Planned allocation for 2026-01-07' })).toHaveValue(4)
  })

  it('releases an individual manual date back to automatic planning', async () => {
    const savedGoal: TrackerDefinition = {
      ...tracker,
      schemaVersion: 5,
      goalPlanning: { ...tracker.goalPlanning!, planningTimeZone: 'UTC', allocations: { pages: {} }, manualAllocations: { pages: { '2026-01-06': 3 } } },
    }
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CumulativeAllocationPreview tracker={savedGoal} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-05" timeZone="UTC" onSave={onSave} manualPlanWritesEnabled />)
    fireEvent.click(screen.getByText(/Daily schedule/))
    expect(screen.getByText('Manual')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset 2026-01-06 to Auto' }))
    expect(screen.getAllByText('Auto').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Save manual changes' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]?.[0].goalPlanning?.manualAllocations?.pages).toEqual({})
  })

  it('confirms and saves a future-only reset while preserving historical overrides and progress', async () => {
    const savedGoal: TrackerDefinition = {
      ...tracker,
      schemaVersion: 5,
      goalPlanning: { ...tracker.goalPlanning!, planningTimeZone: 'UTC', allocations: {}, manualAllocations: { pages: { '2026-01-05': 2, '2026-01-06': 4, '2026-01-07': 4 } } },
    }
    const entry = { id: 'saved-checkin', trackerId: savedGoal.id, date: '2026-01-05', outcome: 'recorded' as const, values: { pages: 2 }, note: '', createdAt: '2026-01-05T10:00:00.000Z', updatedAt: '2026-01-05T10:00:00.000Z', deletedAt: null }
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CumulativeAllocationPreview tracker={savedGoal} entries={[entry]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-06" timeZone="UTC" onSave={onSave} manualPlanWritesEnabled />)
    expect(screen.getByLabelText('Planning controls')).toHaveTextContent('2 Manual overrides')
    fireEvent.click(screen.getByRole('button', { name: 'Reset future overrides' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Your completed progress and past plans will stay unchanged.'))
    expect(screen.getByRole('button', { name: 'Save manual changes' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save manual changes' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]?.[0].goalPlanning?.manualAllocations?.pages).toEqual({ '2026-01-05': 2 })
    expect(entry.values.pages).toBe(2)
    expect(await screen.findByText(/Future Manual allocations reset to Auto/)).toBeInTheDocument()
  })

  it('keeps future overrides unchanged when Reset future overrides confirmation is cancelled', () => {
    const savedGoal: TrackerDefinition = {
      ...tracker,
      schemaVersion: 5,
      goalPlanning: { ...tracker.goalPlanning!, planningTimeZone: 'UTC', allocations: {}, manualAllocations: { pages: { '2026-01-06': 4 } } },
    }
    vi.stubGlobal('confirm', vi.fn(() => false))
    const onSave = vi.fn()
    render(<CumulativeAllocationPreview tracker={savedGoal} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-05" timeZone="UTC" onSave={onSave} manualPlanWritesEnabled />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset future overrides' }))
    expect(screen.getByLabelText('Planning controls')).toHaveTextContent('1 Manual override')
    expect(screen.queryByRole('button', { name: 'Save manual changes' })).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('reports bulk reset persistence failures without claiming the change was saved', async () => {
    const savedGoal: TrackerDefinition = {
      ...tracker,
      schemaVersion: 5,
      goalPlanning: { ...tracker.goalPlanning!, planningTimeZone: 'UTC', allocations: {}, manualAllocations: { pages: { '2026-01-06': 4 } } },
    }
    vi.stubGlobal('confirm', vi.fn(() => true))
    render(<CumulativeAllocationPreview tracker={savedGoal} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-05" timeZone="UTC" onSave={vi.fn().mockRejectedValue(new Error('storage unavailable'))} manualPlanWritesEnabled />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset future overrides' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save manual changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('storage unavailable')
    expect(screen.queryByText(/Future Manual allocations reset to Auto/)).not.toBeInTheDocument()
  })
})
