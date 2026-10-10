import { describe, expect, it, vi } from 'vitest'
import workerSource from '../../../public/sw.js?raw'

function loadWorker(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: never) => void>()
  const workerScope = {
    location: new URL('https://sprahasingh.github.io/ProgressTracker/sw.js'),
    addEventListener: (type: string, handler: (event: never) => void) => handlers.set(type, handler),
    clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn() },
    registration: { showNotification: vi.fn().mockResolvedValue(undefined), getNotifications: vi.fn().mockResolvedValue([]) },
    ...overrides,
  }
  const runWorker = new Function('self', 'URL', 'Response', 'crypto', 'caches', 'fetch', 'indexedDB', workerSource)
  runWorker(workerScope, URL, Response, { randomUUID: () => 'change-1' }, {}, vi.fn(), indexedDB)
  return { handlers, self: workerScope }
}

describe('service worker Web Push behavior', () => {
  it('displays push notifications with a stable de-duplication tag', async () => {
    const { handlers, self } = await loadWorker()
    let work: Promise<unknown> | undefined
    handlers.get('push')!({ data: { json: () => ({ title: 'Reminder', body: 'Check in', tag: 'daily:today', url: 'https://sprahasingh.github.io/ProgressTracker/#/today' }) }, waitUntil: (promise: Promise<unknown>) => { work = promise } } as never)
    await work
    expect(self.registration.getNotifications).toHaveBeenCalledWith({ tag: 'daily:today' })
    expect(self.registration.showNotification).toHaveBeenCalledWith('Reminder', expect.objectContaining({ tag: 'daily:today', renotify: false }))
    expect(self.registration.showNotification.mock.calls[0]?.[1].data.url).toBe('https://sprahasingh.github.io/ProgressTracker/#/today')
  })

  it('focuses an app window but rejects an external notification redirect', async () => {
    const windowClient = { url: 'https://sprahasingh.github.io/ProgressTracker/#/today', focus: vi.fn(), navigate: vi.fn() }
    windowClient.focus.mockResolvedValue(windowClient)
    const clients = { matchAll: vi.fn().mockResolvedValue([windowClient]), openWindow: vi.fn() }
    const { handlers } = await loadWorker({ clients })
    let work: Promise<unknown> | undefined
    handlers.get('notificationclick')!({ notification: { data: { url: 'https://evil.example/phish' }, close: vi.fn() }, waitUntil: (promise: Promise<unknown>) => { work = promise } } as never)
    await work
    expect(windowClient.focus).toHaveBeenCalledOnce()
    expect(windowClient.navigate).toHaveBeenCalledWith('https://sprahasingh.github.io/ProgressTracker/')
  })

  it('broadcasts subscription changes to open clients without accessing account credentials', async () => {
    const windowClient = { postMessage: vi.fn() }
    const clients = { matchAll: vi.fn().mockResolvedValue([windowClient]), openWindow: vi.fn() }
    const { handlers } = await loadWorker({ clients })
    let ownerWork: Promise<unknown> | undefined
    handlers.get('message')!({ data: { type: 'PROGRESS_TRACKER_SET_PUSH_OWNER', ownerId: 'account-a' }, waitUntil: (promise: Promise<unknown>) => { ownerWork = promise } } as never)
    await ownerWork
    let work: Promise<unknown> | undefined
    handlers.get('pushsubscriptionchange')!({ oldSubscription: { endpoint: 'https://push.example.test/old' }, newSubscription: null, waitUntil: (promise: Promise<unknown>) => { work = promise } } as never)
    await work
    expect(windowClient.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'PROGRESS_TRACKER_PUSH_SUBSCRIPTION_CHANGED', changeId: 'change-1', ownerUserId: 'account-a', oldEndpoint: 'https://push.example.test/old' }))

    const source = { postMessage: vi.fn() }
    let pendingWork: Promise<unknown> | undefined
    handlers.get('message')!({ data: { type: 'PROGRESS_TRACKER_GET_PUSH_SUBSCRIPTION_CHANGES' }, source, waitUntil: (promise: Promise<unknown>) => { pendingWork = promise } } as never)
    await pendingWork
    expect(source.postMessage).toHaveBeenCalledWith({ type: 'PROGRESS_TRACKER_PENDING_PUSH_SUBSCRIPTION_CHANGE', changes: [expect.objectContaining({ id: 'change-1', ownerUserId: 'account-a', oldEndpoint: 'https://push.example.test/old', newSubscription: null })] })

    let ackWork: Promise<unknown> | undefined
    handlers.get('message')!({ data: { type: 'PROGRESS_TRACKER_ACK_PUSH_SUBSCRIPTION_CHANGE', changeId: 'change-1' }, waitUntil: (promise: Promise<unknown>) => { ackWork = promise } } as never)
    await ackWork
  })

  it('opens the correct GitHub Pages base path when no app window is open', async () => {
    const clients = { matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn().mockResolvedValue(undefined) }
    const { handlers } = loadWorker({ clients })
    let work: Promise<unknown> | undefined
    handlers.get('notificationclick')!({ notification: { data: { url: 'https://sprahasingh.github.io/ProgressTracker/#/today?date=2026-10-10' }, close: vi.fn() }, waitUntil: (promise: Promise<unknown>) => { work = promise } } as never)
    await work
    expect(clients.openWindow).toHaveBeenCalledWith('https://sprahasingh.github.io/ProgressTracker/#/today?date=2026-10-10')
  })
})
