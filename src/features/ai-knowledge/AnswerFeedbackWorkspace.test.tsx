import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnswerFeedbackWorkspace } from './AnswerFeedbackWorkspace'
import { createAnswerFeedbackCandidate, listAnswerFeedback, reviewAnswerFeedback, setAnswerFeedbackKnowledgeDecision, type AnswerFeedback } from './aiKnowledgeApi'

vi.mock('./aiKnowledgeApi', () => ({ listAnswerFeedback: vi.fn(), reviewAnswerFeedback: vi.fn(), setAnswerFeedbackKnowledgeDecision: vi.fn(), createAnswerFeedbackCandidate: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const feedback: AnswerFeedback = {
  id: 'feedback-12345678-1234-1234-1234-123456789012',
  response_id: 'response-12345678-1234-1234-1234-123456789012',
  category: 'wrong_instructions', explanation: 'The settings path in the answer has changed.', topic: 'settings',
  knowledge_version: 'bundle-old-0123456789abcdef', status: 'pending', created_at: '2026-10-12T08:30:00.000Z',
  reviewed_at: null, identity: null, knowledge_decision: 'not_decided', candidate: null,
}
const result = (rows: AnswerFeedback[] = [feedback], counts = { pending: 1, reviewed: 0, resolved: 0 }, version = 'bundle-current-abcdef0123456789') => ({
  current_knowledge_version: version, candidate_source_refs: ['src/features/settings/UnifiedSettings.tsx'], feedback: rows, counts, page: { limit: 100, offset: 0, has_more: false },
})

describe('AnswerFeedbackWorkspace', () => {
  it('shows a readable report first and keeps technical identifiers collapsed until requested', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result())
    render(<AnswerFeedbackWorkspace />)

    const card = await screen.findByRole('article', { name: 'Wrong instructions feedback, New' })
    expect(within(card).getByText('The settings path in the answer has changed.')).toBeInTheDocument()
    expect(within(card).getByText('Settings')).toBeInTheDocument()
    expect(within(card).getByText('Submitted anonymously')).toBeInTheDocument()
    expect(card.querySelector('[aria-label="Status: New"]')).toHaveTextContent('New')
    expect(within(card).getByText(/exact answer text is not retained/)).toBeInTheDocument()
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

  it('updates New feedback to Reviewed, shows success, and refreshes counts', async () => {
    vi.mocked(listAnswerFeedback)
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([], { pending: 0, reviewed: 1, resolved: 0 }))
    vi.mocked(reviewAnswerFeedback).mockResolvedValue({ feedback: { ...feedback, status: 'reviewed' } })
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    await user.click(within(card).getByText('Maintainer review'))
    await user.selectOptions(within(card).getByRole('combobox', { name: 'Review status' }), 'reviewed')
    await waitFor(() => expect(reviewAnswerFeedback).toHaveBeenCalledWith(feedback.id, 'reviewed'))
    await waitFor(() => expect(listAnswerFeedback).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: /New/ })).toHaveTextContent('0')
    expect(screen.getByRole('status')).toHaveTextContent('Review status changed to Reviewed')
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
    await user.click(within(resolved).getByText('Maintainer review'))
    expect(within(resolved).getByRole('combobox', { name: 'Review status' })).toHaveValue('resolved')
    expect(within(reviewed).getByRole('combobox', { name: 'Review status' })).toHaveValue('reviewed')
  })

  it('allows Reviewed to become Resolved and resolved feedback to be reopened as Reviewed', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result([
      feedback,
      { ...feedback, id: 'feedback-reviewed', status: 'reviewed', reviewed_at: '2026-10-12T09:00:00Z' },
      { ...feedback, id: 'feedback-resolved', status: 'resolved', reviewed_at: '2026-10-12T10:00:00Z' },
    ]))
    vi.mocked(reviewAnswerFeedback).mockImplementation(async (id, status) => ({ feedback: { ...feedback, id, status } }))
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Status' }), 'all')
    const reviewed = await screen.findByRole('article', { name: 'Wrong instructions feedback, Reviewed' })
    const resolved = await screen.findByRole('article', { name: 'Wrong instructions feedback, Resolved' })
    await user.click(within(reviewed).getByText('Maintainer review'))
    await user.selectOptions(within(reviewed).getByRole('combobox', { name: 'Review status' }), 'resolved')
    await user.click(within(resolved).getByText('Maintainer review'))
    await user.selectOptions(within(resolved).getByRole('combobox', { name: 'Review status' }), 'reviewed')
    await waitFor(() => expect(reviewAnswerFeedback).toHaveBeenCalledWith('feedback-reviewed', 'resolved'))
    await waitFor(() => expect(reviewAnswerFeedback).toHaveBeenCalledWith('feedback-resolved', 'reviewed'))
  })

  it('persists No knowledge change needed independently from the review status', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result())
    vi.mocked(setAnswerFeedbackKnowledgeDecision).mockResolvedValue({ feedback: { id: feedback.id, status: 'pending', knowledge_decision: 'no_knowledge_change', knowledge_candidate_id: null } })
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    await user.click(within(card).getByText('Maintainer review'))
    await user.selectOptions(within(card).getByRole('combobox', { name: 'Knowledge decision' }), 'no_knowledge_change')
    await waitFor(() => expect(setAnswerFeedbackKnowledgeDecision).toHaveBeenCalledWith(feedback.id, 'no_knowledge_change'))
    expect(reviewAnswerFeedback).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Knowledge decision saved')
  })

  it('creates an editable source-checked candidate from feedback and shows its link after saving', async () => {
    const draft = { ...feedback, knowledge_decision: 'create_candidate' as const }
    const linked = { ...draft, candidate: { id: 'candidate-linked', title: 'Settings answer guidance', status: 'pending' as const } }
    vi.mocked(listAnswerFeedback).mockResolvedValueOnce(result([draft])).mockResolvedValueOnce(result([linked]))
    vi.mocked(createAnswerFeedbackCandidate).mockResolvedValue({ candidate_id: 'candidate-linked', created: true, duplicate: false })
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    await user.click(within(card).getByText('Maintainer review'))
    expect(within(card).getByText(/report is context only; it is not copied into the knowledge entry/)).toBeInTheDocument()
    await user.clear(within(card).getByLabelText('Proposed answer'))
    await user.type(within(card).getByLabelText('Proposed answer'), 'Settings guidance explains the supported preference behavior clearly.')
    await user.selectOptions(within(card).getByLabelText('Supporting source files'), ['src/features/settings/UnifiedSettings.tsx'])
    await user.click(within(card).getByRole('button', { name: 'Create pending candidate' }))
    await waitFor(() => expect(createAnswerFeedbackCandidate).toHaveBeenCalledWith(feedback.id, expect.objectContaining({
      topic_id: 'settings.answer_guidance', feature_category: 'settings', source_refs: ['src/features/settings/UnifiedSettings.tsx'],
    })))
    expect(await screen.findByText('Settings answer guidance')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Open candidate' })).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Create pending candidate' })).not.toBeInTheDocument()
  })

  it('links an already existing candidate and does not offer a duplicate creation form', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result([{
      ...feedback, knowledge_decision: 'create_candidate', candidate: { id: 'candidate-existing', title: 'Existing answer guidance', status: 'pending' },
    }]))
    const onOpenCandidate = vi.fn()
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace onOpenCandidate={onOpenCandidate} />)
    const card = await screen.findByRole('article')
    await user.click(within(card).getByText('Maintainer review'))
    expect(within(card).getByText('Existing answer guidance')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Create pending candidate' })).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Open candidate' }))
    expect(onOpenCandidate).toHaveBeenCalledWith('candidate-existing')
  })

  it('keeps the feedback visible and reports candidate creation failures', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValue(result([{ ...feedback, knowledge_decision: 'create_candidate' }]))
    vi.mocked(createAnswerFeedbackCandidate).mockRejectedValue(new Error('Candidate evidence was rejected.'))
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    await user.click(within(card).getByText('Maintainer review'))
    await user.type(within(card).getByLabelText('Proposed answer'), 'Settings guidance explains the supported preference behavior clearly.')
    await user.selectOptions(within(card).getByLabelText('Supporting source files'), ['src/features/settings/UnifiedSettings.tsx'])
    await user.click(within(card).getByRole('button', { name: 'Create pending candidate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Candidate evidence was rejected.')
    expect(within(card).getByText('The settings path in the answer has changed.')).toBeInTheDocument()
  })

  it('prevents duplicate review submissions while a save is pending', async () => {
    let finishReview!: (value: { feedback: AnswerFeedback }) => void
    vi.mocked(listAnswerFeedback).mockResolvedValue(result())
    vi.mocked(reviewAnswerFeedback).mockImplementation(() => new Promise((resolve) => { finishReview = resolve }))
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    await user.click(within(card).getByText('Maintainer review'))
    const review = within(card).getByRole('combobox', { name: 'Review status' })
    await user.selectOptions(review, 'reviewed')
    expect(review).toBeDisabled()
    expect(reviewAnswerFeedback).toHaveBeenCalledWith(feedback.id, 'reviewed')
    expect(reviewAnswerFeedback).toHaveBeenCalledTimes(1)
    finishReview({ feedback: { ...feedback, status: 'reviewed' } })
  })

  it('shows review and refresh failures without hiding the last loaded report', async () => {
    vi.mocked(listAnswerFeedback).mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('Refresh failed.')).mockResolvedValueOnce(result())
    vi.mocked(reviewAnswerFeedback).mockRejectedValueOnce(new Error('Review update failed.'))
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    const card = await screen.findByRole('article')
    await user.click(within(card).getByText('Maintainer review'))
    await user.selectOptions(within(card).getByRole('combobox', { name: 'Review status' }), 'reviewed')
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
    expect(screen.queryByRole('button', { name: /New/ })).not.toBeInTheDocument()
    finishLoad(result())
    expect(await screen.findByRole('article')).toBeInTheDocument()

    cleanup()
    render(<AnswerFeedbackWorkspace />)
    expect(await screen.findByRole('alert')).toHaveTextContent('review service is temporarily unavailable')
    expect(screen.queryByText('No feedback reports in this view')).not.toBeInTheDocument()
  })
})
