import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../services/supabase/client'
import { activateWorkspace, decideGuestData, getGuestDecision, getGuestWorkspaceSummary, type GuestDataDecision, type GuestWorkspaceSummary } from '../../db/database'
import { synchronizeWorkspace, type SyncSummary } from '../../services/supabase/syncEngine'

export type AuthStatus = 'loading' | 'local-only' | 'signed-out' | 'signed-in'

type AuthState = {
  status: AuthStatus
  user: User | null
  passwordRecovery: boolean
  completePasswordRecovery: () => void
  workspaceStatus: 'loading' | 'ready' | 'needs-guest-choice' | 'error'
  workspaceUserId: string | null
  sessionTransitionPending: boolean
  guestSummary: GuestWorkspaceSummary | null
  workspaceError: string | null
  chooseGuestData: (decision: GuestDataDecision) => Promise<void>
  retryWorkspace: () => void
  syncStatus: 'idle' | 'waiting' | 'offline' | 'syncing' | 'complete' | 'error'
  syncTrigger: 'automatic' | 'manual' | null
  isOnline: boolean
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
  const [sessionTransitionPending, setSessionTransitionPending] = useState(false)
  const [guestSummary, setGuestSummary] = useState<GuestWorkspaceSummary | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [workspaceRetry, setWorkspaceRetry] = useState(0)
  const [syncStatus, setSyncStatus] = useState<AuthState['syncStatus']>('idle')
  const [syncTrigger, setSyncTrigger] = useState<AuthState['syncTrigger']>(null)
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const isOnlineRef = useRef(isOnline)
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const authUserIdRef = useRef<string | null>(null)
  const authInitializedRef = useRef(false)
  const workspaceReadyRef = useRef(false)
  const syncPromisesRef = useRef(new Map<string, Promise<void>>())
  const lastAutomaticAttemptRef = useRef<string | null>(null)
  const onlineEventSequenceRef = useRef(0)
  const [onlineEventSequence, setOnlineEventSequence] = useState(0)
  authUserIdRef.current = status === 'signed-in' ? user?.id ?? null : null
  workspaceReadyRef.current = status === 'signed-in' && workspaceStatus === 'ready' && workspaceUserId === user?.id

  useEffect(() => {
    if (typeof window === 'undefined') return
    const updateOnline = () => {
      const online = navigator.onLine
      if (isOnlineRef.current === online) return
      isOnlineRef.current = online
      setIsOnline(online)
      if (online) {
        onlineEventSequenceRef.current += 1
        setOnlineEventSequence(onlineEventSequenceRef.current)
      }
    }
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [])

  useEffect(() => {
    const client = getSupabaseClient()
    if (!client) {
      setStatus('local-only')
      return
    }

    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      // Keep every route behind the workspace gate until Supabase reports its
      // persisted session. Other auth events can arrive during initialization;
      // none of them is sufficient to select a local database on its own.
      if (event === 'INITIAL_SESSION') authInitializedRef.current = true
      else if (!authInitializedRef.current) return
      setUser(session?.user ?? null)
      setStatus(session ? 'signed-in' : 'signed-out')
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') setSessionTransitionPending(false)
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

  function requestSync(ownerId: string, trigger: 'automatic' | 'manual'): Promise<void> {
    const active = syncPromisesRef.current.get(ownerId)
    if (active) return active

    const promise = Promise.resolve().then(async () => {
      if (authUserIdRef.current !== ownerId || !workspaceReadyRef.current) return
      setSyncStatus('syncing')
      setSyncTrigger(trigger)
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
    }).finally(() => {
      if (syncPromisesRef.current.get(ownerId) === promise) syncPromisesRef.current.delete(ownerId)
    })
    syncPromisesRef.current.set(ownerId, promise)
    return promise
  }

  useEffect(() => {
    if (status !== 'signed-in' || !user?.id) {
      lastAutomaticAttemptRef.current = null
      return
    }
    if (workspaceStatus !== 'ready' || workspaceUserId !== user.id) return
    if (!isOnline) {
      setSyncStatus('offline')
      setSyncError(null)
      return
    }

    const attemptKey = `${user.id}:${onlineEventSequence}`
    if (lastAutomaticAttemptRef.current === attemptKey) return
    lastAutomaticAttemptRef.current = attemptKey
    setSyncStatus('waiting')
    void requestSync(user.id, 'automatic')
  }, [status, user?.id, workspaceStatus, workspaceUserId, isOnline, onlineEventSequence])

  async function signOut(): Promise<string | null> {
    const client = getSupabaseClient()
    if (!client) return null
    setSessionTransitionPending(true)
    try {
      const { error } = await client.auth.signOut()
      if (error) {
        setSessionTransitionPending(false)
        return error.message
      }
      setUser(null)
      setStatus('signed-out')
      setPasswordRecovery(false)
      setSessionTransitionPending(false)
      return null
    } catch (cause) {
      setSessionTransitionPending(false)
      return cause instanceof Error ? cause.message : 'Sign out could not be completed.'
    }
  }

  function completePasswordRecovery() {
    setPasswordRecovery(false)
  }

  async function chooseGuestData(decision: GuestDataDecision) {
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
    await requestSync(ownerId, 'manual')
  }

  return <AuthContext.Provider value={{ status, user, passwordRecovery, completePasswordRecovery, workspaceStatus, workspaceUserId, sessionTransitionPending, guestSummary, workspaceError, chooseGuestData, retryWorkspace, syncStatus, syncTrigger, isOnline, syncSummary, syncError, syncNow, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used within AuthProvider.')
  return value
}
