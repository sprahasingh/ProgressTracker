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

afterEach(() => cleanup())

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
})
