import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../services/supabase/client'
import { activateWorkspace, clearDeletedAccountWorkspace, countPendingWorkspaceSyncOperations, decideGuestData, getGuestDecision, getGuestWorkspaceSummary, type GuestDataDecision, type GuestWorkspaceSummary } from '../../db/database'
import { synchronizeWorkspace, type SyncSummary } from '../../services/supabase/syncEngine'
import { subscribeToWorkspaceMutations } from '../../db/workspaceMutationEvents'
import { clearPushCleanup, getPendingPushCleanups, getStoredPushOwner, managePushSubscriptionWithSupabase, queuePushCleanup, revokePushBeforeSignOut, setStoredPushOwner, setWorkerPushOwner, withPushOwnershipLock } from '../notifications/pushSubscriptionService'
import { isTrackerRecoveryInspectionMode } from './recoveryInspectionMode'
import { reportStorageFailure, storageDiagnosticEventName, storageFailureMessage, type StorageDiagnostic } from '../../db/storageDiagnostics'
import { syncFailureMessage, classifySyncFailure } from '../../services/supabase/syncFailureDiagnostics'

export type AuthStatus = 'loading' | 'local-only' | 'signed-out' | 'signed-in'

function deletionLockKey(ownerId: string) { return `progress-tracker:account-deletion:${ownerId}` }

function hasDeletionLock(ownerId: string): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    const startedAt = Number(localStorage.getItem(deletionLockKey(ownerId)))
    if (!startedAt) return false
    if (Date.now() - startedAt > 24 * 60 * 60_000) {
      localStorage.removeItem(deletionLockKey(ownerId))
      return false
    }
    return true
  } catch { return false }
}

function setDeletionLock(ownerId: string, locked: boolean) {
  if (typeof localStorage === 'undefined') return
  try {
    if (locked) localStorage.setItem(deletionLockKey(ownerId), String(Date.now()))
    else localStorage.removeItem(deletionLockKey(ownerId))
  } catch { /* The in-memory guard below still protects this tab. */ }
}

type AuthState = {
  status: AuthStatus
  user: User | null
  passwordRecovery: boolean
  completePasswordRecovery: () => void
  workspaceStatus: 'loading' | 'ready' | 'needs-guest-choice' | 'error'
  workspaceUserId: string | null
  sessionTransitionPending: boolean
  pushOwnershipStatus: 'ready' | 'pending' | 'cleanup-required'
  pushOwnershipMessage: string
  guestSummary: GuestWorkspaceSummary | null
  workspaceError: string | null
  workspaceDiagnostic: StorageDiagnostic | null
  chooseGuestData: (decision: GuestDataDecision) => Promise<void>
  retryWorkspace: () => void
  cloudRecoveryMode: boolean
  cloudRecoveryPending: boolean
  cloudRecoveryOperationsPending: boolean
  cloudRecoveryPriorOperationsSettled: boolean
  workspaceInitializationStalled: boolean
  workspaceInitializationPending: boolean
  enterCloudRecovery: () => Promise<void>
  syncStatus: 'idle' | 'waiting' | 'offline' | 'syncing' | 'complete' | 'error'
  syncTrigger: 'automatic' | 'manual' | null
  isOnline: boolean
  syncSummary: SyncSummary | null
  syncError: string | null
  syncNow: () => Promise<void>
  signOut: () => Promise<string | null>
  accountDeletionNotice: string | null
  prepareAccountDeletion: (ownerId: string) => Promise<number>
  resumeAccountSyncAfterDeletionFailure: (ownerId: string) => void
  finishAccountDeletion: (ownerId: string) => Promise<string | null>
}

const AuthContext = createContext<AuthState | null>(null)

const stalledWorkspaceRecoveryDelayMs = 5_000
const recoveryOperationWaitMs = 1_500

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [passwordRecovery, setPasswordRecovery] = useState(false)
  const [accountDeletionNotice, setAccountDeletionNotice] = useState<string | null>(null)
  const [workspaceStatus, setWorkspaceStatus] = useState<AuthState['workspaceStatus']>('loading')
  const [workspaceUserId, setWorkspaceUserId] = useState<string | null>(null)
  const [sessionTransitionPending, setSessionTransitionPending] = useState(false)
  const [pushOwnershipStatus, setPushOwnershipStatus] = useState<'ready' | 'pending' | 'cleanup-required'>('pending')
  const [pushOwnershipMessage, setPushOwnershipMessage] = useState('Checking this device’s subscription owner…')
  const [guestSummary, setGuestSummary] = useState<GuestWorkspaceSummary | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [workspaceDiagnostic, setWorkspaceDiagnostic] = useState<StorageDiagnostic | null>(null)
  const [workspaceRetry, setWorkspaceRetry] = useState(0)
  const [cloudRecoveryMode, setCloudRecoveryMode] = useState(false)
  const [cloudRecoveryPending, setCloudRecoveryPending] = useState(false)
  const [cloudRecoveryOperationsPending, setCloudRecoveryOperationsPending] = useState(false)
  const [cloudRecoveryPriorOperationsSettled, setCloudRecoveryPriorOperationsSettled] = useState(false)
  const [workspaceInitializationStalled, setWorkspaceInitializationStalled] = useState(false)
  const [workspaceInitializationPending, setWorkspaceInitializationPending] = useState(false)
  const cloudRecoveryModeRef = useRef(false)
  const cloudRecoveryTransitionRef = useRef(0)
  const workspaceInitializationIdRef = useRef(0)
  const workspaceInitializationPendingRef = useRef(false)
  const recoveryWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceInitializationPromiseRef = useRef<Promise<void> | null>(null)
  const recoveryWaitCancelRef = useRef<(() => void) | null>(null)
  const cloudRecoveryEntryPromiseRef = useRef<Promise<void> | null>(null)
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
  const deletionOwnerRef = useRef<string | null>(null)
  const mutationVersionRef = useRef(new Map<string, number>())
  const attemptedMutationVersionRef = useRef(new Map<string, number>())
  const mutationTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const requestSyncRef = useRef<(ownerId: string, trigger: 'automatic' | 'manual') => Promise<void>>(async () => {})
  const lastAutomaticAttemptRef = useRef<string | null>(null)
  const onlineEventSequenceRef = useRef(0)
  const [onlineEventSequence, setOnlineEventSequence] = useState(0)
  const pushSessionRef = useRef<Session | null>(null)
  const pushTransitionSequenceRef = useRef(0)
  const pushTransitionChainRef = useRef<Promise<void>>(Promise.resolve())
  authUserIdRef.current = status === 'signed-in' ? user?.id ?? null : null
  workspaceReadyRef.current = status === 'signed-in' && workspaceStatus === 'ready' && workspaceUserId === user?.id

  useEffect(() => () => {
    cloudRecoveryTransitionRef.current += 1
    recoveryWaitCancelRef.current?.()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorageDiagnostic = (event: Event) => {
      const diagnostic = (event as CustomEvent<StorageDiagnostic>).detail
      if (diagnostic?.category !== 'blocked-connection' || workspaceReadyRef.current) return
      setWorkspaceError(storageFailureMessage(diagnostic.category))
      setWorkspaceStatus('error')
    }
    window.addEventListener(storageDiagnosticEventName(), onStorageDiagnostic)
    return () => window.removeEventListener(storageDiagnosticEventName(), onStorageDiagnostic)
  }, [])

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
      const previousSession = pushSessionRef.current
      const previousUserId = previousSession?.user.id ?? getStoredPushOwner()
      const nextUserId = session?.user.id ?? null
      if (previousUserId !== nextUserId) {
        cloudRecoveryTransitionRef.current += 1
        recoveryWaitCancelRef.current?.()
        cloudRecoveryModeRef.current = false
        setCloudRecoveryMode(false)
        setCloudRecoveryPending(false)
        setCloudRecoveryOperationsPending(false)
        setCloudRecoveryPriorOperationsSettled(false)
      }
      const transitionSequence = ++pushTransitionSequenceRef.current
      if (previousUserId && previousUserId !== nextUserId) {
        setPushOwnershipStatus('pending')
        setPushOwnershipMessage('Securing the previous account’s device subscription…')
        pushTransitionChainRef.current = pushTransitionChainRef.current.then(() => withPushOwnershipLock(async () => {
          const registration = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
            ? await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
            : null
          const currentSubscription = await registration?.pushManager?.getSubscription()
          if (currentSubscription) await queuePushCleanup(previousUserId, currentSubscription.endpoint)

          const pendingCleanups = await getPendingPushCleanups()
          const ownedCleanups = pendingCleanups.filter((cleanup) => cleanup.ownerId === previousUserId)
          if (ownedCleanups.length && previousSession?.access_token) {
            try {
              for (const cleanup of ownedCleanups) {
                await managePushSubscriptionWithSupabase(client, 'revoke', { endpoint: cleanup.endpoint }, previousSession.access_token)
                await clearPushCleanup(cleanup.ownerId)
              }
            } catch (error) {
              if (currentSubscription) await currentSubscription.unsubscribe()
              throw error
            }
            if (currentSubscription) await currentSubscription.unsubscribe()
            if (getStoredPushOwner() === previousUserId) setStoredPushOwner(null)
            setWorkerPushOwner(registration ?? null, null)
          } else if (ownedCleanups.length) {
            // The previous identity is no longer available. Keep its endpoint
            // queued for that account; never ask the replacement account to revoke it.
            if (currentSubscription) await currentSubscription.unsubscribe()
            throw new Error('Sign in to the previous account to finish removing this device subscription.')
          } else if (currentSubscription && previousSession?.access_token) {
            // Queue before the network request so an offline transition remains recoverable.
            await queuePushCleanup(previousUserId, currentSubscription.endpoint)
            await managePushSubscriptionWithSupabase(client, 'revoke', { endpoint: currentSubscription.endpoint }, previousSession.access_token)
            await currentSubscription.unsubscribe()
            await clearPushCleanup(previousUserId)
            if (getStoredPushOwner() === previousUserId) setStoredPushOwner(null)
            setWorkerPushOwner(registration ?? null, null)
          } else if (currentSubscription) {
            await currentSubscription.unsubscribe()
            throw new Error('Sign in to the previous account to remove this device subscription safely.')
          }

          // A restored prior account can authorize cleanup left by an earlier
          // offline switch. A different account cannot.
          if (nextUserId) {
            const pendingForNext = (await getPendingPushCleanups()).filter((cleanup) => cleanup.ownerId === nextUserId)
            for (const cleanup of pendingForNext) {
              await managePushSubscriptionWithSupabase(client, 'revoke', { endpoint: cleanup.endpoint }, session?.access_token)
              await clearPushCleanup(cleanup.ownerId)
            }
            if (pendingForNext.length) {
              setStoredPushOwner(null)
              const registration = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
                ? await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
                : null
              setWorkerPushOwner(registration ?? null, null)
            }
          }
        })).then(() => {
          if (transitionSequence === pushTransitionSequenceRef.current) {
            setPushOwnershipStatus('ready')
            setPushOwnershipMessage('This device is ready for the active account.')
          }
        }).catch((error: unknown) => {
          if (transitionSequence === pushTransitionSequenceRef.current) {
            setPushOwnershipStatus('cleanup-required')
            setPushOwnershipMessage(error instanceof Error ? error.message : 'The previous device subscription could not be cleared. Registration is paused.')
          }
        })
      } else if (event === 'INITIAL_SESSION' && nextUserId) {
        pushTransitionChainRef.current = pushTransitionChainRef.current.then(() => withPushOwnershipLock(async () => {
          const previousOwner = getStoredPushOwner()
          if (previousOwner && previousOwner !== nextUserId) {
            const registration = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
              ? await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
              : null
            const currentSubscription = await registration?.pushManager?.getSubscription()
            if (currentSubscription) {
              await queuePushCleanup(previousOwner, currentSubscription.endpoint)
              await currentSubscription.unsubscribe()
            }
            throw new Error('This device subscription belongs to another account. Sign in to that account to finish cleanup before registering it here.')
          }
          const pendingForNext = (await getPendingPushCleanups()).filter((cleanup) => cleanup.ownerId === nextUserId)
          for (const cleanup of pendingForNext) {
            await managePushSubscriptionWithSupabase(client, 'revoke', { endpoint: cleanup.endpoint }, session?.access_token)
            await clearPushCleanup(cleanup.ownerId)
          }
          if (pendingForNext.length) {
            setStoredPushOwner(null)
            const registration = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
              ? await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
              : null
            setWorkerPushOwner(registration ?? null, null)
          }
        })).then(() => {
          if (transitionSequence === pushTransitionSequenceRef.current) {
            setPushOwnershipStatus('ready')
            setPushOwnershipMessage('This device is ready for the active account.')
          }
        }).catch((error: unknown) => {
          if (transitionSequence === pushTransitionSequenceRef.current) {
            setPushOwnershipStatus('cleanup-required')
            setPushOwnershipMessage(error instanceof Error ? error.message : 'This device subscription needs cleanup before registration.')
          }
        })
      } else if (nextUserId && !cloudRecoveryModeRef.current) {
        setPushOwnershipStatus('pending')
        setPushOwnershipMessage('Checking this device’s subscription owner…')
        pushTransitionChainRef.current = pushTransitionChainRef.current.then(() => withPushOwnershipLock(async () => {
          const pendingForNext = (await getPendingPushCleanups()).filter((cleanup) => cleanup.ownerId === nextUserId)
          for (const cleanup of pendingForNext) {
            await managePushSubscriptionWithSupabase(client, 'revoke', { endpoint: cleanup.endpoint }, session?.access_token)
            await clearPushCleanup(cleanup.ownerId)
          }
          if (pendingForNext.length) {
            setStoredPushOwner(null)
            const registration = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
              ? await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
              : null
              setWorkerPushOwner(registration ?? null, null)
          }
        })).then(() => {
          if (transitionSequence === pushTransitionSequenceRef.current) {
            setPushOwnershipStatus('ready')
            setPushOwnershipMessage('This device is ready for the active account.')
          }
        }).catch((error: unknown) => {
          if (transitionSequence === pushTransitionSequenceRef.current) {
            setPushOwnershipStatus('cleanup-required')
            setPushOwnershipMessage(error instanceof Error ? error.message : 'This device subscription needs cleanup before registration.')
          }
        })
      } else if (event === 'INITIAL_SESSION') {
        setPushOwnershipStatus('ready')
        setPushOwnershipMessage('No signed-in account owns a device subscription.')
      }
      pushSessionRef.current = session
      setUser(session?.user ?? null)
      setStatus(session ? 'signed-in' : 'signed-out')
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') setSessionTransitionPending(false)
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true)
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') setPasswordRecovery(false)
      if (event === 'SIGNED_IN') setAccountDeletionNotice(null)
    })

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (status === 'loading') return
    let current = true
    const initializationId = ++workspaceInitializationIdRef.current
    const userId = status === 'signed-in' ? user?.id ?? null : null
    setWorkspaceStatus('loading')
    setWorkspaceError(null)
    setWorkspaceDiagnostic(null)
    setSyncStatus('idle')
    setSyncSummary(null)
    setSyncError(null)
    setWorkspaceInitializationStalled(false)
    workspaceInitializationPendingRef.current = true
    setWorkspaceInitializationPending(true)
    const stalledTimer = setTimeout(() => {
      if (current && workspaceInitializationIdRef.current === initializationId && workspaceInitializationPendingRef.current) setWorkspaceInitializationStalled(true)
    }, stalledWorkspaceRecoveryDelayMs)
    const initialization = (async () => {
      try {
        await activateWorkspace(userId)
        if (!current || workspaceInitializationIdRef.current !== initializationId || cloudRecoveryModeRef.current) return
        setWorkspaceUserId(userId)
        if (!userId) { setGuestSummary(null); setWorkspaceStatus('ready'); return }
        const [decision, summary] = await Promise.all([getGuestDecision(userId), getGuestWorkspaceSummary()])
        if (!current || workspaceInitializationIdRef.current !== initializationId || cloudRecoveryModeRef.current) return
        setGuestSummary(summary)
        if (summary.hasData && !decision) setWorkspaceStatus('needs-guest-choice')
        else {
          if (!decision) {
            await decideGuestData(userId, 'kept-separate')
            if (!current || workspaceInitializationIdRef.current !== initializationId || cloudRecoveryModeRef.current) return
          }
          setWorkspaceStatus('ready')
        }
      } catch (cause) {
        if (!current || workspaceInitializationIdRef.current !== initializationId || cloudRecoveryModeRef.current) return
        const diagnostic = reportStorageFailure('AuthProvider.workspace.initialize', 'transaction', cause)
        setWorkspaceDiagnostic(diagnostic)
        setWorkspaceError(storageFailureMessage(diagnostic.category))
        setWorkspaceStatus('error')
      } finally {
        clearTimeout(stalledTimer)
        if (workspaceInitializationIdRef.current === initializationId) {
          workspaceInitializationPendingRef.current = false
          setWorkspaceInitializationPending(false)
          setWorkspaceInitializationStalled(false)
        }
      }
    })()
    workspaceInitializationPromiseRef.current = initialization
    void initialization.finally(() => {
      if (workspaceInitializationPromiseRef.current === initialization) workspaceInitializationPromiseRef.current = null
    })
    return () => { current = false; clearTimeout(stalledTimer) }
  }, [status, user?.id, workspaceRetry])

  function requestSync(ownerId: string, trigger: 'automatic' | 'manual'): Promise<void> {
    if (cloudRecoveryModeRef.current || isTrackerRecoveryInspectionMode() || deletionOwnerRef.current === ownerId || hasDeletionLock(ownerId)) return Promise.resolve()
    const active = syncPromisesRef.current.get(ownerId)
    if (active) return active

    const recoveryTransition = cloudRecoveryTransitionRef.current
    const promise = Promise.resolve().then(async () => {
      if (cloudRecoveryModeRef.current || authUserIdRef.current !== ownerId || !workspaceReadyRef.current || deletionOwnerRef.current === ownerId || hasDeletionLock(ownerId)) return
      attemptedMutationVersionRef.current.set(ownerId, mutationVersionRef.current.get(ownerId) ?? 0)
      setSyncStatus('syncing')
      setSyncTrigger(trigger)
      setSyncError(null)
      try {
        const result = await synchronizeWorkspace(ownerId)
        if (authUserIdRef.current !== ownerId || cloudRecoveryModeRef.current || recoveryTransition !== cloudRecoveryTransitionRef.current) return
        setSyncSummary(result)
        setSyncStatus(result.failed > 0 ? 'error' : 'complete')
        if (result.failed > 0) setSyncError('Some changes remain on this device. Check your connection and retry.')
      } catch (cause) {
        if (authUserIdRef.current !== ownerId || cloudRecoveryModeRef.current || recoveryTransition !== cloudRecoveryTransitionRef.current) return
        setSyncError(syncFailureMessage(classifySyncFailure(cause)))
        setSyncStatus('error')
      }
    }).finally(() => {
      if (syncPromisesRef.current.get(ownerId) === promise) syncPromisesRef.current.delete(ownerId)
    })
    syncPromisesRef.current.set(ownerId, promise)
    return promise
  }
  requestSyncRef.current = requestSync

  useEffect(() => {
    const unsubscribe = subscribeToWorkspaceMutations((ownerId) => {
      if (!ownerId) return
      mutationVersionRef.current.set(ownerId, (mutationVersionRef.current.get(ownerId) ?? 0) + 1)
      const existingTimer = mutationTimersRef.current.get(ownerId)
      if (existingTimer) clearTimeout(existingTimer)
      const timer = setTimeout(() => {
        mutationTimersRef.current.delete(ownerId)
        void (async () => {
          if (authUserIdRef.current !== ownerId || !workspaceReadyRef.current || !isOnlineRef.current || hasDeletionLock(ownerId)) return
          const active = syncPromisesRef.current.get(ownerId)
          if (active) await active
          if (authUserIdRef.current !== ownerId || !workspaceReadyRef.current || !isOnlineRef.current || hasDeletionLock(ownerId)) return
          const changedVersion = mutationVersionRef.current.get(ownerId) ?? 0
          const attemptedVersion = attemptedMutationVersionRef.current.get(ownerId) ?? 0
          if (changedVersion > attemptedVersion) await requestSyncRef.current(ownerId, 'automatic')
        })()
      }, 500)
      mutationTimersRef.current.set(ownerId, timer)
    })
    return () => {
      unsubscribe()
      for (const timer of mutationTimersRef.current.values()) clearTimeout(timer)
      mutationTimersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (isTrackerRecoveryInspectionMode()) {
      setSyncStatus('idle')
      setSyncTrigger(null)
      setSyncError(null)
      return
    }
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
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        try {
          await withPushOwnershipLock(async () => {
            const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
            if (registration) {
              const subscription = await registration.pushManager?.getSubscription()
              if (subscription && user?.id) await queuePushCleanup(user.id, subscription.endpoint)
              await revokePushBeforeSignOut(registration, (action, value) => managePushSubscriptionWithSupabase(client, action, value))
              if (user?.id) await clearPushCleanup(user.id)
              setStoredPushOwner(null)
              setWorkerPushOwner(registration, null)
            }
          })
        } catch (cause) {
          setPushOwnershipStatus('cleanup-required')
          setPushOwnershipMessage(cause instanceof Error ? cause.message : 'Device cleanup is pending. Registration will remain blocked.')
        }
      }
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

  function enterCloudRecovery(): Promise<void> {
    if (cloudRecoveryEntryPromiseRef.current) return cloudRecoveryEntryPromiseRef.current
    const transition = ++cloudRecoveryTransitionRef.current
    const ownerId = user?.id ?? null
    cloudRecoveryModeRef.current = true
    setCloudRecoveryPending(true)
    const activeSync = ownerId ? syncPromisesRef.current.get(ownerId) : undefined
    const activePushTransition = pushOwnershipStatus === 'pending' ? pushTransitionChainRef.current : undefined
    const activeInitialization = workspaceInitializationPromiseRef.current
    const operations = [activeSync, activePushTransition, activeInitialization].filter(Boolean) as Promise<void>[]
    const settled = Promise.allSettled(operations)
    setCloudRecoveryOperationsPending(operations.length > 0)
    setCloudRecoveryPriorOperationsSettled(false)
    const entryPromise = new Promise<void>((resolve) => {
      let finished = false
      const finish = (allSettled: boolean) => {
        if (finished) return
        finished = true
        if (recoveryWaitTimerRef.current) clearTimeout(recoveryWaitTimerRef.current)
        recoveryWaitTimerRef.current = null
        recoveryWaitCancelRef.current = null
        if (transition === cloudRecoveryTransitionRef.current && authUserIdRef.current === ownerId) {
          setCloudRecoveryMode(true)
          setCloudRecoveryPending(false)
          setCloudRecoveryOperationsPending(!allSettled)
          setCloudRecoveryPriorOperationsSettled(operations.length > 0 && allSettled)
          if (!allSettled) void settled.then(() => {
            if (transition === cloudRecoveryTransitionRef.current && authUserIdRef.current === ownerId) {
              setCloudRecoveryOperationsPending(false)
              setCloudRecoveryPriorOperationsSettled(true)
            }
          })
        }
        resolve()
      }
      if (operations.length === 0) { finish(true); return }
      void settled.then(() => finish(true))
      recoveryWaitTimerRef.current = setTimeout(() => finish(false), recoveryOperationWaitMs)
      recoveryWaitCancelRef.current = () => finish(false)
    })
    cloudRecoveryEntryPromiseRef.current = entryPromise
    void entryPromise.finally(() => { if (cloudRecoveryEntryPromiseRef.current === entryPromise) cloudRecoveryEntryPromiseRef.current = null })
    return entryPromise
  }
  function retryWorkspace() {
    if (cloudRecoveryOperationsPending || workspaceInitializationPendingRef.current || (user?.id && syncPromisesRef.current.has(user.id))) return
    cloudRecoveryTransitionRef.current += 1
    recoveryWaitCancelRef.current?.()
    cloudRecoveryModeRef.current = false
    setCloudRecoveryMode(false)
    setCloudRecoveryPending(false)
    setCloudRecoveryOperationsPending(false)
    setCloudRecoveryPriorOperationsSettled(false)
    setWorkspaceRetry((attempt) => attempt + 1)
  }

  async function syncNow() {
    const ownerId = user?.id
    if (!ownerId || status !== 'signed-in' || workspaceStatus !== 'ready' || workspaceUserId !== ownerId) {
      setSyncError('Open this account’s local workspace before syncing.')
      setSyncStatus('error')
      return
    }
    if (deletionOwnerRef.current === ownerId || hasDeletionLock(ownerId)) {
      setSyncError('Account deletion is in progress in another tab. Sync is paused until its result is confirmed.')
      setSyncStatus('waiting')
      return
    }
    await requestSync(ownerId, 'manual')
  }

  async function prepareAccountDeletion(ownerId: string): Promise<number> {
    if (status !== 'signed-in' || user?.id !== ownerId || workspaceStatus !== 'ready' || workspaceUserId !== ownerId) {
      throw new Error('Your signed-in account workspace is not ready for deletion.')
    }
    deletionOwnerRef.current = ownerId
    setDeletionLock(ownerId, true)
    const timer = mutationTimersRef.current.get(ownerId)
    if (timer) clearTimeout(timer)
    mutationTimersRef.current.delete(ownerId)
    await syncPromisesRef.current.get(ownerId)
    if (authUserIdRef.current !== ownerId) throw new Error('The signed-in account changed. Reopen Settings and try again.')
    return countPendingWorkspaceSyncOperations(ownerId)
  }

  function resumeAccountSyncAfterDeletionFailure(ownerId: string) {
    if (deletionOwnerRef.current === ownerId) deletionOwnerRef.current = null
    setDeletionLock(ownerId, false)
  }

  async function finishAccountDeletion(ownerId: string): Promise<string | null> {
    if (deletionOwnerRef.current !== ownerId || authUserIdRef.current !== ownerId) return 'The active account changed before local cleanup. Sign out and reopen the app.'
    let cleanupError: string | null = null
    try { await clearDeletedAccountWorkspace(ownerId) }
    catch (cause) { cleanupError = cause instanceof Error ? cause.message : 'Local account data could not be cleared.' }
    const client = getSupabaseClient()
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
        await registration?.pushManager?.getSubscription().then((subscription) => subscription?.unsubscribe())
        setWorkerPushOwner(registration ?? null, null)
        await clearPushCleanup(ownerId)
      } catch { /* Auth account deletion cascades its server-side subscription rows. */ }
    }
    if (getStoredPushOwner() === ownerId) setStoredPushOwner(null)
    if (client) {
      try {
        const { error } = await client.auth.signOut({ scope: 'local' })
        if (error) cleanupError ??= `The account is deleted, but this device could not clear its saved sign-in: ${error.message}`
      } catch (cause) {
        cleanupError ??= `The account is deleted, but this device could not clear its saved sign-in: ${cause instanceof Error ? cause.message : 'unknown error'}`
      }
    }
    deletionOwnerRef.current = null
    setDeletionLock(ownerId, false)
    setUser(null)
    setStatus('signed-out')
    setAccountDeletionNotice(cleanupError ? `Your account was deleted. ${cleanupError}` : 'Your account and its cloud data were deleted. This device is now using guest mode.')
    setPasswordRecovery(false)
    setSessionTransitionPending(false)
    return null
  }

  return <AuthContext.Provider value={{ status, user, passwordRecovery, completePasswordRecovery, workspaceStatus, workspaceUserId, sessionTransitionPending, pushOwnershipStatus, pushOwnershipMessage, guestSummary, workspaceError, workspaceDiagnostic, chooseGuestData, retryWorkspace, cloudRecoveryMode, cloudRecoveryPending, cloudRecoveryOperationsPending, cloudRecoveryPriorOperationsSettled, workspaceInitializationStalled, workspaceInitializationPending, enterCloudRecovery, syncStatus, syncTrigger, isOnline, syncSummary, syncError, syncNow, signOut, accountDeletionNotice, prepareAccountDeletion, resumeAccountSyncAfterDeletionFailure, finishAccountDeletion }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used within AuthProvider.')
  return value
}
