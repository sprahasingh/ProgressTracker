import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SendFeedbackAction } from './SendFeedback'
import { FeedbackSubmissionError } from './feedbackService'

const mocks = vi.hoisted(() => ({ submit: vi.fn(), auth: { status: 'signed-in', user: { id: 'user-1', email: 'person@example.com' } } }))
vi.mock('./feedbackService', async (importOriginal) => ({ ...await importOriginal<typeof import('./feedbackService')>(), submitGeneralFeedback: mocks.submit }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => ({}) }))

describe('Send Feedback', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })
  beforeEach(() => {
    mocks.submit.mockReset().mockResolvedValue(undefined)
    mocks.auth = { status: 'signed-in', user: { id: 'user-1', email: 'person@example.com' } }
  })

  it('requires a message and allows changing the feedback type', async () => {
    const user = userEvent.setup()
    render(<SendFeedbackAction />)
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    const send = screen.getByRole('dialog').querySelector('button[type="submit"]') as HTMLButtonElement
    expect(send).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Feedback type'), 'feature_request')
    await user.type(screen.getByRole('textbox', { name: 'Your message' }), 'Add calendar export.')
    expect(send).toBeEnabled()
  })

  it('preserves a failed message and retries with a stable idempotency key', async () => {
    mocks.submit.mockRejectedValueOnce(new Error('Feedback service is unavailable.')).mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<SendFeedbackAction />)
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    const message = screen.getByRole('textbox', { name: 'Your message' })
    await user.type(message, 'The tracker did not save.')
    await user.click(screen.getByRole('dialog').querySelector('button[type="submit"]') as HTMLButtonElement)
    expect(await screen.findByRole('alert')).toHaveTextContent('Feedback service is unavailable.')
    expect(message).toHaveValue('The tracker did not save.')
    expect(screen.getByRole('link', { name: 'Email Support' })).toHaveAttribute('href', expect.stringContaining(encodeURIComponent('The tracker did not save.')))
    const firstInput = mocks.submit.mock.calls[0]?.[1]
    await user.click(screen.getByRole('button', { name: 'Try Again' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Feedback sent. Thank you for helping improve ProgressTracker!')
    expect(mocks.submit).toHaveBeenCalledTimes(2)
    expect(mocks.submit.mock.calls[1]?.[1].requestId).toBe(firstInput.requestId)
  })

  it('prevents a second submission while one is in flight', async () => {
    let resolveSubmission!: () => void
    mocks.submit.mockImplementation(() => new Promise<void>((resolve) => { resolveSubmission = resolve }))
    const user = userEvent.setup()
    render(<SendFeedbackAction />)
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    await user.type(screen.getByRole('textbox', { name: 'Your message' }), 'Please help.')
    const send = screen.getByRole('dialog').querySelector('button[type="submit"]') as HTMLButtonElement
    await user.click(send)
    expect(send).toBeDisabled()
    expect(mocks.submit).toHaveBeenCalledTimes(1)
    resolveSubmission()
  })

  it('does not offer automatic retry when provider acceptance is uncertain', async () => {
    mocks.submit.mockRejectedValueOnce(new FeedbackSubmissionError('Acceptance could not be confirmed.', 503, undefined, true, false))
    const user = userEvent.setup()
    render(<SendFeedbackAction />)
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    await user.type(screen.getByRole('textbox', { name: 'Your message' }), 'Please check this issue.')
    await user.click(screen.getByRole('dialog').querySelector('button[type="submit"]') as HTMLButtonElement)
    expect(await screen.findByRole('alert')).toHaveTextContent('Acceptance could not be confirmed.')
    expect(screen.getByText(/automatic retry is disabled/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument()
  })

  it('keeps an email and copy fallback available while signed out', async () => {
    mocks.auth = { status: 'signed-out', user: null as unknown as { id: string; email: string } }
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText })
    render(<SendFeedbackAction />)
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    expect(screen.getByRole('status')).toHaveTextContent('Sign in to submit feedback here.')
    expect(screen.getByRole('link', { name: 'Email Support' })).toHaveAttribute('href', expect.stringContaining('mailto:spraha.progresstracker@gmail.com'))
    await user.click(screen.getByRole('button', { name: 'Copy Email' }))
    expect(writeText).toHaveBeenCalledWith('spraha.progresstracker@gmail.com')
    expect(await screen.findByText('Support email copied.')).toBeInTheDocument()
    expect(mocks.submit).not.toHaveBeenCalled()
  })
})
