import { getSupabaseClient } from '../../services/supabase/client'

export async function sendSignInLink(email: string, redirectTo: string): Promise<{ error: string | null }> {
  const client = getSupabaseClient()
  if (!client) return { error: 'Supabase is not configured. Local use is still available on this device.' }

  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo,
      shouldCreateUser: true,
    },
  })

  return { error: error?.message ?? null }
}
