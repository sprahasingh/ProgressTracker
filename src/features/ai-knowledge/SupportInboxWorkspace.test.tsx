import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SupportInboxWorkspace } from './SupportInboxWorkspace'
import { getSupportInboxThread, listSupportInbox, replyAsMaintainer, setSupportThreadStatus } from '../feedback/supportApi'

vi.mock('../feedback/supportApi', () => ({
  getSupportInboxThread: vi.fn(), listSupportInbox: vi.fn(), replyAsMaintainer: vi.fn(), setSupportThreadStatus: vi.fn(),
}))

const thread = { id: 'thread-1', category: 'support_query' as const, source: 'settings', subject: 'Tracker issue', original_message: 'It did not save.', status: 'open' as const, metadata: {}, email_status: 'accepted', maintainer_seen_at: null, identity: null, created_at: '2026-10-12T00:00:00Z', last_activity_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' }
const list = { threads: [thread], total: 1, has_more: false, metrics: { total: 1, open: 1, waiting: 0, resolved: 0, incorrect_ai: 0, unread: 1 } }
const detail = { thread, messages: [] }

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('SupportInboxWorkspace', () => {
  it('shows actual inbox metrics and opens user feedback details', async () => {
    vi.mocked(listSupportInbox).mockResolvedValue(list)
    vi.mocked(getSupportInboxThread).mockResolvedValue(detail)
    const user = userEvent.setup()
    render(<SupportInboxWorkspace />)
    await user.click(await screen.findByText('Tracker issue'))
    expect(await screen.findByText('Anonymous')).toBeInTheDocument()
    expect(screen.getByText('It did not save.')).toBeInTheDocument()
    expect(screen.getByText('Unread')).toBeInTheDocument()
  })

  it('shows permitted account identity for an opted-in support request', async () => {
    const identified = { ...thread, identity: { display_name: 'Ada Example', email: 'ada@example.com' } }
    vi.mocked(listSupportInbox).mockResolvedValue({ ...list, threads: [identified] })
    vi.mocked(getSupportInboxThread).mockResolvedValue({ thread: identified, messages: [] })
    const user = userEvent.setup()
    render(<SupportInboxWorkspace />)
    await user.click(await screen.findByText('Tracker issue'))
    expect(await screen.findByText('Ada Example · ada@example.com')).toBeInTheDocument()
  })

  it('switches from the mobile list to a long-subject detail and returns to the list', async () => {
    const longSubject = 'Feedback subject that needs to wrap on a narrow phone screen '.repeat(3)
    const longThread = { ...thread, subject: longSubject }
    vi.mocked(listSupportInbox).mockResolvedValue({ ...list, threads: [longThread] })
    vi.mocked(getSupportInboxThread).mockResolvedValue({ ...detail, thread: longThread })
    const user = userEvent.setup()
    render(<SupportInboxWorkspace />)
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const recordList = await screen.findByRole('list', { name: 'Feedback records' })
    const layout = recordList.closest('.support-inbox-layout')!
    expect(layout).not.toHaveClass('has-selection')
    expect(screen.getByText('Select feedback to view its message and conversation.')).toBeInTheDocument()
    const trigger = screen.getByRole('listitem').querySelector('button')!
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('article', { name: /Feedback detail: Feedback subject that needs to wrap/ })).toBeInTheDocument()
    expect(layout).toHaveClass('has-selection')
    const back = screen.getByRole('button', { name: 'Back to feedback' })
    expect(back).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(layout).not.toHaveClass('has-selection')
    expect(screen.getByRole('list', { name: 'Feedback records' })).toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('shows the desktop empty detail prompt when no record is selected', async () => {
    vi.mocked(listSupportInbox).mockResolvedValue(list)
    render(<SupportInboxWorkspace />)
    expect(await screen.findByText('Select feedback to view its message and conversation.')).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: /Feedback detail/ })).not.toBeInTheDocument()
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
