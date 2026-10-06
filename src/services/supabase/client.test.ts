import { describe, expect, it } from 'vitest'
import { readSupabaseConfiguration } from './client'

describe('Supabase browser configuration', () => {
  it('allows the app to remain in local mode when credentials are absent', () => {
    expect(readSupabaseConfiguration({})).toEqual({ status: 'missing' })
  })

  it('accepts a project URL and publishable key', () => {
    expect(readSupabaseConfiguration({
      url: 'https://example.supabase.co',
      publishableKey: 'sb_publishable_example',
    })).toEqual({
      status: 'ready',
      url: 'https://example.supabase.co',
      publishableKey: 'sb_publishable_example',
    })
  })

  it('rejects secret or legacy keys in browser configuration', () => {
    expect(readSupabaseConfiguration({
      url: 'https://example.supabase.co',
      publishableKey: 'sb_secret_do_not_expose',
    })).toMatchObject({ status: 'invalid' })
    expect(readSupabaseConfiguration({
      url: 'https://example.supabase.co',
      publishableKey: 'eyJhbGciOiJIUzI1NiJ9.legacy-anon-key',
    })).toMatchObject({ status: 'invalid' })
  })

  it('rejects malformed project URLs', () => {
    expect(readSupabaseConfiguration({
      url: 'not-a-url',
      publishableKey: 'sb_publishable_example',
    })).toMatchObject({ status: 'invalid' })
  })

  it('allows HTTP only for local Supabase development', () => {
    expect(readSupabaseConfiguration({
      url: 'http://127.0.0.1:54321',
      publishableKey: 'sb_publishable_example',
    })).toMatchObject({ status: 'ready' })
    expect(readSupabaseConfiguration({
      url: 'http://example.supabase.co',
      publishableKey: 'sb_publishable_example',
    })).toMatchObject({ status: 'invalid' })
  })
})
