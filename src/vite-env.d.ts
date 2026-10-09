/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  /** Opt in to schema v3 plan writes only after the hosted migration is verified. */
  readonly VITE_ENABLE_TRACKER_SCHEMA_V3?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
