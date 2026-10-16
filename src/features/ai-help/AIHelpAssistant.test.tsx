import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { AIHelpAssistant } from './AIHelpAssistant'
import { verifiedQuestionCatalog } from './_generated/verifiedQuestionCatalog'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), status: 'signed-in', isOnline: true }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => ({ auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null }) }, functions: { invoke: mocks.invoke } }) }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: mocks.status, isOnline: mocks.isOnline, user: mocks.status === 'signed-in' ? { id: 'user-1', email: 'person@example.com' } : null }) }))

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  mocks.invoke.mockReset()
  mocks.status = 'signed-in'
  mocks.isOnline = true
  vi.unstubAllGlobals()
})

function CurrentPath() { return <output data-testid="current-path">{useLocation().pathname}</output> }
function renderAssistant(path = '/') { return render(<MemoryRouter initialEntries={[path]}><CurrentPath /><AIHelpAssistant /></MemoryRouter>) }
function findAssistantPanel(role: 'region' | 'dialog') {
  return screen.findByRole(role, { name: 'Ask ProgressTracker' }, { timeout: 5_000 })
}

describe('AI Help Assistant', () => {
  it('opens from the accessible header entry and submits a page-aware suggestion', async () => {
    mocks.invoke.mockResolvedValue({ data: { answer: 'A streak counts scheduled days.', links: [{ label: 'Insights', href: '/dashboard' }], followUps: ['How do holidays affect streaks?'] }, error: null })
    const user = userEvent.setup()
    renderAssistant('/dashboard')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    expect(await findAssistantPanel('region')).toBeInTheDocument()
    await user.type(await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' }), 'How is completion rate calculated?{Enter}')
    expect(await screen.findByText('A streak counts scheduled days.')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('ai-help', expect.objectContaining({ body: expect.objectContaining({ pageContext: 'analytics' }) }))
    expect(screen.getByRole('link', { name: 'Insights' })).toHaveAttribute('href', '/dashboard')
    expect(await screen.findByRole('navigation', { name: 'Suggested follow-up questions' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'How do holidays affect streaks?' }))
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('answers a clicked verified suggestion locally and keeps answer actions available', async () => {
    const user = userEvent.setup()
    renderAssistant('/analytics')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    await findAssistantPanel('region')
    await waitFor(() => expect(screen.getAllByRole('button').some((button) => button.closest('.ai-help-suggestions'))).toBe(true))
    const question = screen.getAllByRole('button').find((button) => button.closest('.ai-help-suggestions'))!
    const text = question.textContent!.trim()
    const answer = verifiedQuestionCatalog.find((entry) => entry.question === text)!.answer
    await user.click(question)
    await waitFor(() => expect(document.querySelector('.ai-help-message.assistant .ai-help-formatted')?.textContent).toBe(answer))
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '👍 Helpful' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '👎 Incorrect' })).toBeInTheDocument()
  })

  it('navigates to the validated Bin link and closes the mobile assistant', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: query.includes('max-width: 760px'), addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    mocks.invoke.mockResolvedValue({ data: { answer: 'Open The Bin to review retained trackers.', links: [{ label: 'The Bin', href: '/bin' }] }, error: null })
    const user = userEvent.setup()
    renderAssistant('/calendar')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    await user.type(await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' }), 'Where is The Bin?{Enter}')
    await user.click(await screen.findByRole('link', { name: 'The Bin' }))
    expect(screen.getByTestId('current-path')).toHaveTextContent('/bin')
    expect(screen.queryByRole('dialog', { name: 'Ask ProgressTracker' })).not.toBeInTheDocument()
  })

  it('opens the shared general feedback dialog from the AI Help header', async () => {
    mocks.status = 'signed-in'
    const user = userEvent.setup()
    renderAssistant()
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    await user.click(await screen.findByRole('button', { name: 'Send general feedback' }))
    expect(await screen.findByRole('dialog', { name: 'Send Feedback' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Your message' })).toBeInTheDocument()
  })

  it('keeps the nested AI Help feedback dialog interactive while tapping, typing, selecting, and resizing on mobile', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: query.includes('max-width: 760px'), addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    const viewport = new EventTarget() as VisualViewport
    Object.defineProperties(viewport, { height: { configurable: true, writable: true, value: 700 }, width: { configurable: true, writable: true, value: 390 }, offsetTop: { configurable: true, writable: true, value: 0 }, offsetLeft: { configurable: true, writable: true, value: 0 } })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const user = userEvent.setup()
    mocks.invoke.mockResolvedValue({ data: { accepted: true }, error: null })
    renderAssistant('/goals')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    const panel = await findAssistantPanel('dialog')
    await user.click(await screen.findByRole('button', { name: 'Send general feedback' }))
    const feedback = await screen.findByRole('dialog', { name: 'Send Feedback' })
    expect(panel).toHaveProperty('inert', true)
    expect(feedback.parentElement?.parentElement).toBe(document.body)
    const textarea = screen.getByRole('textbox', { name: 'Your message' })
    await user.click(textarea)
    await user.type(textarea, 'Feedback from the chat should stay open.')
    await user.selectOptions(screen.getByLabelText('Feedback type'), 'bug_report')
    Object.defineProperty(viewport, 'height', { configurable: true, writable: true, value: 350 })
    viewport.dispatchEvent(new Event('resize'))
    expect(await screen.findByRole('dialog', { name: 'Send Feedback' })).toBeInTheDocument()
    expect(textarea).toHaveValue('Feedback from the chat should stay open.')
    expect(screen.getByLabelText('Feedback type')).toHaveValue('bug_report')
    expect(feedback.parentElement).toHaveStyle({ height: '350px' })
    expect(screen.getByTestId('current-path')).toHaveTextContent('/goals')
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }))
    expect(await screen.findByText(/Feedback saved\. Thank you/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByRole('dialog', { name: 'Ask ProgressTracker' })).toBeInTheDocument()
    expect(screen.getByTestId('current-path')).toHaveTextContent('/goals')
  })

  it('keeps the desktop AI Help panel open while interacting with its portaled feedback dialog', async () => {
    const user = userEvent.setup()
    renderAssistant('/settings')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    const panel = await findAssistantPanel('region')
    await user.click(await screen.findByRole('button', { name: 'Send general feedback' }))
    const dialog = await screen.findByRole('dialog', { name: 'Send Feedback' })
    const textarea = screen.getByRole('textbox', { name: 'Your message' })
    await user.click(textarea)
    await user.type(textarea, 'Desktop feedback stays available.')
    expect(dialog).toBeInTheDocument()
    expect(panel).toBeInTheDocument()
    expect(textarea).toHaveValue('Desktop feedback stays available.')
    expect(screen.getByTestId('current-path')).toHaveTextContent('/settings')
  })

  it('keeps the inline answer review form open while editing and submits to the existing review endpoint', async () => {
    mocks.invoke.mockResolvedValue({ data: { answer: 'A goal can use daily or cumulative planning.', topic: 'goals', knowledge_version: 'test-v1' }, error: null })
    const user = userEvent.setup()
    renderAssistant('/goals')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    await user.type(await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' }), 'What is a goal?{Enter}')
    await user.click(await screen.findByRole('button', { name: '👎 Incorrect' }))
    const note = await screen.findByRole('textbox', { name: /Optional note/ })
    await user.type(note, 'The answer needs clarification.')
    await user.selectOptions(screen.getByLabelText('What was wrong?'), 'outdated')
    await user.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('ai-help-feedback', expect.objectContaining({ body: expect.objectContaining({ category: 'outdated', explanation: 'The answer needs clarification.' }) })))
    expect(await screen.findByText('Thanks. Your report was sent for review.')).toBeInTheDocument()
  })

  it('opens an editable support query for direct requests and sends only after confirmation', async () => {
    mocks.invoke.mockResolvedValue({ data: { accepted: true }, error: null })
    const user = userEvent.setup()
    renderAssistant('/goals')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    const input = await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' })
    await user.type(input, 'I want to report a bug: my goal will not update.{Enter}')
    const support = await screen.findByRole('textbox', { name: /Support query/ })
    expect(support).toHaveValue('I want to report a bug: my goal will not update.')
    expect(screen.getByRole('checkbox', { name: /Share my email with support/ })).toBeChecked()
    const supportForm = support.closest('form')!
    expect(supportForm.querySelector('.ai-help-support-body')).toContainElement(support)
    expect(supportForm.querySelector('footer')).toContainElement(screen.getByRole('button', { name: 'Send Query' }))
    expect(supportForm.querySelector('footer')).toContainElement(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText(/Your query and replies stay in My Support Queries/)).toBeInTheDocument()
    expect(screen.queryByText(/spraha\.progresstracker@gmail\.com/)).not.toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalled()
    await user.clear(support)
    await user.type(support, 'My corrected support description.')
    await user.click(screen.getByRole('button', { name: 'Send Query' }))
    expect(await screen.findByText('Support query saved.')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('send-feedback', expect.objectContaining({
      body: expect.objectContaining({ category: 'help_support', message: 'My corrected support description.' }),
      headers: { Authorization: 'Bearer test-token' },
    }))
  })

  it('allows support-query submission without sharing the account email', async () => {
    mocks.invoke.mockResolvedValue({ data: { accepted: true }, error: null })
    const user = userEvent.setup()
    renderAssistant('/settings')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    await user.type(await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' }), 'I need help from a human.{Enter}')
    await user.click(await screen.findByRole('checkbox', { name: /Share my email with support/ }))
    await user.click(screen.getByRole('button', { name: 'Send Query' }))
    await screen.findByText('Support query saved.')
    expect(mocks.invoke).toHaveBeenCalledWith('send-feedback', expect.objectContaining({ body: expect.objectContaining({ category: 'help_support', share_email: false }) }))
  })

  it('offers a support action after an uncertain answer and preserves the original question in the editable form', async () => {
    mocks.invoke.mockResolvedValue({ data: { answer: 'I can’t confirm that. Want to raise a support query?', offerSupport: true, supportPrefill: 'Can the unavailable export run?' }, error: null })
    const user = userEvent.setup()
    renderAssistant()
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    await user.type(await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' }), 'Can the unavailable export run?{Enter}')
    await user.click(await screen.findByRole('button', { name: 'Raise Support Query' }))
    expect(await screen.findByRole('textbox', { name: /Support query/ })).toHaveValue('Can the unavailable export run?')
  })

  it('keeps the in-chat support actions visible in the simulated mobile visual viewport and preserves route and draft', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: query.includes('max-width: 760px'), addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    const viewport = new EventTarget() as VisualViewport
    Object.defineProperties(viewport, { height: { configurable: true, writable: true, value: 720 }, width: { configurable: true, writable: true, value: 390 }, offsetTop: { configurable: true, writable: true, value: 0 }, offsetLeft: { configurable: true, writable: true, value: 0 } })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const user = userEvent.setup()
    renderAssistant('/settings')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    await user.type(await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' }), 'Can I talk to support?{Enter}')
    const message = await screen.findByRole('textbox', { name: /Support query/ })
    const panel = screen.getByRole('dialog', { name: 'Ask ProgressTracker' })
    expect(panel.style.height).toBe('720px')
    expect(message).toHaveValue('Can I talk to support?')
    Object.defineProperty(viewport, 'height', { configurable: true, writable: true, value: 380 })
    viewport.dispatchEvent(new Event('resize'))
    expect(panel.style.height).toBe('380px')
    expect(message).toHaveValue('Can I talk to support?')
    expect(screen.getByRole('button', { name: 'Send Query' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(screen.getByTestId('current-path')).toHaveTextContent('/settings')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('textbox', { name: 'Ask about ProgressTracker' })).toBeInTheDocument()
    expect(screen.getByTestId('current-path')).toHaveTextContent('/settings')
  })

  it('supports Enter submission, Shift+Enter newlines, and prevents empty messages', async () => {
    mocks.invoke.mockResolvedValue({ data: { answer: 'Yes.' }, error: null })
    const user = userEvent.setup()
    renderAssistant()
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    const input = await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    await user.type(input, 'How do streaks work?{Shift>}{Enter}{/Shift}When do they reset?')
    expect(input).toHaveValue('How do streaks work?\nWhen do they reset?')
    await user.keyboard('{Control>}a{/Control}{Enter}')
    expect(await screen.findByText('Yes.')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps the failed question in the composer and exposes a working retry', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: null, error: new Error('network') }).mockResolvedValueOnce({ data: { answer: 'Recovered.' }, error: null })
    const user = userEvent.setup()
    renderAssistant()
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    const input = await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' })
    await user.type(input, 'What is the daily target?{Enter}')
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(input).toHaveValue('What is the daily target?')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Recovered.')).toBeInTheDocument())
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps one actionable failure card after repeated failed requests', async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: new Error('network') })
    const user = userEvent.setup()
    renderAssistant()
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    const input = await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' })
    await user.type(input, 'Explain a purple control{Enter}')
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, 'Explain an orange control{Enter}')
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1))
  })

  it('shows provider cooldown guidance, keeps the draft, and unlocks retry afterward', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ code: 'provider_rate_limit', retryAfterSeconds: 4 }), { status: 429, headers: { 'Retry-After': '4' } }) } })
      .mockResolvedValueOnce({ data: { answer: 'Recovered after cooldown.' }, error: null })
    const user = userEvent.setup()
    renderAssistant()
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    const input = await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' })
    await user.type(input, 'Explain a custom feature setting{Enter}')
    expect((await screen.findAllByText(/provider is busy/)).length).toBeGreaterThan(0)
    expect(input).toHaveValue('Explain a custom feature setting')
    const cooldown = await screen.findByRole('button', { name: /^Retry in/ })
    expect(cooldown).toBeDisabled()
    const retry = await screen.findByRole('button', { name: 'Retry' }, { timeout: 5500 })
    expect(retry).toBeEnabled()
    await user.click(retry)
    expect(await screen.findByText('Recovered after cooldown.')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  }, 10000)

  it('serves the local FAQ without contacting the backend while offline', async () => {
    mocks.isOnline = false
    const user = userEvent.setup()
    renderAssistant()
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    const question = screen.getAllByRole('button').find((button) => button.closest('.ai-help-suggestions'))!
    const answer = verifiedQuestionCatalog.find((entry) => entry.question === question.textContent!.trim())!.answer
    await user.click(question)
    expect(await screen.findByText(answer)).toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('preserves the active draft when the panel closes and reopens', async () => {
    const user = userEvent.setup()
    renderAssistant()
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    const input = await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' })
    await user.type(input, 'Can you explain schedules?')
    await user.click(screen.getByRole('button', { name: 'Close AI Help Assistant' }))
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    expect(await screen.findByRole('textbox', { name: 'Ask about ProgressTracker' })).toHaveValue('Can you explain schedules?')
  })

  it('uses dialog semantics, Escape dismissal, and restores focus on mobile', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: query.includes('max-width: 760px'), addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    const user = userEvent.setup()
    renderAssistant()
    const trigger = screen.getByRole('button', { name: 'Open AI Help Assistant' })
    await user.click(trigger)
    expect(await findAssistantPanel('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('textbox', { name: 'Ask about ProgressTracker' })).not.toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask ProgressTracker' })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })
})
