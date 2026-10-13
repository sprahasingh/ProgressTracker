/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  /** Opt in to schema v3 plan writes only after the hosted migration is verified. */
  readonly VITE_ENABLE_TRACKER_SCHEMA_V3?: string
  /** Enable schema v4 numeric precision writes after the hosted migration is verified. */
  readonly VITE_ENABLE_TRACKER_SCHEMA_V4?: string
  readonly VITE_ENABLE_PERMANENT_DELETION?: string
  readonly VITE_ENABLE_AUTOMATIC_BIN_CLEANUP?: string
  readonly VITE_ENABLE_HOLIDAY_PERMANENT_DELETION?: string
  readonly VITE_ENABLE_PROGRESSION_UI?: string
  readonly VITE_TRACKER_LIFECYCLE_STRESS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
