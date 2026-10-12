import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { MySupportQueries } from './MySupportQueries'
import { getMySupportThread, listMySupportThreads, replyToMySupportThread } from './supportApi'

vi.mock('./supportApi', () => ({
  listMySupportThreads: vi.fn(),
  getMySupportThread: vi.fn(),
  replyToMySupportThread: vi.fn(),
}))

const thread = { id: 'thread-1', user_id: 'user-1', category: 'support_query' as const, source: 'settings', subject: 'Goal did not save', original_message: 'My goal did not save.', status: 'waiting_for_user' as const, metadata: {}, email_status: 'accepted', created_at: '2026-10-12T00:00:00Z', last_activity_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' }
const detail = { thread, messages: [{ id: 'message-1', feedback_id: thread.id, sender_user_id: null, sender_role: 'maintainer' as const, body: 'Please refresh and try again.', created_at: '2026-10-12T00:00:00Z' }] }

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('MySupportQueries', () => {
  it('loads the notification-selected conversation and submits a follow-up', async () => {
    vi.mocked(listMySupportThreads).mockResolvedValue({ threads: [thread] })
    vi.mocked(getMySupportThread).mockResolvedValue(detail)
    vi.mocked(replyToMySupportThread).mockResolvedValue({ accepted: true, duplicate: false, emailStatus: 'accepted' })
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/settings?support=thread-1']}><MySupportQueries /></MemoryRouter>)
    expect(await screen.findByText('Please refresh and try again.')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Reply to support' }), 'I tried it and it worked.')
    await user.click(screen.getByRole('button', { name: 'Send Reply' }))
    await waitFor(() => expect(replyToMySupportThread).toHaveBeenCalledWith('thread-1', 'I tried it and it worked.', expect.any(String)))
    expect(await screen.findByText(/Your reply was saved\. The email provider accepted/)).toBeInTheDocument()
  })

  it('keeps resolved conversations read-only', async () => {
    vi.mocked(listMySupportThreads).mockResolvedValue({ threads: [{ ...thread, status: 'resolved' }] })
    vi.mocked(getMySupportThread).mockResolvedValue({ ...detail, thread: { ...thread, status: 'resolved' } })
    render(<MemoryRouter initialEntries={['/settings?support=thread-1']}><MySupportQueries /></MemoryRouter>)
    expect(await screen.findByText(/This conversation is resolved/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send Reply' })).not.toBeInTheDocument()
  })

  it('shows the compact query list without an empty detail, then returns to it from a conversation', async () => {
    vi.mocked(listMySupportThreads).mockResolvedValue({ threads: [thread] })
    vi.mocked(getMySupportThread).mockResolvedValue(detail)
    const user = userEvent.setup()
    render(<MemoryRouter><MySupportQueries /></MemoryRouter>)
    expect(await screen.findByRole('navigation', { name: 'Your support queries' })).toBeInTheDocument()
    expect(screen.queryByText('Select a support query to view the conversation.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Goal did not save/ }))
    expect(await screen.findByText('Please refresh and try again.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Back to queries/ }))
    expect(screen.getByRole('navigation', { name: 'Your support queries' })).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: /Conversation:/ })).not.toBeInTheDocument()
  })

  it('shows only a retryable error when the list request fails, then performs a fresh request', async () => {
    vi.mocked(listMySupportThreads).mockRejectedValueOnce(new Error('Could not connect to Support. Check your connection and retry.')).mockResolvedValueOnce({ threads: [] })
    const user = userEvent.setup()
    render(<MemoryRouter><MySupportQueries /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect to Support')
    expect(screen.queryByText(/You have no tracked support queries yet/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/You have no tracked support queries yet/)).toBeInTheDocument()
    expect(listMySupportThreads).toHaveBeenCalledTimes(2)
  })

  it('does not show the empty state after the selected thread request fails and retries that thread', async () => {
    vi.mocked(listMySupportThreads).mockResolvedValue({ threads: [] })
    vi.mocked(getMySupportThread).mockRejectedValue(new Error('That support conversation is unavailable.'))
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/settings?support=thread-1']}><MySupportQueries /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('That support conversation is unavailable.')
    expect(screen.queryByText(/You have no tracked support queries yet/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findAllByRole('alert')).toHaveLength(1)
    expect(getMySupportThread).toHaveBeenCalledTimes(2)
  })
})
