const CACHE_PREFIX = 'progress-tracker-shell-'
const CACHE_NAME = `${CACHE_PREFIX}v1`
const APP_ROOT = new URL('./', self.location.href)
const SHELL_URL = APP_ROOT.href
const PUSH_CHANGE_DB = 'progress-tracker-push-subscription-changes'

function openPushChangeDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PUSH_CHANGE_DB, 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('changes')) request.result.createObjectStore('changes', { keyPath: 'id' })
      if (!request.result.objectStoreNames.contains('owner')) request.result.createObjectStore('owner', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function getPushOwner() {
  const database = await openPushChangeDb()
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('owner', 'readonly').objectStore('owner').get('current')
      request.onsuccess = () => resolve(request.result?.ownerId ?? null)
      request.onerror = () => reject(request.error)
    })
  } finally { database.close() }
}

async function setPushOwner(ownerId) {
  const database = await openPushChangeDb()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('owner', 'readwrite')
      const store = transaction.objectStore('owner')
      if (typeof ownerId === 'string' && ownerId) store.put({ id: 'current', ownerId })
      else store.delete('current')
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

async function storePushSubscriptionChange(change) {
  const database = await openPushChangeDb()
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('changes', 'readwrite')
    transaction.objectStore('changes').put(change)
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
}

async function getPendingPushSubscriptionChanges() {
  const database = await openPushChangeDb()
  const changes = await new Promise((resolve, reject) => {
    const request = database.transaction('changes', 'readonly').objectStore('changes').getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return changes
}

async function acknowledgePushSubscriptionChange(id) {
  const database = await openPushChangeDb()
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('changes', 'readwrite')
    transaction.objectStore('changes').delete(id)
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll([SHELL_URL, new URL('manifest.webmanifest', APP_ROOT).href, new URL('icons/progress-tracker.svg', APP_ROOT).href])
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(APP_ROOT.pathname)) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request)
      } catch {
        return (await caches.match(SHELL_URL)) || Response.error()
      }
    })())
    return
  }

  // Cache only build assets and public app metadata. API responses, auth data,
  // IndexedDB contents, and arbitrary same-origin requests are never cached.
  if (!/\.(?:js|css|svg|png|ico|webmanifest|woff2?)$/i.test(url.pathname)) return
  event.respondWith((async () => {
    const cached = await caches.match(request)
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE_NAME)
      await cache.put(request, response.clone())
    }
    return response
  })())
})

function safeNotificationPayload(value) {
  if (!value || typeof value !== 'object') return null
  const data = value
  const title = typeof data.title === 'string' ? data.title.slice(0, 120) : 'ProgressTracker'
  const body = typeof data.body === 'string' ? data.body.slice(0, 500) : ''
  const rawUrl = typeof data.url === 'string' ? data.url : SHELL_URL
  let url
  try { url = new URL(rawUrl, SHELL_URL) } catch { url = new URL(SHELL_URL) }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(APP_ROOT.pathname)) url = new URL(SHELL_URL)
  const tag = typeof data.tag === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(data.tag) ? data.tag : 'progress-tracker:general'
  return { title, body, url: url.href, tag }
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let input = {}
    try { input = event.data?.json() ?? {} } catch { input = { body: event.data?.text() ?? '' } }
    const payload = safeNotificationPayload(input)
    if (!payload) return
    const existing = await self.registration.getNotifications({ tag: payload.tag })
    for (const notification of existing) notification.close()
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: new URL('icons/progress-tracker.svg', APP_ROOT).href,
      badge: new URL('icons/progress-tracker.svg', APP_ROOT).href,
      tag: payload.tag,
      renotify: false,
      data: { url: payload.url },
    })
  })())
})

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const change = {
      id: crypto.randomUUID(),
      ownerUserId: await getPushOwner().catch(() => null),
      oldEndpoint: event.oldSubscription?.endpoint ?? null,
      newSubscription: event.newSubscription?.toJSON() ?? null,
    }
    try { await storePushSubscriptionChange(change) } catch { /* The next app visit can still register its current subscription. */ }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const windowClient of windows) windowClient.postMessage({ type: 'PROGRESS_TRACKER_PUSH_SUBSCRIPTION_CHANGED', ...change, changeId: change.id })
  })())
})

self.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'PROGRESS_TRACKER_SET_PUSH_OWNER') {
    event.waitUntil(setPushOwner(message.ownerId).catch(() => undefined))
  } else if (message.type === 'PROGRESS_TRACKER_GET_PUSH_SUBSCRIPTION_CHANGES') {
    event.waitUntil((async () => {
      try {
        const changes = await getPendingPushSubscriptionChanges()
        event.source?.postMessage({ type: 'PROGRESS_TRACKER_PENDING_PUSH_SUBSCRIPTION_CHANGE', changes: changes.map((change) => ({ ...change, changeId: change.id })) })
      } catch { /* Push registration remains retryable from Notifications settings. */ }
    })())
  } else if (message.type === 'PROGRESS_TRACKER_ACK_PUSH_SUBSCRIPTION_CHANGE' && typeof message.changeId === 'string') {
    event.waitUntil(acknowledgePushSubscriptionChange(message.changeId).catch(() => undefined))
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    let destination = SHELL_URL
    try {
      const requested = new URL(event.notification.data?.url ?? SHELL_URL, SHELL_URL)
      if (requested.origin === self.location.origin && requested.pathname.startsWith(APP_ROOT.pathname)) destination = requested.href
    } catch { /* Fall back to the app root. */ }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const windowClient of windows) {
      const clientUrl = new URL(windowClient.url)
      if (clientUrl.origin !== self.location.origin || !clientUrl.pathname.startsWith(APP_ROOT.pathname)) continue
      const focused = await windowClient.focus()
      if (focused && 'navigate' in focused && focused.url !== destination) return focused.navigate(destination)
      return focused
    }
    return self.clients.openWindow(destination)
  })())
})
