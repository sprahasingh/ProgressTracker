import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CloudRecoveryFailure, type CloudRecoverySnapshot } from '../../services/supabase/cloudRecovery'
import appStyles from '../../styles.css?raw'
import { CloudRecoveryPanel } from './CloudRecoveryPanel'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../services/supabase/cloudRecovery', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../services/supabase/cloudRecovery')>()), readCloudRecoverySnapshot: mocks.read }))

const snapshot: CloudRecoverySnapshot = {
  retrievedAt: '2026-11-06T09:00:00.000Z',
  schemaCompatibility: 'current',
  trackers: [{ record: {
    schemaVersion: 1, id: 'track-a', name: 'Read daily', description: '', kind: 'habit', status: 'active', categoryId: null,
    tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' }],
    qualificationRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 1 }, customFields: [], milestones: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', archivedAt: null, deletedAt: null,
  }, serverRevision: 3 }],
  entries: [{ record: { id: 'entry-a', trackerId: 'track-a', date: '2026-11-06', outcome: 'recorded', values: { pages: 4 }, note: '', createdAt: '2026-11-06T08:00:00.000Z', updatedAt: '2026-11-06T08:00:00.000Z', deletedAt: null }, serverRevision: 5 }],
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('CloudRecoveryPanel', () => {
  it('discloses a pre-existing operation that remains pending and prevents local retry until it settles', () => {
    render(<CloudRecoveryPanel userId="owner-a" onRetryLocal={vi.fn()} operationsPending initializationPending />)
    expect(screen.getByText(/workspace initialization or synchronization that started before recovery is still running/)).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: 'Retry local workspace' })).toBeDisabled()
  })

  it('does not imply that a settled pre-recovery operation completed successfully', () => {
    render(<CloudRecoveryPanel userId="owner-a" onRetryLocal={vi.fn()} operationsSettled />)
    expect(screen.getByText(/has settled\. This does not confirm that synchronization succeeded/)).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: 'Retry local workspace' })).toBeEnabled()
  })

  it('labels the snapshot read-only, shows values and freshness, and only offers safe retry actions', async () => {
    mocks.read.mockResolvedValue(snapshot)
    const retryLocal = vi.fn()
    const user = userEvent.setup()
    render(<CloudRecoveryPanel userId="owner-a" onRetryLocal={retryLocal} />)
    expect(await screen.findByRole('heading', { name: 'Cloud Recovery — Read Only' })).toBeInTheDocument()
    expect(screen.getByText('Cloud revision 3')).toBeInTheDocument()
    expect(screen.getByText(/Recorded · cloud revision 5/)).toBeInTheDocument()
    expect(screen.getByText('Pages (pages)')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText(/Cloud records read at/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /check in|edit|delete|save|sync now/i })).not.toBeInTheDocument()
    expect(appStyles).toContain('.cloud-recovery-actions { display: flex; flex-wrap: wrap;')
    expect(appStyles).toContain('@media (max-width: 600px) {\n  .cloud-recovery {')
    await user.click(screen.getByRole('button', { name: 'Retry local workspace' }))
    expect(retryLocal).toHaveBeenCalledOnce()
  })

  it('distinguishes cloud authentication/network errors and can retry the cloud read', async () => {
    mocks.read.mockRejectedValueOnce(new CloudRecoveryFailure('network')).mockResolvedValueOnce(snapshot)
    const user = userEvent.setup()
    render(<CloudRecoveryPanel userId="owner-a" onRetryLocal={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('cloud snapshot could not be reached')
    await user.click(screen.getByRole('button', { name: 'Retry cloud read' }))
    expect(await screen.findByText('Cloud revision 3')).toBeInTheDocument()
  })

  it('states that an empty cloud response cannot establish that local records are absent', async () => {
    mocks.read.mockResolvedValue({ retrievedAt: snapshot.retrievedAt, schemaCompatibility: 'current', trackers: [], entries: [] })
    render(<CloudRecoveryPanel userId="owner-a" onRetryLocal={vi.fn()} />)
    expect(await screen.findByText(/This does not establish whether this device has unsynchronized local records/)).toBeInTheDocument()
  })

  it('discloses when an older cloud schema cannot contain explicit holiday treatment', async () => {
    mocks.read.mockResolvedValue({ ...snapshot, schemaCompatibility: 'legacy-no-holiday-treatment' })
    render(<CloudRecoveryPanel userId="owner-a" onRetryLocal={vi.fn()} />)
    expect(await screen.findByText(/predates explicit holiday-treatment storage/)).toHaveAttribute('role', 'status')
  })
})
