import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../services/supabase/client'
import { activateWorkspace, decideGuestData, getGuestDecision, getGuestWorkspaceSummary, type GuestWorkspaceSummary } from '../../db/database'
import { synchronizeWorkspace, type SyncSummary } from '../../services/supabase/syncEngine'

export type AuthStatus = 'loading' | 'local-only' | 'signed-out' | 'signed-in'

type AuthState = {
  status: AuthStatus
  user: User | null
  passwordRecovery: boolean
  completePasswordRecovery: () => void
  workspaceStatus: 'loading' | 'ready' | 'needs-guest-choice' | 'error'
  workspaceUserId: string | null
  guestSummary: GuestWorkspaceSummary | null
  workspaceError: string | null
  chooseGuestData: (decision: 'imported' | 'kept-separate') => Promise<void>
  retryWorkspace: () => void
  syncStatus: 'idle' | 'syncing' | 'complete' | 'error'
  syncSummary: SyncSummary | null
  syncError: string | null
  syncNow: () => Promise<void>
  signOut: () => Promise<string | null>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [passwordRecovery, setPasswordRecovery] = useState(false)
  const [workspaceStatus, setWorkspaceStatus] = useState<AuthState['workspaceStatus']>('loading')
  const [workspaceUserId, setWorkspaceUserId] = useState<string | null>(null)
  const [guestSummary, setGuestSummary] = useState<GuestWorkspaceSummary | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [workspaceRetry, setWorkspaceRetry] = useState(0)
  const [syncStatus, setSyncStatus] = useState<AuthState['syncStatus']>('idle')
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const authUserIdRef = useRef<string | null>(null)
  authUserIdRef.current = status === 'signed-in' ? user?.id ?? null : null

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

  useEffect(() => {
    if (status === 'loading') return
    let current = true
    const userId = status === 'signed-in' ? user?.id ?? null : null
    setWorkspaceStatus('loading')
    setWorkspaceError(null)
    setSyncStatus('idle')
    setSyncSummary(null)
    setSyncError(null)
    void (async () => {
      try {
        await activateWorkspace(userId)
        if (!current) return
        setWorkspaceUserId(userId)
        if (!userId) { setGuestSummary(null); setWorkspaceStatus('ready'); return }
        const [decision, summary] = await Promise.all([getGuestDecision(userId), getGuestWorkspaceSummary()])
        if (!current) return
        setGuestSummary(summary)
        if (summary.hasData && !decision) setWorkspaceStatus('needs-guest-choice')
        else {
          if (!decision) await decideGuestData(userId, 'kept-separate')
          setWorkspaceStatus('ready')
        }
      } catch (cause) {
        if (!current) return
        setWorkspaceError(cause instanceof Error ? cause.message : 'The local workspace could not be opened.')
        setWorkspaceStatus('error')
      }
    })()
    return () => { current = false }
  }, [status, user?.id, workspaceRetry])

  async function signOut(): Promise<string | null> {
    const client = getSupabaseClient()
    if (!client) return null
    const { error } = await client.auth.signOut()
    return error?.message ?? null
  }

  function completePasswordRecovery() {
    setPasswordRecovery(false)
  }

  async function chooseGuestData(decision: 'imported' | 'kept-separate') {
    if (!user?.id || workspaceUserId !== user.id || workspaceStatus !== 'needs-guest-choice') return
    const ownerId = user.id
    setWorkspaceStatus('loading')
    try {
      await decideGuestData(ownerId, decision)
      if (authUserIdRef.current === ownerId) setWorkspaceStatus('ready')
    } catch (cause) {
      if (authUserIdRef.current !== ownerId) return
      setWorkspaceError(cause instanceof Error ? cause.message : 'The guest data decision could not be saved.')
      setWorkspaceStatus('needs-guest-choice')
    }
  }

  function retryWorkspace() { setWorkspaceRetry((attempt) => attempt + 1) }

  async function syncNow() {
    const ownerId = user?.id
    if (!ownerId || status !== 'signed-in' || workspaceStatus !== 'ready' || workspaceUserId !== ownerId) {
      setSyncError('Open this account’s local workspace before syncing.')
      setSyncStatus('error')
      return
    }
    setSyncStatus('syncing')
    setSyncError(null)
    try {
      const result = await synchronizeWorkspace(ownerId)
      if (authUserIdRef.current !== ownerId) return
      setSyncSummary(result)
      setSyncStatus(result.failed > 0 ? 'error' : 'complete')
      if (result.failed > 0) setSyncError('Some changes remain on this device. Check your connection and retry.')
    } catch (cause) {
      if (authUserIdRef.current !== ownerId) return
      setSyncError(cause instanceof Error ? cause.message : 'Sync could not complete. Your local records are retained.')
      setSyncStatus('error')
    }
  }

  return <AuthContext.Provider value={{ status, user, passwordRecovery, completePasswordRecovery, workspaceStatus, workspaceUserId, guestSummary, workspaceError, chooseGuestData, retryWorkspace, syncStatus, syncSummary, syncError, syncNow, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used within AuthProvider.')
  return value
}
