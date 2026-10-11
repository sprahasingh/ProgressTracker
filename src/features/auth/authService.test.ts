import { describe, expect, it, vi } from 'vitest'
import { requestAccountDeletionReauthentication } from './authService'

const clientMocks = vi.hoisted(() => ({ signInWithOtp: vi.fn() }))
vi.mock('../../services/supabase/client', () => ({
  getSupabaseClient: () => ({ auth: { signInWithOtp: clientMocks.signInWithOtp } }),
}))

describe('account deletion reauthentication', () => {
  it('requests a magic link for an existing user and uses the clean PKCE callback URL', async () => {
    clientMocks.signInWithOtp.mockResolvedValue({ error: null })
    await expect(requestAccountDeletionReauthentication('person@example.com', 'https://example.com/ProgressTracker/'))
      .resolves.toEqual({ error: null })
    expect(clientMocks.signInWithOtp).toHaveBeenCalledWith({
      email: 'person@example.com',
      options: { emailRedirectTo: 'https://example.com/ProgressTracker/', shouldCreateUser: false },
    })
  })
})
