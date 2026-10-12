import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { AIKnowledgePage } from './AIKnowledgePage'
import type { MaintainerAccess } from './useMaintainerAccess'

const mocks = vi.hoisted(() => ({
  list: vi.fn(), getCandidate: vi.fn(), getVerifiedTopic: vi.fn(), review: vi.fn(), revalidate: vi.fn(),
  authStatus: 'signed-in', signOut: vi.fn().mockResolvedValue(null),
}))
vi.mock('./aiKnowledgeApi', () => ({
  listKnowledge: mocks.list, getCandidate: mocks.getCandidate, getVerifiedTopic: mocks.getVerifiedTopic,
  reviewCandidate: mocks.review, revalidateTopic: mocks.revalidate, ReviewApiError: class ReviewApiError extends Error { status = 0 },
}))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: mocks.authStatus, signOut: mocks.signOut }) }))

const candidate = {
  id: 'candidate-1', topic_id: 'tracker.measure', title: 'Measures', explanation: 'Measures record tracker progress.', detailed_explanation: null,
  feature_category: 'trackers', source_refs: ['src/features/trackers/TrackerSetupPage.tsx'], source_fingerprints: {}, knowledge_version: 'v1',
  status: 'pending', created_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-12T00:00:00.000Z', reviewed_at: null, reviewer_id: null,
}
const detail = { knowledge_version: 'v1', candidate, current_evidence: 'SOURCE tracker measure definitions', review_history: [] }

function renderPage(access: MaintainerAccess = { status: 'authorized', refresh: vi.fn() }) {
  return render(<MemoryRouter initialEntries={['/ai-knowledge']}><Routes><Route element={<Outlet context={access} />}><Route path="/ai-knowledge" element={<AIKnowledgePage />} /></Route><Route path="/auth" element={<h1>Sign in</h1>} /></Routes></MemoryRouter>)
}

afterEach(() => {
  cleanup()
  mocks.list.mockReset()
  mocks.getCandidate.mockReset()
  mocks.getVerifiedTopic.mockReset()
  mocks.review.mockReset()
  mocks.revalidate.mockReset()
  mocks.authStatus = 'signed-in'
  mocks.signOut.mockClear()
})

describe('AI Knowledge dashboard', () => {
  it('shows counts and server-filtered knowledge rows', async () => {
    mocks.list.mockResolvedValue({ knowledge_version: '0.1.0+0592eabb3aa5', candidates: [candidate], verified_knowledge: [], counts: { pending: 1, approved: 3, stale: 2, rejected: 0 }, page: { limit: 50, offset: 0, has_more: false } })
    renderPage()
    expect(await screen.findByRole('button', { name: /Measures/ })).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('Knowledge content version:').parentElement).toHaveTextContent('0.1.0')
    expect(screen.getByText('0.1.0+0592eabb3aa5')).not.toBeVisible()
    await userEvent.click(screen.getByText('Technical bundle details'))
    expect(screen.getByText('0.1.0+0592eabb3aa5')).toBeVisible()
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending', limit: 50, offset: 0 }))
  })

  it('shows candidate API errors without false zero counts or an empty state, then retries', async () => {
    mocks.list.mockRejectedValueOnce(new Error('The review service is temporarily unavailable. Try again.'))
      .mockResolvedValueOnce({ candidates: [], verified_knowledge: [], counts: { pending: 0, approved: 0, stale: 0, rejected: 0 }, page: { limit: 50, offset: 0, has_more: false } })
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('review service is temporarily unavailable')
    expect(screen.queryByText('No pending knowledge')).not.toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No pending knowledge')).toBeInTheDocument()
    expect(screen.getAllByText('0')).toHaveLength(4)
  })

  it('sends searches to the server and loads the next page on demand', async () => {
    const nextCandidate = { ...candidate, id: 'candidate-2', topic_id: 'goal.progress', title: 'Goal progress' }
    mocks.list.mockResolvedValueOnce({ candidates: [candidate], verified_knowledge: [], counts: { pending: 2, approved: 0, stale: 0, rejected: 0 }, page: { limit: 50, offset: 0, has_more: true } })
      .mockResolvedValueOnce({ candidates: [nextCandidate], verified_knowledge: [], counts: { pending: 2, approved: 0, stale: 0, rejected: 0 }, page: { limit: 50, offset: 1, has_more: false } })
      .mockResolvedValueOnce({ candidates: [], verified_knowledge: [], counts: { pending: 0, approved: 0, stale: 0, rejected: 0 }, page: { limit: 50, offset: 0, has_more: false } })
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: /Measures/ })
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('button', { name: /Goal progress/ })).toBeInTheDocument()
    expect(mocks.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 1 }))
    await user.type(screen.getByRole('textbox', { name: 'Search topic and knowledge text' }), 'deadline')
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await waitFor(() => expect(mocks.list).toHaveBeenNthCalledWith(3, expect.objectContaining({ search: 'deadline', offset: 0 })))
  })

  it('requires explicit approval confirmation, then refreshes after the server accepts', async () => {
    mocks.list.mockResolvedValue({ candidates: [candidate], verified_knowledge: [], counts: { pending: 1, approved: 0, stale: 0, rejected: 0 }, page: { limit: 50, offset: 0, has_more: false } })
    mocks.getCandidate.mockResolvedValue(detail)
    mocks.review.mockResolvedValue({ result: { status: 'verified' } })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /Measures/ }))
    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(mocks.review).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }))
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith('approve', candidate, expect.objectContaining({ topic_id: 'tracker.measure' })))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
  })

  it('does not reveal the dashboard to a server-denied maintainer session', async () => {
    mocks.authStatus = 'signed-in'
    mocks.list.mockResolvedValue({ candidates: [], verified_knowledge: [], counts: { pending: 0, approved: 0, stale: 0, rejected: 0 }, page: { limit: 50, offset: 0, has_more: false } })
    renderPage({ status: 'denied', refresh: vi.fn() })
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('keeps a candidate available for review when approval fails', async () => {
    mocks.list.mockResolvedValue({ candidates: [candidate], verified_knowledge: [], counts: { pending: 1, approved: 0, stale: 0, rejected: 0 }, page: { limit: 50, offset: 0, has_more: false } })
    mocks.getCandidate.mockResolvedValue(detail)
    mocks.review.mockRejectedValue(new Error('Candidate changed during review. Refresh and retry.'))
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /Measures/ }))
    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Candidate changed during review')
    expect(screen.getByRole('heading', { name: 'Measures' })).toBeInTheDocument()
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  it('queues stale knowledge for a new review instead of approving it', async () => {
    const staleTopic = { topic_id: 'tracker.measure', title: 'Measures', explanation: 'Measures record tracker progress.', detailed_explanation: null,
      feature_category: 'trackers', source_refs: ['src/features/trackers/TrackerSetupPage.tsx'], source_fingerprints: {}, knowledge_version: 'v0',
      status: 'stale' as const, reviewed_at: '2026-10-01T00:00:00.000Z', stale_at: '2026-10-11T00:00:00.000Z' }
    mocks.list.mockResolvedValue({ candidates: [], verified_knowledge: [staleTopic], counts: { pending: 0, approved: 0, stale: 1, rejected: 0 }, page: { limit: 50, offset: 0, has_more: false } })
    mocks.getVerifiedTopic.mockResolvedValue({ knowledge_version: 'v1', entry: staleTopic, current_evidence: 'Current source content', review_history: [] })
    mocks.revalidate.mockResolvedValue({ result: {}, requires_approval: true })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('tab', { name: 'Stale' }))
    await user.click(await screen.findByRole('button', { name: /Measures/ }))
    await user.click(await screen.findByRole('button', { name: 'Queue for re-review' }))
    await waitFor(() => expect(mocks.revalidate).toHaveBeenCalledOnce())
    expect(mocks.review).not.toHaveBeenCalled()
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('redirects signed-out users to sign in', async () => {
    mocks.authStatus = 'signed-out'
    renderPage({ status: 'signed-out', refresh: vi.fn() })
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })
})
