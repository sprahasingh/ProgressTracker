import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from './client'
import type { TrackerDefinition } from '../../domain/trackers/types'
import { trackerUsesCombinedSum } from '../../domain/trackers/combinedSumRules'

export type CombinedSumCapabilityStatus = 'enabled' | 'disabled' | 'unknown'
export type CombinedSumCapability = { status: CombinedSumCapabilityStatus; checkedAt?: number; userId?: string; reason?: 'unauthenticated' | 'unavailable' | 'invalid-response' }

type CapabilityClient = Pick<SupabaseClient, 'auth'> & {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>
}
type CacheEntry = { project: string; userId: string; status: 'enabled' | 'disabled'; checkedAt: number; expiresAt: number }

const cacheTtlMs = 10 * 60_000

function parseCapability(value: unknown): boolean | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const response = value as { version?: unknown; capabilities?: unknown }
  if (response.version !== 1 || !response.capabilities || typeof response.capabilities !== 'object' || Array.isArray(response.capabilities)) return null
  const combinedSum = (response.capabilities as { combinedSum?: unknown }).combinedSum
  return typeof combinedSum === 'boolean' ? combinedSum : null
}

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export function createCombinedSumCapabilityStore(options: {
  clientProvider?: () => CapabilityClient | null
  projectProvider?: () => string
  now?: () => number
  isOnline?: () => boolean
  ttlMs?: number
} = {}) {
  const clientProvider = options.clientProvider ?? (() => getSupabaseClient() as CapabilityClient | null)
  const projectProvider = options.projectProvider ?? (() => {
    const client = clientProvider() as unknown as { supabaseUrl?: unknown } | null
    return typeof client?.supabaseUrl === 'string' ? client.supabaseUrl : ''
  })
  const now = options.now ?? Date.now
  const isOnline = options.isOnline ?? online
  const ttlMs = options.ttlMs ?? cacheTtlMs
  let cached: CacheEntry | null = null
  let inFlight: { scope: string; promise: Promise<CombinedSumCapability> } | null = null
  let generation = 0
  const listeners = new Set<(state: CombinedSumCapability) => void>()

  const publish = (state: CombinedSumCapability) => { for (const listener of listeners) listener(state) }
  let activeProject: string | undefined
  const currentProject = () => {
    const project = projectProvider()
    if (activeProject !== undefined && project !== activeProject) {
      activeProject = project
      generation += 1
      cached = null
      inFlight = null
      publish({ status: 'unknown' })
    } else activeProject ??= project
    return project
  }
  const currentState = (userId?: string | null): CombinedSumCapability => {
    const project = currentProject()
    if (!cached || cached.expiresAt <= now() || cached.project !== project || userId != null && cached.userId !== userId) return { status: 'unknown' }
    return { status: cached.status, checkedAt: cached.checkedAt, userId: cached.userId }
  }

  return {
    getCached(userId?: string | null): CombinedSumCapability { return currentState(userId) },
    subscribe(listener: (state: CombinedSumCapability) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    invalidate() {
      generation += 1
      cached = null
      inFlight = null
      publish({ status: 'unknown' })
    },
    invalidateForUser(userId: string | null) {
      if (cached && cached.userId !== userId) this.invalidate()
    },
    async refresh(force = false, clientOverride?: CapabilityClient, projectOverride?: string): Promise<CombinedSumCapability> {
      const requestStartGeneration = generation
      const client = clientOverride ?? clientProvider()
      if (!client) {
        this.invalidate()
        return { status: 'unknown', reason: 'unavailable' }
      }
      let session: { user: { id: string } } | null
      try {
        const result = await client.auth.getSession()
        if (result.error) throw result.error
        session = result.data.session as { user: { id: string } } | null
      } catch {
        this.invalidate()
        return { status: 'unknown', reason: 'unavailable' }
      }
      if (requestStartGeneration !== generation) return { status: 'unknown', reason: 'unavailable' }
      if (!session?.user?.id) {
        this.invalidate()
        return { status: 'unknown', reason: 'unauthenticated' }
      }
      const project = projectOverride ?? currentProject()
      const scope = `${project}\u0000${session.user.id}`
      const requestGeneration = generation
      const known = currentState(session.user.id)
      if (!isOnline()) return known
      if (!force && known.status !== 'unknown') return known
      if (inFlight?.scope === scope) return inFlight.promise
      const promise = (async (): Promise<CombinedSumCapability> => {
        try {
          const { data, error } = await client.rpc('progress_tracker_capabilities', {})
          if (requestGeneration !== generation || currentProject() !== project) return { status: 'unknown', reason: 'unavailable' }
          if (error) throw error
          const supported = parseCapability(data)
          if (supported === null) {
            this.invalidate()
            return { status: 'unknown', reason: 'invalid-response' }
          }
          const checkedAt = now()
          cached = { project, userId: session!.user.id, status: supported ? 'enabled' : 'disabled', checkedAt, expiresAt: checkedAt + ttlMs }
          const state = { status: cached.status, checkedAt, userId: cached.userId } as const
          publish(state)
          return state
        } catch {
          this.invalidate()
          return { status: 'unknown', reason: 'unavailable' }
        } finally {
          if (inFlight?.scope === scope && requestGeneration === generation) inFlight = null
        }
      })()
      inFlight = { scope, promise }
      return promise
    },
  }
}

const store = createCombinedSumCapabilityStore()
let authSubscriptionClient: CapabilityClient | null = null
let authSubscription: { unsubscribe: () => void } | null = null

function ensureAuthInvalidationListener(client: CapabilityClient | null) {
  if (!client || typeof client.auth.onAuthStateChange !== 'function' || authSubscriptionClient === client) return
  authSubscription?.unsubscribe()
  authSubscriptionClient = client
  const { data } = client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED' || event === 'PASSWORD_RECOVERY') store.invalidate()
    else if (!session) store.invalidate()
    else store.invalidateForUser(session.user.id)
  })
  authSubscription = data.subscription
}

export function getCombinedSumCapability(userId?: string | null): CombinedSumCapability {
  return store.getCached(userId)
}

export function subscribeToCombinedSumCapability(listener: (state: CombinedSumCapability) => void): () => void {
  return store.subscribe(listener)
}

export async function refreshCombinedSumCapability(force = false, clientOverride?: SupabaseClient): Promise<CombinedSumCapability> {
  const client = (clientOverride ?? getSupabaseClient()) as CapabilityClient | null
  ensureAuthInvalidationListener(client)
  return store.refresh(force, client ?? undefined)
}

export function assertCombinedSumCapability(tracker: Pick<TrackerDefinition, 'qualificationRule' | 'streakRule' | 'ruleVersions'>, userId?: string | null): void {
  if (!trackerUsesCombinedSum(tracker)) return
  const capability = userId ? store.getCached(userId) : { status: 'unknown' as const }
  if (capability.status !== 'enabled') {
    throw new Error(capability.status === 'disabled'
      ? 'Combined Sum is not supported by the signed-in ProgressTracker server. Your tracker was not changed.'
      : 'Combined Sum support could not be verified. Connect to the internet, retry availability, and save again. Your tracker was not changed.')
  }
}

export async function verifyCombinedSumCapabilityForSync(clientInput?: SupabaseClient): Promise<CombinedSumCapability> {
  if (!online()) return { status: 'unknown', reason: 'unavailable' }
  const client = (clientInput ?? getSupabaseClient()) as CapabilityClient | null
  ensureAuthInvalidationListener(client)
  return store.refresh(true, client ?? undefined)
}

export function resetCombinedSumCapabilityForTests(): void { store.invalidate() }
