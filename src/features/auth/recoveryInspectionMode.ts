/** The phone preview route suppresses normal workspace sync until inspection ends. */
export function isTrackerRecoveryInspectionMode(): boolean {
  if (typeof window === 'undefined') return false
  // Production uses createHashRouter and is hosted under /ProgressTracker/.
  // In that URL the route and its query live inside the fragment, for example
  // /ProgressTracker/#/settings?recoveryPreview=1#sync-data.
  const hashRoute = window.location.hash.slice(1).split('#', 1)[0]
  const routeUrl = hashRoute
    ? new URL(hashRoute, window.location.origin)
    : new URL(window.location.href)
  const path = routeUrl.pathname.replace(/\/+$/, '')
  return path.endsWith('/settings') && routeUrl.searchParams.get('recoveryPreview') === '1'
}
