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

export async function signInWithPassword(email: string, password: string): Promise<{ error: string | null }> {
  const client = getSupabaseClient()
  if (!client) return { error: 'Supabase is not configured. Local use is still available on this device.' }
  const { error } = await client.auth.signInWithPassword({ email, password })
  return { error: error?.message ?? null }
}

export async function signUpWithPassword(email: string, password: string, redirectTo: string): Promise<{ error: string | null; requiresEmailConfirmation: boolean }> {
  const client = getSupabaseClient()
  if (!client) return { error: 'Supabase is not configured. Local use is still available on this device.', requiresEmailConfirmation: false }
  const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } })
  return { error: error?.message ?? null, requiresEmailConfirmation: !data.session }
}

export async function sendPasswordReset(email: string, redirectTo: string): Promise<{ error: string | null }> {
  const client = getSupabaseClient()
  if (!client) return { error: 'Supabase is not configured. Local use is still available on this device.' }
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo })
  return { error: error?.message ?? null }
}

export async function updateAccountPassword(password: string): Promise<{ error: string | null }> {
  const client = getSupabaseClient()
  if (!client) return { error: 'Supabase is not configured. Local use is still available on this device.' }
  const { error } = await client.auth.updateUser({ password })
  return { error: error?.message ?? null }
}

export async function updateAccountName(name: string): Promise<{ error: string | null }> {
  const client = getSupabaseClient()
  if (!client) return { error: 'Supabase is not configured.' }
  const { data: { user }, error: userError } = await client.auth.getUser()
  if (userError || !user) return { error: userError?.message ?? 'Your session has expired. Sign in again.' }
  const { error } = await client.auth.updateUser({ data: { ...user.user_metadata, display_name: name, full_name: name } })
  return { error: error?.message ?? null }
}

export async function requestAccountEmailChange(email: string, redirectTo: string): Promise<{ error: string | null; pendingEmail: string | null }> {
  const client = getSupabaseClient()
  if (!client) return { error: 'Supabase is not configured.', pendingEmail: null }
  const { data, error } = await client.auth.updateUser({ email }, { emailRedirectTo: redirectTo })
  if (error) return { error: error.message, pendingEmail: null }
  return { error: null, pendingEmail: data.user.new_email ?? email }
}
