import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SendFeedbackAction } from './SendFeedback'
import { FeedbackSubmissionError } from './feedbackService'
import { MemoryRouter, useLocation } from 'react-router-dom'

const mocks = vi.hoisted(() => ({ submit: vi.fn(), auth: { status: 'signed-in', user: { id: 'user-1', email: 'person@example.com' } } }))
vi.mock('./feedbackService', async (importOriginal) => ({ ...await importOriginal<typeof import('./feedbackService')>(), submitGeneralFeedback: mocks.submit }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => ({}) }))

function CurrentPath() { return <div data-testid="current-path">{useLocation().pathname}</div> }
function renderAction(initialEntries = ['/settings']) {
  return render(<MemoryRouter initialEntries={initialEntries}><CurrentPath /><SendFeedbackAction /></MemoryRouter>)
}

describe('Send Feedback', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })
  beforeEach(() => {
    mocks.submit.mockReset().mockResolvedValue({ deliveryStatus: 'accepted', feedbackId: 'feedback-123' })
    mocks.auth = { status: 'signed-in', user: { id: 'user-1', email: 'person@example.com' } }
  })

  it('requires a message and allows changing the feedback type', async () => {
    const user = userEvent.setup()
    renderAction()
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    const send = screen.getByRole('dialog').querySelector('button[type="submit"]') as HTMLButtonElement
    expect(send).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Feedback type'), 'feature_request')
    await user.type(screen.getByRole('textbox', { name: 'Your message' }), 'Add calendar export.')
    expect(send).toBeEnabled()
  })

  it('preserves a failed message and retries with a stable idempotency key', async () => {
    mocks.submit.mockRejectedValueOnce(new Error('Feedback service is unavailable.')).mockResolvedValueOnce({ deliveryStatus: 'accepted', feedbackId: 'feedback-123' })
    const user = userEvent.setup()
    renderAction()
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    const message = screen.getByRole('textbox', { name: 'Your message' })
    await user.type(message, 'The tracker did not save.')
    await user.click(screen.getByRole('dialog').querySelector('button[type="submit"]') as HTMLButtonElement)
    expect(await screen.findByRole('alert')).toHaveTextContent('Feedback service is unavailable.')
    expect(message).toHaveValue('The tracker did not save.')
    expect(screen.getByRole('link', { name: 'Email Support' })).toHaveAttribute('href', expect.stringContaining(encodeURIComponent('The tracker did not save.')))
    const firstInput = mocks.submit.mock.calls[0]?.[1]
    await user.click(screen.getByRole('button', { name: 'Try Again' }))
    expect(await screen.findByText('Feedback saved. Thank you for helping improve ProgressTracker!')).toBeInTheDocument()
    expect(mocks.submit).toHaveBeenCalledTimes(2)
    expect(mocks.submit.mock.calls[1]?.[1].requestId).toBe(firstInput.requestId)
  })

  it('prevents a second submission while one is in flight', async () => {
    let resolveSubmission!: () => void
    mocks.submit.mockImplementation(() => new Promise((resolve) => { resolveSubmission = () => resolve({ deliveryStatus: 'pending' }) }))
    const user = userEvent.setup()
    renderAction()
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
    renderAction()
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
    renderAction()
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    expect(screen.getByRole('status')).toHaveTextContent('Sign in to submit feedback here.')
    expect(screen.getByRole('link', { name: 'Email Support' })).toHaveAttribute('href', expect.stringContaining('mailto:spraha.progresstracker@gmail.com'))
    await user.click(screen.getByRole('button', { name: 'Copy Email' }))
    expect(writeText).toHaveBeenCalledWith('spraha.progresstracker@gmail.com')
    expect(await screen.findByText('Support email copied.')).toBeInTheDocument()
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('keeps the current route when the dialog opens, receives focus, and is intentionally dismissed', async () => {
    const user = userEvent.setup()
    const scrollTo = vi.fn()
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY')
    const originalScrollTo = Object.getOwnPropertyDescriptor(window, 'scrollTo')
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 123 })
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo })
    renderAction(['/today', '/settings'])
    expect(screen.getByTestId('current-path')).toHaveTextContent('/settings')
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    expect(screen.getByTestId('current-path')).toHaveTextContent('/settings')
    expect(screen.getByRole('dialog')).toHaveFocus()
    await user.type(screen.getByRole('textbox', { name: 'Your message' }), 'Keep this draft while the viewport changes.')
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('current-path')).toHaveTextContent('/settings')
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 123))
    if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY)
    if (originalScrollTo) Object.defineProperty(window, 'scrollTo', originalScrollTo)
  })

  it('uses simulated visual viewport height for mobile and keeps draft and action controls available', async () => {
    const viewport = new EventTarget() as VisualViewport
    Object.defineProperties(viewport, { height: { configurable: true, writable: true, value: 720 }, width: { configurable: true, writable: true, value: 390 }, offsetTop: { configurable: true, writable: true, value: 0 }, offsetLeft: { configurable: true, writable: true, value: 0 } })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const user = userEvent.setup()
    renderAction()
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    const dialog = screen.getByRole('dialog')
    const backdrop = dialog.parentElement as HTMLElement
    const textarea = screen.getByRole('textbox', { name: 'Your message' })
    await user.type(textarea, 'Mobile draft stays here.')
    expect(backdrop.style.height).toBe('720px')
    Object.defineProperty(viewport, 'height', { configurable: true, writable: true, value: 390 })
    viewport.dispatchEvent(new Event('resize'))
    expect(backdrop.style.height).toBe('390px')
    expect(textarea).toHaveValue('Mobile draft stays here.')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(dialog.querySelector('footer button[type="submit"]')).toBeEnabled()
  })
})
