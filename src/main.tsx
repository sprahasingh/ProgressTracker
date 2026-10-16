import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './routes/router'
import { AuthProvider } from './features/auth/AuthProvider'
import './styles.css'

let offlineRoutePriming: Promise<void> | null = null

async function primeOfflineRouteModules() {
  if (!import.meta.env.PROD || !navigator.onLine || !('serviceWorker' in navigator)) return
  if (offlineRoutePriming) return offlineRoutePriming

  offlineRoutePriming = (async () => {
    try {
      await navigator.serviceWorker.ready
      const response = await fetch(`${import.meta.env.BASE_URL}offline-assets.json`)
      if (!response.ok) throw new Error(`Offline manifest returned ${response.status}`)
      const manifest: unknown = await response.json()
      if (!manifest || typeof manifest !== 'object' || !('routeModules' in manifest) || !Array.isArray(manifest.routeModules)) {
        throw new Error('Offline route manifest is invalid')
      }

      const moduleUrls = manifest.routeModules.filter((path): path is string =>
        typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..'),
      ).map((path) => new URL(path, new URL(import.meta.env.BASE_URL, location.origin)).href)

      const preload = (href: string) => new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLLinkElement>(`link[rel="modulepreload"][href="${CSS.escape(href)}"]`)
        if (existing?.dataset.offlinePreloadStatus === 'loaded') return resolve()
        if (existing?.dataset.offlinePreloadStatus === 'failed') return reject(new Error(`Could not preload ${href}`))
        if (existing) {
          existing.addEventListener('load', () => resolve(), { once: true })
          existing.addEventListener('error', () => reject(new Error(`Could not preload ${href}`)), { once: true })
          return
        }
          const link = document.createElement('link')
          link.rel = 'modulepreload'
          link.href = href
          link.dataset.offlineRouteModule = 'true'
          const timeout = window.setTimeout(() => reject(new Error(`Timed out preloading ${href}`)), 15000)
          link.onload = () => { window.clearTimeout(timeout); link.dataset.offlinePreloadStatus = 'loaded'; resolve() }
          link.onerror = () => { window.clearTimeout(timeout); link.dataset.offlinePreloadStatus = 'failed'; reject(new Error(`Could not preload ${href}`)) }
          document.head.append(link)
      })

      await Promise.all(moduleUrls.map(preload))
      document.documentElement.dataset.offlineRoutesReady = 'true'
    } catch (error) {
      document.documentElement.dataset.offlineRoutesReady = 'failed'
      console.warn('ProgressTracker offline routes could not be fully prepared.', error)
      offlineRoutePriming = null
    }
  })()
  return offlineRoutePriming
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then(() => primeOfflineRouteModules())
      .catch((error: unknown) => console.warn('ProgressTracker offline support could not be started.', error))
  })
  window.addEventListener('online', () => { void primeOfflineRouteModules() })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider><RouterProvider router={router} /></AuthProvider>
  </React.StrictMode>,
)
