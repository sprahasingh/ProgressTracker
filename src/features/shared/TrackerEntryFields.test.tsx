import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TrackerDefinition } from '../../domain/trackers/types'
import { TrackerEntryFields } from './TrackerEntryFields'

afterEach(cleanup)

const base = {
  schemaVersion: 1 as const, id: 'shared-entry', name: 'Study', description: '', kind: 'habit' as const, status: 'active' as const, categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const }, qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
  customFields: [], milestones: [], createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', archivedAt: null, deletedAt: null,
} satisfies Omit<TrackerDefinition, 'metrics'>

describe('shared type-aware daily entry fields', () => {
  it('keeps unanswered boolean measures distinct from explicit Not done and Done answers', async () => {
    const setValue = vi.fn()
    const tracker: TrackerDefinition = { ...base, metrics: [{ id: 'done', name: 'Workout', valueType: 'boolean' }] }
    const user = userEvent.setup()
    render(<TrackerEntryFields tracker={tracker} values={{}} setValue={setValue} />)

    expect(screen.getByRole('button', { name: 'Not done' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Not done' }))
    expect(setValue).toHaveBeenLastCalledWith('done', false)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(setValue).toHaveBeenLastCalledWith('done', true)

    cleanup()
    render(<TrackerEntryFields tracker={tracker} values={{ done: false }} setValue={setValue} />)
    expect(screen.getByRole('button', { name: 'Not done' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('uses an independent configured increment for each numeric measure and previews configured targets', async () => {
    const setValue = vi.fn()
    const tracker: TrackerDefinition = {
      ...base,
      schemaVersion: 4,
      qualificationRule: { kind: 'threshold', metricId: 'problems', level: 'target' },
      metrics: [
        { id: 'problems', name: 'Problems', valueType: 'quantity', precision: { decimalPlaces: 0, increment: 1 }, thresholds: { direction: 'increase', target: 5, streakQualification: 'target' } },
        { id: 'hours', name: 'Hours', valueType: 'duration', unit: 'hours', precision: { decimalPlaces: 1, increment: 0.1 }, thresholds: { direction: 'increase', target: 2, streakQualification: 'target' } },
      ],
    }
    const user = userEvent.setup()
    const view = render(<TrackerEntryFields tracker={tracker} values={{ problems: 4, hours: 1.2 }} setValue={setValue} date="2026-10-10" />)

    expect(screen.getByRole('spinbutton', { name: 'Problems' })).toHaveValue('4')
    expect(screen.getByRole('spinbutton', { name: 'Hours' })).toHaveValue('1.2')
    expect(screen.getByText('1 remaining · target 5')).toBeInTheDocument()
    expect(screen.getByText('0.8 hours remaining · target 2 hours')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Increase Problems' }))
    expect(setValue).toHaveBeenLastCalledWith('problems', 5)
    await user.click(screen.getByRole('button', { name: 'Increase Hours' }))
    expect(setValue).toHaveBeenLastCalledWith('hours', 1.3)
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved preview')

    view.rerender(<TrackerEntryFields tracker={tracker} values={{ problems: 5, hours: 2 }} setValue={setValue} date="2026-10-10" />)
    expect(document.querySelector('.numeric-target-feedback')).toHaveTextContent('Target reached · target 5')
    view.rerender(<TrackerEntryFields tracker={tracker} values={{ problems: 7 }} setValue={setValue} date="2026-10-10" />)
    expect(document.querySelector('.numeric-target-feedback')).toHaveTextContent('Target exceeded by 2')
  })
})
