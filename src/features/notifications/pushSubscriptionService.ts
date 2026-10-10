import { decodeVapidPublicKey, type SerializedPushSubscription } from '../../../supabase/functions/_shared/pushSubscriptionValidation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseConfiguration } from '../../services/supabase/client'

export type PushSubscriptionAction = 'register' | 'revoke'
export type ManagePushSubscription = (action: PushSubscriptionAction, subscription: SerializedPushSubscription | { endpoint: string }) => Promise<void>

const PUSH_OWNER_KEY = 'progress-tracker:push-owner'
const PUSH_CLEANUP_DB = 'progress-tracker-push-ownership'
const PUSH_CLEANUP_STORE = 'pending-cleanups'
let pushOwnershipQueue: Promise<unknown> = Promise.resolve()

export function withPushOwnershipLock<T>(operation: () => Promise<T>): Promise<T> {
  const serializeInTab = () => {
    const result = pushOwnershipQueue.then(operation, operation)
    pushOwnershipQueue = result.then(() => undefined, () => undefined)
    return result
  }
  if (typeof navigator === 'undefined') return serializeInTab()
  if (!navigator.locks?.request) return Promise.reject(new Error('This browser cannot safely coordinate device subscriptions across tabs. Update the browser before registering this device.'))
  return new Promise<T>((resolve, reject) => {
    void navigator.locks.request('progress-tracker-push-ownership', { mode: 'exclusive' }, () => serializeInTab().then(resolve, reject)).catch(reject)
  })
}

export function getStoredPushOwner(): string | null {
  try { return localStorage.getItem(PUSH_OWNER_KEY) } catch { return null }
}

export function setStoredPushOwner(ownerId: string | null): void {
  try {
    if (ownerId) localStorage.setItem(PUSH_OWNER_KEY, ownerId)
    else localStorage.removeItem(PUSH_OWNER_KEY)
  } catch { /* The server remains authoritative; the UI will require explicit registration if storage is unavailable. */ }
}

export function setWorkerPushOwner(registration: ServiceWorkerRegistration | null, ownerId: string | null): void {
  registration?.active?.postMessage({ type: 'PROGRESS_TRACKER_SET_PUSH_OWNER', ownerId })
}

function openCleanupDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PUSH_CLEANUP_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(PUSH_CLEANUP_STORE, { keyPath: 'ownerId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function queuePushCleanup(ownerId: string, endpoint: string): Promise<void> {
  const database = await openCleanupDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PUSH_CLEANUP_STORE, 'readwrite')
      transaction.objectStore(PUSH_CLEANUP_STORE).put({ ownerId, endpoint })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

export async function getPendingPushCleanups(): Promise<Array<{ ownerId: string; endpoint: string }>> {
  const database = await openCleanupDb()
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(PUSH_CLEANUP_STORE, 'readonly').objectStore(PUSH_CLEANUP_STORE).getAll()
      request.onsuccess = () => resolve(request.result as Array<{ ownerId: string; endpoint: string }>)
      request.onerror = () => reject(request.error)
    })
  } finally { database.close() }
}

export async function clearPushCleanup(ownerId: string): Promise<void> {
  const database = await openCleanupDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PUSH_CLEANUP_STORE, 'readwrite')
      transaction.objectStore(PUSH_CLEANUP_STORE).delete(ownerId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

export async function managePushSubscriptionWithSupabase(
  client: SupabaseClient,
  action: PushSubscriptionAction,
  subscription: SerializedPushSubscription | { endpoint: string },
  bearerToken?: string,
): Promise<void> {
  if (bearerToken) {
    if (supabaseConfiguration.status !== 'ready') throw new Error('Account subscription management is not configured.')
    const response = await fetch(`${supabaseConfiguration.url}/functions/v1/manage-push-subscription`, {
      method: 'POST',
      headers: { apikey: supabaseConfiguration.publishableKey, authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, subscription }),
    })
    if (!response.ok) {
      let message = 'Device registration could not be completed.'
      try {
        const payload = await response.json() as { error?: unknown }
        if (typeof payload.error === 'string') message = payload.error
      } catch { /* Keep the safe generic error. */ }
      throw new Error(message)
    }
    return
  }
  const { error } = await client.functions.invoke('manage-push-subscription', { body: { action, subscription } })
  if (error) {
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      let message: string | null = null
      try {
        const payload = await context.clone().json() as { error?: unknown }
        if (typeof payload.error === 'string') message = payload.error
      } catch { /* Use the Supabase invocation error when the response is not JSON. */ }
      if (message) throw new Error(message)
    }
    throw new Error(error.message || 'Device registration could not be completed.')
  }
}

function serialize(subscription: PushSubscription): SerializedPushSubscription {
  const value = subscription.toJSON()
  const keys = value.keys
  if (!subscription.endpoint || !keys?.p256dh || !keys.auth) throw new Error('The browser returned an incomplete push subscription.')
  return { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime ?? null, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}

export async function registerCurrentPushSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string,
  manage: ManagePushSubscription,
  createIfMissing = true,
  now = Date.now(),
): Promise<'registered' | 'not-subscribed'> {
  const manager = registration.pushManager
  if (!manager) throw new Error('Push messaging is not supported by this browser.')
  let subscription = await manager.getSubscription()
  if (subscription?.expirationTime !== null && subscription?.expirationTime !== undefined && subscription.expirationTime <= now) {
    await manage('revoke', { endpoint: subscription.endpoint })
    await subscription.unsubscribe()
    subscription = null
    if (!createIfMissing) throw new Error('This subscription expired. Register this device again to renew it.')
  }
  if (!subscription && !createIfMissing) return 'not-subscribed'
  if (!subscription) {
    const decodedKey = decodeVapidPublicKey(publicKey)
    if (!decodedKey) throw new Error('The public push key is missing or invalid on this deployment.')
    const applicationServerKey = new Uint8Array(decodedKey)
    subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey })
  }
  await manage('register', serialize(subscription))
  return 'registered'
}

export async function revokeCurrentPushSubscription(registration: ServiceWorkerRegistration, manage: ManagePushSubscription): Promise<boolean> {
  const subscription = await registration.pushManager?.getSubscription()
  if (!subscription) return false
  await manage('revoke', { endpoint: subscription.endpoint })
  await subscription.unsubscribe()
  return true
}

export async function revokePushBeforeSignOut(registration: ServiceWorkerRegistration, manage: ManagePushSubscription): Promise<void> {
  const subscription = await registration.pushManager?.getSubscription()
  if (!subscription) return
  let serverError: unknown
  try { await manage('revoke', { endpoint: subscription.endpoint }) } catch (error) { serverError = error }
  await subscription.unsubscribe()
  if (serverError) throw serverError
}

export async function revokePushEndpoint(endpoint: string, manage: ManagePushSubscription): Promise<void> {
  await manage('revoke', { endpoint })
}
