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

afterEach(() => cleanup())

describe('cumulative allocation preview UI', () => {
  it('labels values as a preview, tracks unsaved edits, and reports manual over-allocation', () => {
    render(<CumulativeAllocationPreview tracker={tracker} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-05" timeZone="Asia/Kolkata" onSave={vi.fn()} v3WritesEnabled />)

    expect(screen.getByText('Preview only. Allocations become persistent only after Save Plan. Planned amounts remain separate from actual check-ins. Dates use the Asia/Kolkata planning calendar.')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Allocation for 2026-01-05' })).toHaveValue(3.33)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Allocation for 2026-01-05' }), { target: { value: '5' } })
    expect(screen.getByText('UNSAVED CHANGES')).toBeInTheDocument()
    expect(screen.getByText('1.67 pages is allocated beyond the remaining target.')).toBeInTheDocument()
    expect(screen.getAllByText('Actual recorded')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Suggested Allocation' }))
    expect(screen.queryByText(/allocated beyond the remaining target/)).not.toBeInTheDocument()
  })

  it('saves allocations as v3 with the planning timezone and can discard unsaved changes', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CumulativeAllocationPreview tracker={tracker} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-05" timeZone="Asia/Kolkata" onSave={onSave} v3WritesEnabled />)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Allocation for 2026-01-05' }), { target: { value: '4' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save Plan' })[0]!)
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ schemaVersion: 3, goalPlanning: { planningTimeZone: 'Asia/Kolkata', allocations: { pages: { '2026-01-05': 4 } } } })

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Allocation for 2026-01-05' }), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }))
    expect(screen.getByRole('spinbutton', { name: 'Allocation for 2026-01-05' })).toHaveValue(3.33)
    expect(screen.queryByText('UNSAVED CHANGES')).not.toBeInTheDocument()
  })

  it('offers a newly balanced pace after progress while preserving the confirmed plan until chosen', async () => {
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
    }]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-06" timeZone="UTC" onSave={onSave} v3WritesEnabled />)

    expect(screen.getByText('Some saved allocations no longer match this metric’s whole-unit precision. Your saved plan is unchanged.')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Allocation for 2026-01-07' })).toHaveValue(4)
    fireEvent.click(screen.getByRole('button', { name: 'Use updated suggestion' }))
    expect(screen.getByRole('spinbutton', { name: 'Unsaved allocation for 2026-01-07' })).toHaveValue(3)
    expect(screen.getByText('UNSAVED CHANGES')).toBeInTheDocument()
    expect(savedGoal.goalPlanning?.allocations?.pages?.['2026-01-07']).toBe(4)
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/This reset replaces the saved allocation schedule/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Save Plan' })[0]!)
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]?.[0].goalPlanning?.allocations?.pages).toEqual({ '2026-01-06': 3, '2026-01-07': 3 })
  })
})
