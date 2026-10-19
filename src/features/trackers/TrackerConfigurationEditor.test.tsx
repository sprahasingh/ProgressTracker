import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TrackerMetricDefinition, TrackerMilestoneDefinition, TrackerRule } from '../../domain/trackers/types'
import { TrackerConfigurationEditor } from './TrackerConfigurationEditor'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const metric: TrackerMetricDefinition = {
  id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages',
  thresholds: { direction: 'increase', minimum: 1, target: 5, streakQualification: 'minimum' },
}

describe('Tracker configuration explanations', () => {
  it('distinguishes success-rule completion from streak qualification in both modes', async () => {
    const user = userEvent.setup()
    render(<TrackerConfigurationEditor
      metrics={[metric]} onMetricsChange={vi.fn()} rule={{ kind: 'threshold', metricId: 'pages', level: 'target' }} onRuleChange={vi.fn()}
      customFields={[]} onCustomFieldsChange={vi.fn()} milestones={[]} onMilestonesChange={vi.fn()}
    />)

    await user.click(screen.getByRole('button', { name: 'More about Streak qualification' }))
    const dialog = screen.getByRole('dialog', { name: 'Streak qualification' })
    expect(dialog).toHaveTextContent('New explicit Streak Rules are configured separately below the Success Rule')
    expect(dialog).toHaveTextContent('Completed without qualifying for a streak')
    expect(dialog).toHaveTextContent('Standard Mode counts scheduled opportunities')
    expect(dialog).toHaveTextContent('Strict Mode requires qualifying activity on every active date')
  })

  it('creates a typed quantity milestone with a measure-specific target and live calculation preview', async () => {
    const user = userEvent.setup()
    const metrics: TrackerMetricDefinition[] = [
      metric,
      { id: 'focus', name: 'Focus Time', valueType: 'duration', unit: 'hours' },
    ]
    function MilestoneHarness() {
      const [milestones, setMilestones] = useState<TrackerMilestoneDefinition[]>([])
      return <TrackerConfigurationEditor
        section="milestones" milestoneContext={{ metrics, kind: 'goal', schedule: { kind: 'every-day' }, strictMode: false, scheduling: { mode: 'ongoing' }, deadline: undefined }}
        metrics={metrics} onMetricsChange={vi.fn()} rule={undefined} onRuleChange={vi.fn()}
        customFields={[]} onCustomFieldsChange={vi.fn()} milestones={milestones} onMilestonesChange={setMilestones}
      />
    }
    render(<MilestoneHarness />)
    await user.click(screen.getByRole('button', { name: '＋ Add milestone' }))
    const type = screen.getByRole('combobox', { name: 'What should this milestone track?' })
    expect(type).toHaveValue('cumulative-quantity')
    expect(screen.getByText('Target total pages')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Which measure?' }), 'focus')
    expect(screen.getByText('Target total hours')).toBeInTheDocument()
    const target = screen.getByRole('spinbutton', { name: 'Target total hours' })
    await user.type(target, '50')
    expect(screen.getByText('Record 50 hours for Focus Time in total.')).toBeInTheDocument()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.selectOptions(type, 'single-day-quantity')
    expect(await screen.findByText('Hours in one day')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Hours in one day' })).toHaveValue(null)
    vi.restoreAllMocks()
  })

  it('defaults a Yes/No measure to completion dates and offers only valid completion types', async () => {
    const user = userEvent.setup()
    const yesNo: TrackerMetricDefinition = { id: 'theory', name: 'Studied Theory', valueType: 'boolean' }
    function MilestoneHarness() {
      const [milestones, setMilestones] = useState<TrackerMilestoneDefinition[]>([])
      return <TrackerConfigurationEditor
        section="milestones" milestoneContext={{ metrics: [yesNo], kind: 'habit', schedule: { kind: 'every-day' }, strictMode: false, scheduling: { mode: 'ongoing' }, deadline: undefined }}
        metrics={[yesNo]} onMetricsChange={vi.fn()} rule={undefined} onRuleChange={vi.fn()}
        customFields={[]} onCustomFieldsChange={vi.fn()} milestones={milestones} onMilestonesChange={setMilestones}
      />
    }
    render(<MilestoneHarness />)
    await user.click(screen.getByRole('button', { name: '＋ Add milestone' }))
    const type = screen.getByRole('combobox', { name: 'What should this milestone track?' })
    expect(type).toHaveValue('measure-completion-count')
    expect(screen.getByText('Target completed days')).toBeInTheDocument()
    const target = screen.getByRole('spinbutton', { name: 'Target completed days' })
    await user.type(target, '20')
    expect(screen.getByText('Record Studied Theory as Done on 20 eligible dates.')).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Total quantity recorded' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Quantity in a single day' })).not.toBeInTheDocument()
  })

  it('preserves an old checkpoint until the user confirms a type conversion', async () => {
    const legacy: TrackerMilestoneDefinition = { id: 'old', title: 'Old checkpoint', description: '', metricId: 'pages', targetValue: 50, position: 0 }
    const user = userEvent.setup()
    const changeMilestones = vi.fn()
    render(<TrackerConfigurationEditor
      section="milestones" milestoneContext={{ metrics: [metric], kind: 'goal', schedule: { kind: 'every-day' }, strictMode: false, scheduling: { mode: 'ongoing' }, deadline: undefined }}
      metrics={[metric]} onMetricsChange={vi.fn()} rule={undefined} onRuleChange={vi.fn()}
      customFields={[]} onCustomFieldsChange={vi.fn()} milestones={[legacy]} onMilestonesChange={changeMilestones}
    />)
    expect(screen.getByText('This saved checkpoint still compares its best single recorded value. Choose another type to convert it; its old target will be cleared.')).toBeInTheDocument()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const type = screen.getByRole('combobox', { name: 'What should this milestone track?' })
    await user.selectOptions(type, 'cumulative-quantity')
    expect(changeMilestones).not.toHaveBeenCalled()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.selectOptions(type, 'cumulative-quantity')
    expect(changeMilestones).toHaveBeenCalledWith([expect.objectContaining({ type: 'cumulative-quantity', targetValue: undefined, measureTypeSnapshot: 'quantity' })])
    vi.restoreAllMocks()
  })

  it('saves the positive preset as greater-than zero, supports a custom comparison, and reopens with the friendly label', async () => {
    const user = userEvent.setup()
    const duration: TrackerMetricDefinition = { id: 'minutes', name: 'Minutes', valueType: 'duration', unit: 'minutes' }
    const initialRule = { kind: 'comparison' as const, metricId: 'pages', operator: 'greater-than' as const, value: 0 }
    let latestRule: TrackerRule = initialRule
    function StreakRuleHarness({ initial = initialRule }: { initial?: TrackerRule }) {
      const [streakRule, setStreakRule] = useState<TrackerRule>(initial)
      return <TrackerConfigurationEditor
        section="streak-rules" metrics={[metric, duration]} onMetricsChange={vi.fn()} rule={undefined} onRuleChange={vi.fn()}
        customFields={[]} onCustomFieldsChange={vi.fn()} milestones={[]} onMilestonesChange={vi.fn()}
        streakRuleMode="custom" streakRule={streakRule} onStreakRuleChange={(next) => { if (next) { latestRule = next; setStreakRule(next) } }}
      />
    }

    const rendered = render(<StreakRuleHarness />)
    const condition = screen.getByRole('combobox', { name: 'Condition' })
    expect(condition).toHaveValue('positive-value')
    expect(screen.getByText('Streak summary: Pages has any positive value')).toBeInTheDocument()
    await user.selectOptions(condition, 'greater-than')
    expect(condition).toHaveValue('greater-than')
    expect(screen.getByRole('spinbutton', { name: 'Value' })).toHaveValue(0)
    await user.clear(screen.getByRole('spinbutton', { name: 'Value' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Value' }), '0.25')
    expect(condition).toHaveValue('greater-than')
    expect(latestRule).toMatchObject({ operator: 'greater-than', value: 0.25 })
    await user.selectOptions(condition, 'positive-value')
    expect(latestRule).toMatchObject({ operator: 'greater-than', value: 0 })
    rendered.unmount()

    render(<StreakRuleHarness initial={latestRule} />)
    expect(screen.getByRole('combobox', { name: 'Condition' })).toHaveValue('positive-value')
    expect(screen.getByText('Streak summary: Pages has any positive value')).toBeInTheDocument()
  })

  it('offers the preset to quantity, duration, and checklist measures, then resets it for Yes/No', async () => {
    const user = userEvent.setup()
    const duration: TrackerMetricDefinition = { id: 'minutes', name: 'Minutes', valueType: 'duration' }
    const checklist: TrackerMetricDefinition = { id: 'steps', name: 'Steps', valueType: 'checklist', checklistItems: [{ id: 'one', label: 'One', position: 0 }, { id: 'two', label: 'Two', position: 1 }] }
    const yesNo: TrackerMetricDefinition = { id: 'done', name: 'Done', valueType: 'boolean' }
    function StreakRuleHarness() {
      const [streakRule, setStreakRule] = useState<{ kind: 'comparison'; metricId: string; operator: 'equals' | 'greater-than' | 'at-least' | 'at-most'; value: boolean | number }>({ kind: 'comparison', metricId: 'pages', operator: 'greater-than', value: 0 })
      return <TrackerConfigurationEditor
        section="streak-rules" metrics={[metric, duration, checklist, yesNo]} onMetricsChange={vi.fn()} rule={undefined} onRuleChange={vi.fn()}
        customFields={[]} onCustomFieldsChange={vi.fn()} milestones={[]} onMilestonesChange={vi.fn()}
        streakRuleMode="custom" streakRule={streakRule} onStreakRuleChange={(next) => next?.kind === 'comparison' && setStreakRule(next)}
      />
    }
    render(<StreakRuleHarness />)
    const condition = screen.getByRole('combobox', { name: 'Condition' })
    const measureSelect = screen.getByRole('combobox', { name: 'Measure' })
    expect(screen.getByRole('option', { name: 'Any positive value (> 0)' })).toBeInTheDocument()
    await user.selectOptions(measureSelect, 'minutes')
    expect(condition).toHaveValue('at-least')
    expect(screen.getByRole('option', { name: 'Any positive value (> 0)' })).toBeInTheDocument()
    await user.selectOptions(measureSelect, 'steps')
    expect(condition).toHaveValue('at-least')
    expect(screen.getByRole('option', { name: 'Any positive value (> 0)' })).toBeInTheDocument()
    await user.selectOptions(condition, 'positive-value')
    expect(condition).toHaveValue('positive-value')
    await user.selectOptions(measureSelect, 'done')
    expect(condition).toHaveValue('equals')
    expect(screen.queryByRole('option', { name: 'Any positive value (> 0)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Greater than' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Value' })).toHaveValue('true')
  })

  it('keeps the generic greater-than option out of the Success Rule editor', () => {
    render(<TrackerConfigurationEditor
      section="rules" metrics={[metric]} onMetricsChange={vi.fn()} rule={{ kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 1 }} onRuleChange={vi.fn()}
      customFields={[]} onCustomFieldsChange={vi.fn()} milestones={[]} onMilestonesChange={vi.fn()}
    />)
    expect(screen.queryByRole('option', { name: 'Any positive value (> 0)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Greater than' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Condition' })).toHaveAccessibleName('Condition')
  })
})
