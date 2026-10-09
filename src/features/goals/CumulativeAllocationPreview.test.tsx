import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { TrackerDefinition } from '../../domain/trackers/types'
import { CumulativeAllocationPreview } from './CumulativeAllocationPreview'

const tracker: TrackerDefinition = {
  schemaVersion: 2, id: 'preview-ui-goal', name: 'Write a guide', description: '', kind: 'goal', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' }, startDate: '2026-01-05', deadline: '2026-01-07',
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' }], customFields: [], milestones: [],
  goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: {}, cumulativeTargets: { pages: 10 } },
  createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z', archivedAt: null, deletedAt: null,
}

describe('cumulative allocation preview UI', () => {
  it('labels values as an unsaved preview and reports manual over-allocation', () => {
    render(<CumulativeAllocationPreview tracker={tracker} entries={[]} metricId="pages" startDate="2026-01-05" asOfDate="2026-01-05" timeZone="Asia/Kolkata" />)

    expect(screen.getByText('Unsaved proposal only. Adjustments disappear when you leave or refresh; actual check-ins, goal targets, and sync data are unchanged. Dates use the Asia/Kolkata workspace calendar.')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Preview allocation for 2026-01-05' })).toHaveValue(3.33)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Preview allocation for 2026-01-05' }), { target: { value: '5' } })
    expect(screen.getByText('1.67 pages is allocated beyond the remaining target.')).toBeInTheDocument()
    expect(screen.getAllByText('Actual recorded')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Reset even distribution' }))
    expect(screen.queryByText(/allocated beyond the remaining target/)).not.toBeInTheDocument()
  })
})
