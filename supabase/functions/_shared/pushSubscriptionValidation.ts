export type SerializedPushSubscription = {
  endpoint: string
  expirationTime: number | null
  keys: { p256dh: string; auth: string }
}

export function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512) return null
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

export function decodeVapidPublicKey(value: string): Uint8Array | null {
  const key = decodeBase64Url(value)
  return key?.length === 65 && key[0] === 4 ? key : null
}

export function validatePushEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 9 || value.length > 2048) return null
  try {
    const endpoint = new URL(value)
    if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash) return null
    return endpoint.href
  } catch {
    return null
  }
}

export function validatePushSubscription(value: unknown, now = Date.now()): SerializedPushSubscription | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  if (Object.keys(payload).some((key) => !['endpoint', 'expirationTime', 'keys'].includes(key))) return null
  const endpoint = validatePushEndpoint(payload.endpoint)
  if (!endpoint) return null
  if (typeof payload.keys !== 'object' || payload.keys === null || Array.isArray(payload.keys)) return null
  const keys = payload.keys as Record<string, unknown>
  if (Object.keys(keys).some((key) => !['p256dh', 'auth'].includes(key))) return null
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null
  const p256dh = decodeBase64Url(keys.p256dh)
  const auth = decodeBase64Url(keys.auth)
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4 || !auth || auth.length !== 16) return null
  let expirationTime: number | null = null
  if (payload.expirationTime !== null && payload.expirationTime !== undefined) {
    if (typeof payload.expirationTime !== 'number' || !Number.isFinite(payload.expirationTime) || payload.expirationTime <= now) return null
    expirationTime = payload.expirationTime
  }
  return { endpoint, expirationTime, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}
