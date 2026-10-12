import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SupportInboxWorkspace } from './SupportInboxWorkspace'
import { getSupportInboxThread, listSupportInbox, replyAsMaintainer, setSupportThreadStatus } from '../feedback/supportApi'

vi.mock('../feedback/supportApi', () => ({
  getSupportInboxThread: vi.fn(), listSupportInbox: vi.fn(), replyAsMaintainer: vi.fn(), setSupportThreadStatus: vi.fn(),
}))

const thread = { id: 'thread-1', user_id: 'user-1', category: 'support_query' as const, source: 'settings', subject: 'Tracker issue', original_message: 'It did not save.', status: 'open' as const, metadata: {}, email_status: 'accepted', maintainer_seen_at: null, maintainer_seen_by: null, created_at: '2026-10-12T00:00:00Z', last_activity_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z', user_email: 'person@example.com' }
const list = { threads: [thread], total: 1, has_more: false, metrics: { total: 1, open: 1, waiting: 0, resolved: 0, incorrect_ai: 0, unread: 1 } }
const detail = { thread, user_email: 'person@example.com', messages: [] }

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('SupportInboxWorkspace', () => {
  it('shows actual inbox metrics and opens user feedback details', async () => {
    vi.mocked(listSupportInbox).mockResolvedValue(list)
    vi.mocked(getSupportInboxThread).mockResolvedValue(detail)
    const user = userEvent.setup()
    render(<SupportInboxWorkspace />)
    await user.click(await screen.findByText('Tracker issue'))
    expect(await screen.findByText('person@example.com')).toBeInTheDocument()
    expect(screen.getByText('It did not save.')).toBeInTheDocument()
    expect(screen.getByText('Unread')).toBeInTheDocument()
  })

  it('sends a maintainer reply and exposes status controls', async () => {
    vi.mocked(listSupportInbox).mockResolvedValue(list)
    vi.mocked(getSupportInboxThread).mockResolvedValue(detail)
    vi.mocked(replyAsMaintainer).mockResolvedValue({ accepted: true, duplicate: false, status: 'waiting_for_user' })
    vi.mocked(setSupportThreadStatus).mockResolvedValue({ status: 'resolved' })
    const user = userEvent.setup()
    render(<SupportInboxWorkspace />)
    await user.click(await screen.findByText('Tracker issue'))
    await user.type(await screen.findByRole('textbox', { name: 'Reply to user' }), 'Please retry the update.')
    await user.click(screen.getByRole('button', { name: 'Send Reply' }))
    await waitFor(() => expect(replyAsMaintainer).toHaveBeenCalledWith('thread-1', 'Please retry the update.', expect.any(String)))
    expect(screen.getByLabelText('Thread status')).toBeInTheDocument()
  })

  it('requires server confirmation and reloads the selected thread after a status change', async () => {
    const resolved = { ...thread, status: 'resolved' as const, updated_at: '2026-10-12T00:03:00Z' }
    vi.mocked(listSupportInbox).mockResolvedValueOnce(list).mockResolvedValueOnce({ ...list, threads: [resolved], metrics: { ...list.metrics, open: 0, resolved: 1 } })
    vi.mocked(getSupportInboxThread).mockResolvedValueOnce(detail).mockResolvedValueOnce({ ...detail, thread: resolved })
    vi.mocked(setSupportThreadStatus).mockResolvedValue({ status: 'resolved' })
    const user = userEvent.setup()
    render(<SupportInboxWorkspace />)
    await user.click(await screen.findByText('Tracker issue'))
    const select = await screen.findByLabelText('Thread status')
    await user.selectOptions(select, 'resolved')
    await waitFor(() => expect(setSupportThreadStatus).toHaveBeenCalledWith('thread-1', 'resolved', thread.updated_at))
    await waitFor(() => expect(getSupportInboxThread).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/This conversation is resolved/)).toBeInTheDocument()
    expect(listSupportInbox).toHaveBeenCalledTimes(2)
  })

  it('keeps a useful error and does not present an empty inbox when loading fails', async () => {
    vi.mocked(listSupportInbox).mockRejectedValue(new Error('Could not connect to Support. Check your connection and retry.'))
    render(<SupportInboxWorkspace />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect to Support')
    expect(screen.queryByText('No feedback in this view')).not.toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })
})
