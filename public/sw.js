const CACHE_PREFIX = 'progress-tracker-shell-'
const CACHE_NAME = `${CACHE_PREFIX}v1`
const APP_ROOT = new URL('./', self.location.href)
const SHELL_URL = APP_ROOT.href

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
