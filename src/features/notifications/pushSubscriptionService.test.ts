import { describe, expect, it, vi } from 'vitest'
import { registerCurrentPushSubscription, revokeCurrentPushSubscription, type ManagePushSubscription, withPushOwnershipLock } from './pushSubscriptionService'

function subscription(overrides: Partial<PushSubscription> = {}) {
  return {
    endpoint: 'https://push.example.test/device',
    expirationTime: null,
    toJSON: () => ({ endpoint: 'https://push.example.test/device', expirationTime: null, keys: { p256dh: `BA${'A'.repeat(85)}`, auth: 'A'.repeat(22) } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as PushSubscription
}

function registration(current: PushSubscription | null, subscribeResult = subscription()): ServiceWorkerRegistration {
  return { pushManager: { getSubscription: vi.fn().mockResolvedValue(current), subscribe: vi.fn().mockResolvedValue(subscribeResult) } } as unknown as ServiceWorkerRegistration
}

const validKey = `BA${'A'.repeat(85)}`

describe('browser push subscription service', () => {
  it('reuses an existing subscription idempotently without creating another', async () => {
    const current = subscription()
    const worker = registration(current)
    const manage = vi.fn<ManagePushSubscription>().mockResolvedValue(undefined)
    await expect(registerCurrentPushSubscription(worker, validKey, manage)).resolves.toBe('registered')
    expect(worker.pushManager.subscribe).not.toHaveBeenCalled()
    expect(manage).toHaveBeenCalledWith('register', expect.objectContaining({ endpoint: current.endpoint }))
  })

  it('creates a subscription only when explicitly requested and uses the public VAPID key', async () => {
    const worker = registration(null)
    const manage = vi.fn<ManagePushSubscription>().mockResolvedValue(undefined)
    await expect(registerCurrentPushSubscription(worker, validKey, manage)).resolves.toBe('registered')
    expect(worker.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }))
    expect(manage).toHaveBeenCalledWith('register', expect.objectContaining({ endpoint: 'https://push.example.test/device' }))
  })

  it('does not create a subscription during passive refresh when none exists', async () => {
    const worker = registration(null)
    const manage = vi.fn<ManagePushSubscription>().mockResolvedValue(undefined)
    await expect(registerCurrentPushSubscription(worker, validKey, manage, false)).resolves.toBe('not-subscribed')
    expect(worker.pushManager.subscribe).not.toHaveBeenCalled()
    expect(manage).not.toHaveBeenCalled()
  })

  it('revokes an expired endpoint and renews only on an explicit registration action', async () => {
    const expired = subscription({ expirationTime: 100 })
    const worker = registration(expired)
    const manage = vi.fn<ManagePushSubscription>().mockResolvedValue(undefined)
    await expect(registerCurrentPushSubscription(worker, validKey, manage, true, 101)).resolves.toBe('registered')
    expect(manage).toHaveBeenNthCalledWith(1, 'revoke', { endpoint: expired.endpoint })
    expect(expired.unsubscribe).toHaveBeenCalledOnce()
    expect(worker.pushManager.subscribe).toHaveBeenCalledOnce()
  })

  it('keeps the browser subscription if server revocation fails', async () => {
    const current = subscription()
    const worker = registration(current)
    const manage = vi.fn<ManagePushSubscription>().mockRejectedValue(new Error('offline'))
    await expect(revokeCurrentPushSubscription(worker, manage)).rejects.toThrow('offline')
    expect(current.unsubscribe).not.toHaveBeenCalled()
  })

  it('supports idempotent revocation when there is no current subscription', async () => {
    const manage = vi.fn<ManagePushSubscription>()
    await expect(revokeCurrentPushSubscription(registration(null), manage)).resolves.toBe(false)
    expect(manage).not.toHaveBeenCalled()
  })

  it('serializes a registration already in flight before an identity-change revocation', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() } })
    let finishRegistration!: () => void
    const order: string[] = []
    const registering = withPushOwnershipLock(async () => {
      order.push('register-start')
      await new Promise<void>((resolve) => { finishRegistration = resolve })
      order.push('register-finish')
    })
    const cleanup = withPushOwnershipLock(async () => { order.push('revoke') })
    await Promise.resolve()
    expect(order).toEqual(['register-start'])
    finishRegistration()
    await Promise.all([registering, cleanup])
    expect(order).toEqual(['register-start', 'register-finish', 'revoke'])
    Reflect.deleteProperty(navigator, 'locks')
  })

  it('fails closed when cross-tab locking is unavailable', async () => {
    Reflect.deleteProperty(navigator, 'locks')
    await expect(withPushOwnershipLock(async () => 'unsafe')).rejects.toThrow(/cannot safely coordinate device subscriptions across tabs/)
  })
})
