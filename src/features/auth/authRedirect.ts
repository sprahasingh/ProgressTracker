/** Keep the app's hash route when Supabase returns from email/auth links. */
export function getAuthRedirectUrl(location: Pick<Location, 'origin' | 'pathname' | 'hash'>): string {
  return `${location.origin}${location.pathname}${location.hash || '#/'}`
}
