import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TrackerMetricDefinition } from '../../domain/trackers/types'
import { TrackerConfigurationEditor } from './TrackerConfigurationEditor'

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
})
