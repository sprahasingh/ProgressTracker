import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AIHelpAssistant } from './AIHelpAssistant'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), status: 'signed-in', isOnline: true }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => ({ functions: { invoke: mocks.invoke } }) }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: mocks.status, isOnline: mocks.isOnline }) }))

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  mocks.invoke.mockReset()
  mocks.status = 'signed-in'
  mocks.isOnline = true
  vi.unstubAllGlobals()
})

function renderAssistant(path = '/') { return render(<MemoryRouter initialEntries={[path]}><AIHelpAssistant /></MemoryRouter>) }

describe('AI Help Assistant', () => {
  it('opens from the accessible header entry and submits a page-aware suggestion', async () => {
    mocks.invoke.mockResolvedValue({ data: { answer: 'A streak counts scheduled days.', links: [{ label: 'Insights', href: '/dashboard' }], followUps: ['How do holidays affect streaks?'] }, error: null })
    const user = userEvent.setup()
    renderAssistant('/dashboard')
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    expect(await screen.findByRole('region', { name: 'Ask ProgressTracker' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'How is completion rate calculated?' }))
    expect(await screen.findByText('A streak counts scheduled days.')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('ai-help', expect.objectContaining({ body: expect.objectContaining({ pageContext: 'analytics' }) }))
    expect(screen.getByRole('link', { name: 'Insights' })).toHaveAttribute('href', '/dashboard')
    expect(await screen.findByRole('navigation', { name: 'Suggested follow-up questions' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'How do holidays affect streaks?' }))
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
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
  })

  it('serves the local FAQ without contacting the backend while offline', async () => {
    mocks.isOnline = false
    const user = userEvent.setup()
    renderAssistant()
    await user.click(screen.getByRole('button', { name: 'Open AI Help Assistant' }))
    await user.click(screen.getByRole('button', { name: 'How are streaks calculated?' }))
    expect(await screen.findByText(/A streak counts consecutive scheduled/)).toBeInTheDocument()
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
    expect(await screen.findByRole('dialog', { name: 'Ask ProgressTracker' })).toHaveAttribute('aria-modal', 'true')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask ProgressTracker' })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })
})
