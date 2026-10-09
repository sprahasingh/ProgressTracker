import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoalPlanningEditor } from './GoalPlanningEditor'
import type { GoalPlanningConfiguration, TrackerMetricDefinition } from '../../domain/trackers/types'

const metrics: TrackerMetricDefinition[] = [
  { id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' },
  { id: 'steps', name: 'Steps', valueType: 'checklist', checklistItems: [{ id: 'a', label: 'A', position: 0 }, { id: 'b', label: 'B', position: 1 }] },
  { id: 'done', name: 'Done', valueType: 'boolean' },
]

describe('goal planning editor', () => {
  afterEach(cleanup)
  it('preserves both target maps when switching modes and excludes unsupported boolean targets', () => {
    const initial: GoalPlanningConfiguration = {
      mode: 'daily-recurring', progressSemantics: { pages: 'incremental' },
      dailyTargets: { pages: 5, steps: 1 }, cumulativeTargets: { pages: 100 },
    }
    const onChange = vi.fn()
    const { rerender } = render(<GoalPlanningEditor metrics={metrics} planning={initial} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Planning mode'), { target: { value: 'cumulative-deadline' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...initial, mode: 'cumulative-deadline' })
    rerender(<GoalPlanningEditor metrics={metrics} planning={{ ...initial, mode: 'cumulative-deadline' }} onChange={onChange} />)
    expect(screen.getByLabelText('Pages daily planning target')).toHaveValue(5)
    expect(screen.getByLabelText('Pages cumulative planning target')).toHaveValue(100)
    expect(screen.getByText('Yes/no measures do not support numeric planning targets.')).toBeInTheDocument()
  })

  it('requires explicit confirmation before treating existing entries as incremental totals', () => {
    const initial: GoalPlanningConfiguration = { mode: 'daily-recurring', progressSemantics: {}, dailyTargets: {}, cumulativeTargets: {} }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const onChange = vi.fn()
    render(<GoalPlanningEditor metrics={metrics.slice(0, 1)} planning={initial} onChange={onChange} />)
    fireEvent.change(screen.getAllByLabelText('Entry meaning for cumulative plans')[0]!, { target: { value: 'incremental' } })
    expect(confirm).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})
