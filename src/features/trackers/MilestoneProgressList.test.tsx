import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { TrackerDefinition, TrackerEntry } from '../../domain/trackers/types'
import { MilestoneProgressList } from './MilestoneProgressList'

describe('MilestoneProgressList', () => {
  it('shows the named calculation, capped completion meter, and historical crossing date', () => {
    const tracker: TrackerDefinition = {
      schemaVersion: 9,
      id: 'dsa', name: '100 Days of DSA', description: '', kind: 'challenge', status: 'active', categoryId: null,
      tags: [], icon: '', accent: '#315e46', schedule: { kind: 'every-day' }, startDate: '2026-01-01', deadline: '2026-04-10',
      scheduling: { mode: 'effective', effectiveDays: 100, effectiveDayCounting: 'planned-activity-days' },
      metrics: [{ id: 'problems', name: 'DSA Problems', valueType: 'quantity', unit: 'problems' }],
      qualificationRule: { kind: 'comparison', metricId: 'problems', operator: 'at-least', value: 1 },
      customFields: [], milestones: [{ id: 'total', title: 'First 50 Problems', description: '', type: 'cumulative-quantity', metricId: 'problems', targetValue: 50, measureTypeSnapshot: 'quantity', unitSnapshot: 'problems', position: 0 }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    const entries: TrackerEntry[] = [
      { id: 'one', trackerId: 'dsa', date: '2026-01-01', outcome: 'recorded', values: { problems: 20 }, note: '', createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z', deletedAt: null },
      { id: 'two', trackerId: 'dsa', date: '2026-01-02', outcome: 'recorded', values: { problems: 45 }, note: '', createdAt: '2026-01-02T12:00:00.000Z', updatedAt: '2026-01-02T12:00:00.000Z', deletedAt: null },
    ]
    render(<MilestoneProgressList tracker={tracker} entries={entries} asOfDate="2026-01-02" />)
    expect(screen.getByText('First 50 Problems')).toBeInTheDocument()
    expect(screen.getByText('Total quantity recorded')).toBeInTheDocument()
    expect(screen.getByText('Record 50 DSA Problems in total.')).toBeInTheDocument()
    expect(screen.getByText('65 / 50 problems total')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByText(/^Target reached /)).toBeInTheDocument()
  })
})
