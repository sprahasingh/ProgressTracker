import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../services/supabase/client'

export type AuthStatus = 'loading' | 'local-only' | 'signed-out' | 'signed-in'

type AuthState = {
  status: AuthStatus
  user: User | null
  passwordRecovery: boolean
  completePasswordRecovery: () => void
  signOut: () => Promise<string | null>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [passwordRecovery, setPasswordRecovery] = useState(false)

  useEffect(() => {
    const client = getSupabaseClient()
    if (!client) {
      setStatus('local-only')
      return
    }

    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null)
      setStatus(session ? 'signed-in' : 'signed-out')
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true)
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') setPasswordRecovery(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function signOut(): Promise<string | null> {
    const client = getSupabaseClient()
    if (!client) return null
    const { error } = await client.auth.signOut()
    return error?.message ?? null
  }

  function completePasswordRecovery() {
    setPasswordRecovery(false)
  }

  return <AuthContext.Provider value={{ status, user, passwordRecovery, completePasswordRecovery, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used within AuthProvider.')
  return value
}
