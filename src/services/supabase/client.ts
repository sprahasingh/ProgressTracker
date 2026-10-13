import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type SupabaseEnvironment = {
  url?: string
  publishableKey?: string
}

export type SupabaseConfiguration =
  | { status: 'missing' }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; url: string; publishableKey: string }

function isLocalAnonymousJwt(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 3) return false
  try {
    const payloadPart = parts[1]
    if (!payloadPart) return false
    const payload = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))
    return JSON.parse(decoded).role === 'anon'
  } catch {
    return false
  }
}

export function readSupabaseConfiguration(environment: SupabaseEnvironment): SupabaseConfiguration {
  const url = environment.url?.trim()
  const publishableKey = environment.publishableKey?.trim()
  if (!url || !publishableKey) return { status: 'missing' }

  try {
    const parsedUrl = new URL(url)
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
    const isSecure = parsedUrl.protocol === 'https:'
    const isLocalDevelopment = parsedUrl.protocol === 'http:' && localHosts.has(parsedUrl.hostname)
    if (!isSecure && !isLocalDevelopment) {
      return { status: 'invalid', reason: 'The Supabase URL must use HTTPS (HTTP is allowed for local development).' }
    }
  } catch {
    return { status: 'invalid', reason: 'The Supabase URL is not a valid URL.' }
  }

  let localUrl = false
  try {
    const parsedUrl = new URL(url)
    localUrl = parsedUrl.protocol === 'http:' && new Set(['localhost', '127.0.0.1', '[::1]']).has(parsedUrl.hostname)
  } catch { /* URL validation above returns a useful configuration error. */ }
  if (!publishableKey.startsWith('sb_publishable_') && !(localUrl && isLocalAnonymousJwt(publishableKey))) {
    return { status: 'invalid', reason: 'Use the Supabase publishable key for browser code.' }
  }

  return { status: 'ready', url, publishableKey }
}

export const supabaseConfiguration = readSupabaseConfiguration({
  url: import.meta.env.VITE_SUPABASE_URL,
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
})

let client: SupabaseClient | null = null

/** Returns null until the project URL and publishable key are configured. */
export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseConfiguration.status !== 'ready') return null

  client ??= createClient(supabaseConfiguration.url, supabaseConfiguration.publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      persistSession: true,
    },
  })

  return client
}
