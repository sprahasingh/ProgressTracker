export type NotificationCapabilities = {
  secureContext: boolean
  serviceWorker: boolean
  notificationApi: boolean
  pushApi: boolean
  standalone: boolean
  permission: NotificationPermission | 'unsupported'
  level: 'web-push-capable' | 'in-app-only' | 'disabled'
  reason: string
}

export function detectNotificationCapabilities(environment: {
  isSecureContext?: boolean
  serviceWorker?: unknown
  Notification?: { permission?: NotificationPermission }
  PushManager?: unknown
  standalone?: boolean
  displayModeStandalone?: boolean
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
} = globalThis as typeof globalThis & { standalone?: boolean }): NotificationCapabilities {
  const secureContext = environment.isSecureContext ?? false
  const serviceWorker = Boolean(environment.serviceWorker)
  const notificationApi = Boolean(environment.Notification)
  const pushApi = Boolean(environment.PushManager)
  const standalone = Boolean(environment.standalone || environment.displayModeStandalone)
  const ios = /iPhone|iPad|iPod/i.test(environment.userAgent ?? '') || ((environment.platform ?? '') === 'MacIntel' && (environment.maxTouchPoints ?? 0) > 1)
  const permission = environment.Notification?.permission ?? 'unsupported'
  const level = secureContext && serviceWorker && notificationApi && pushApi && permission !== 'denied' && !(ios && !standalone)
    ? 'web-push-capable' : notificationApi && permission !== 'denied' ? 'in-app-only' : 'disabled'
  const reason = !secureContext ? 'System notifications require a secure connection.'
    : permission === 'denied' ? 'Notifications are blocked in browser or device settings.'
        : ios && !standalone ? 'On iPhone and iPad, background Web Push requires adding the site to the Home Screen and opening the installed app.'
          : level === 'web-push-capable' ? 'This browser exposes the APIs needed for Web Push. Background delivery still requires server configuration.'
        : 'This browser can use in-app notifications, but does not expose all background push features.'
  return { secureContext, serviceWorker, notificationApi, pushApi, standalone, permission, level, reason }
}

export function notificationDeepLink(baseUrl: string, path: string, params: Record<string, string> = {}) {
  const url = new URL(baseUrl)
  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  const query = new URLSearchParams(params)
  url.pathname = basePath
  url.hash = `/${path.replace(/^\/+/, '')}${query.size ? `?${query}` : ''}`
  return url.toString()
}
