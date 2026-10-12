import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnswerFeedbackWorkspace } from './AnswerFeedbackWorkspace'
import { listAnswerFeedback, reviewAnswerFeedback, type AnswerFeedback } from './aiKnowledgeApi'

vi.mock('./aiKnowledgeApi', () => ({ listAnswerFeedback: vi.fn(), reviewAnswerFeedback: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const feedback: AnswerFeedback = {
  id: 'feedback-12345678-1234-1234-1234-123456789012',
  response_id: 'response-12345678-1234-1234-1234-123456789012',
  category: 'wrong_instructions', explanation: 'The settings path in the answer has changed.', topic: 'settings',
  knowledge_version: 'bundle-old-0123456789abcdef', status: 'pending', created_at: '2026-10-12T08:30:00.000Z',
  reviewed_at: null, identity: null,
}
const result = (rows: AnswerFeedback[] = [feedback], counts = { pending: 1, reviewed: 0, resolved: 0 }, version = 'bundle-current-abcdef0123456789') => ({
  current_knowledge_version: version, feedback: rows, counts, page: { limit: 100, offset: 0, has_more: false },
})

describe('AnswerFeedbackWorkspace', () => {
  it('shows a readable report first and keeps technical identifiers collapsed until requested', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result())
    render(<AnswerFeedbackWorkspace />)

    const card = await screen.findByRole('article', { name: 'Wrong instructions feedback, Needs review' })
    expect(within(card).getByText('The settings path in the answer has changed.')).toBeInTheDocument()
    expect(within(card).getByText('Settings')).toBeInTheDocument()
    expect(within(card).getByText('Submitted anonymously')).toBeInTheDocument()
    expect(within(card).getByText('Needs review')).toBeInTheDocument()
    expect(within(card).getByText('AI Help version changed since this feedback was submitted.')).toBeInTheDocument()
    expect(within(card).getByText('This does not necessarily mean the reported issue has been fixed.')).toBeInTheDocument()
    expect(within(card).getByText('bundle-old-0123456789abcdef')).not.toBeVisible()
    expect(within(card).queryByText('response-12345678-1234-1234-1234-123456789012')).not.toBeInTheDocument()

    const summary = within(card).getByText('Technical details')
    summary.focus()
    await userEvent.keyboard('{Enter}')
    expect(await within(card).findByText('Reported bundle identifier')).toBeInTheDocument()
    expect(within(card).queryByText('response-12345678-1234-1234-1234-123456789012')).not.toBeInTheDocument()
    expect(within(card).queryByText('user-98765432-1234-1234-1234-123456789012')).not.toBeInTheDocument()
  })

  it('shows a neutral note and safe fallbacks for missing topic or bundle data', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result([{
      ...feedback, explanation: '  ', topic: '', knowledge_version: '',
    }], { pending: 1, reviewed: 0, resolved: 0 }, ''))
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    expect(within(card).getByText('No additional details provided.')).toBeInTheDocument()
    expect(within(card).getByText('Unknown topic')).toBeInTheDocument()
    expect(within(card).queryByText(/AI Help version changed/)).not.toBeInTheDocument()
    await userEvent.click(within(card).getByText('Technical details'))
    expect(within(card).getAllByText('Unavailable')).toHaveLength(2)
  })

  it('does not show a bundle notice when the reported and current versions match', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result([feedback], { pending: 1, reviewed: 0, resolved: 0 }, feedback.knowledge_version))
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    expect(within(card).queryByText(/AI Help version changed/)).not.toBeInTheDocument()
  })

  it('does not compare a missing feedback bundle or current bundle', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result([feedback], { pending: 1, reviewed: 0, resolved: 0 }, ''))
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    expect(within(card).queryByText(/AI Help version changed/)).not.toBeInTheDocument()
    expect(within(card).getByText('bundle-old-0123456789abcdef')).not.toBeVisible()
  })

  it('shows account identity only when the submission DTO contains consented identity fields', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result([{
      ...feedback, identity: { display_name: 'Ada Example', email: 'ada@example.com' },
    }]))
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    expect(within(card).getByText('Ada Example · ada@example.com')).toBeInTheDocument()
    await userEvent.click(within(card).getByText('Technical details'))
    expect(within(card).getByText('response-12345678-1234-1234-1234-123456789012')).toBeInTheDocument()
    expect(within(card).queryByText('user-98765432-1234-1234-1234-123456789012')).not.toBeInTheDocument()
  })

  it('offers only backend-supported actions for pending reports and refreshes counts after success', async () => {
    vi.mocked(listAnswerFeedback)
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([], { pending: 0, reviewed: 1, resolved: 0 }))
    vi.mocked(reviewAnswerFeedback).mockResolvedValue({ feedback: { ...feedback, status: 'reviewed' } })
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    await user.click(within(card).getByRole('button', { name: 'Mark reviewed' }))
    await waitFor(() => expect(reviewAnswerFeedback).toHaveBeenCalledWith(feedback.id, 'reviewed'))
    await waitFor(() => expect(listAnswerFeedback).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: /Needs review/ })).toHaveTextContent('0')
    expect(within(card).queryByRole('button', { name: 'Mark resolved' })).not.toBeInTheDocument()
  })

  it('filters by category and status and gives a useful empty state', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result([], { pending: 2, reviewed: 3, resolved: 1 }))
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    expect(await screen.findByText('No feedback reports in this view')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reviewed/ })).toHaveTextContent('3')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'outdated')
    await waitFor(() => expect(listAnswerFeedback).toHaveBeenLastCalledWith({ status: 'pending', category: 'outdated', limit: 100, offset: 0 }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'all')
    await waitFor(() => expect(listAnswerFeedback).toHaveBeenLastCalledWith({ status: 'all', category: 'outdated', limit: 100, offset: 0 }))
  })

  it('provides status-appropriate actions on reviewed and resolved feedback', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result([
      { ...feedback, status: 'reviewed', reviewed_at: '2026-10-12T09:00:00Z' },
      { ...feedback, id: 'feedback-resolved', status: 'resolved', reviewed_at: '2026-10-12T10:00:00Z' },
    ]))
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'all')
    const reviewed = await screen.findByRole('article', { name: 'Wrong instructions feedback, Reviewed' })
    const resolved = await screen.findByRole('article', { name: 'Wrong instructions feedback, Resolved' })
    expect(within(reviewed).queryByRole('button', { name: /Mark/ })).not.toBeInTheDocument()
    expect(within(resolved).queryByRole('button', { name: /Mark/ })).not.toBeInTheDocument()
  })

  it('prevents duplicate review submissions while a save is pending', async () => {
    let finishReview!: (value: { feedback: AnswerFeedback }) => void
    vi.mocked(listAnswerFeedback).mockResolvedValue(result())
    vi.mocked(reviewAnswerFeedback).mockImplementation(() => new Promise((resolve) => { finishReview = resolve }))
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    const review = within(card).getByRole('button', { name: 'Mark reviewed' })
    await user.click(review)
    expect(review).toBeDisabled()
    expect(review).toHaveTextContent('Saving…')
    expect(reviewAnswerFeedback).toHaveBeenCalledTimes(1)
    finishReview({ feedback: { ...feedback, status: 'reviewed' } })
  })

  it('shows review and refresh failures without hiding the last loaded report', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('Refresh failed.')).mockResolvedValueOnce(result())
    vi.mocked(reviewAnswerFeedback).mockRejectedValueOnce(new Error('Review update failed.'))
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    await user.click(within(card).getByRole('button', { name: 'Mark reviewed' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Review update failed.')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh failed.')
    expect(screen.getByRole('status')).toHaveTextContent('Showing the last successfully loaded results')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(await screen.findByRole('article')).toBeInTheDocument()
  })

  it('shows loading and initial errors without false counts or empty-state claims', async () => {
    let finishLoad!: (value: ReturnType<typeof result>) => void
    vi.mocked(listAnswerFeedback).mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve }))
      .mockRejectedValueOnce(new Error('The review service is temporarily unavailable. Try again.'))
    render(<AnswerFeedbackWorkspace />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading answer feedback')
    expect(screen.queryByRole('button', { name: /Needs review/ })).not.toBeInTheDocument()
    finishLoad(result())
    expect(await screen.findByRole('article')).toBeInTheDocument()

    cleanup()
    render(<AnswerFeedbackWorkspace />)
    expect(await screen.findByRole('alert')).toHaveTextContent('review service is temporarily unavailable')
    expect(screen.queryByText('No feedback reports in this view')).not.toBeInTheDocument()
  })
})
