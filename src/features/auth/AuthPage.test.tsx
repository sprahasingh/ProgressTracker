import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthPage } from './AuthPage'

const authMocks = vi.hoisted(() => ({
  sendSignInLink: vi.fn(),
  useAuth: vi.fn(),
}))

vi.mock('./authService', () => ({ sendSignInLink: authMocks.sendSignInLink }))
vi.mock('./AuthProvider', () => ({ useAuth: authMocks.useAuth }))
vi.mock('../../services/supabase/client', () => ({
  supabaseConfiguration: { status: 'ready' },
}))

describe('AuthPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    authMocks.sendSignInLink.mockReset()
    authMocks.useAuth.mockReturnValue({ status: 'signed-out', user: null, signOut: vi.fn() })
  })

  it('validates email before requesting a link', async () => {
    const user = userEvent.setup()
    render(<AuthPage />)

    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address.')
    expect(authMocks.sendSignInLink).not.toHaveBeenCalled()
  })

  it('requests a one-time sign-in link and confirms the destination', async () => {
    const user = userEvent.setup()
    authMocks.sendSignInLink.mockResolvedValue({ error: null })
    render(<AuthPage />)

    await user.type(screen.getByLabelText('Email address'), '  PERSON@example.com  ')
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument()
    expect(authMocks.sendSignInLink).toHaveBeenCalledWith('person@example.com', expect.any(String))
  })

  it('shows service errors without losing the entered email', async () => {
    const user = userEvent.setup()
    authMocks.sendSignInLink.mockResolvedValue({ error: 'Email provider is not enabled.' })
    render(<AuthPage />)

    const emailField = screen.getByLabelText('Email address')
    await user.type(emailField, 'person@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Email provider is not enabled.')
    expect(emailField).toHaveValue('person@example.com')
  })
})
