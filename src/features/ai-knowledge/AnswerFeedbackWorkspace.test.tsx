import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnswerFeedbackWorkspace } from './AnswerFeedbackWorkspace'
import { listAnswerFeedback } from './aiKnowledgeApi'

vi.mock('./aiKnowledgeApi', () => ({ listAnswerFeedback: vi.fn(), reviewAnswerFeedback: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('AnswerFeedbackWorkspace', () => {
  it('shows an error and retry action without false zero counts or an empty-state claim', async () => {
    vi.mocked(listAnswerFeedback).mockRejectedValueOnce(new Error('The review service is temporarily unavailable. Try again.'))
      .mockResolvedValueOnce({ current_knowledge_version: 'v1', feedback: [], counts: { pending: 0, reviewed: 0, resolved: 0 }, page: { limit: 100, offset: 0, has_more: false } })
    const user = userEvent.setup()
    render(<AnswerFeedbackWorkspace />)
    expect(await screen.findByRole('alert')).toHaveTextContent('review service is temporarily unavailable')
    expect(screen.queryByRole('button', { name: /Needs review/ })).not.toBeInTheDocument()
    expect(screen.queryByText('No feedback reports in this view')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No feedback reports in this view')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Needs review/ })).toHaveTextContent('0')
  })
})
