/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  /** Opt in to schema v3 plan writes only after the hosted migration is verified. */
  readonly VITE_ENABLE_TRACKER_SCHEMA_V3?: string
  /** Enable schema v4 numeric precision writes after the hosted migration is verified. */
  readonly VITE_ENABLE_TRACKER_SCHEMA_V4?: string
  /** Enable schema v6 unified scheduling writes after the hosted migration is verified. */
  readonly VITE_ENABLE_TRACKER_SCHEMA_V6?: string
  /** Enable explicit Effective Days counting writes after the v7 migration is verified. */
  readonly VITE_ENABLE_TRACKER_SCHEMA_V7?: string
  /** Enable explicit streak-rule writes after the v8 migration and prerequisites are verified. */
  readonly VITE_ENABLE_TRACKER_SCHEMA_V8?: string
  /** Enable typed milestone writes after the v9 migration and downgrade guard are verified. */
  readonly VITE_ENABLE_TRACKER_SCHEMA_V9?: string
  readonly VITE_ENABLE_TRACKER_SCHEMA_V10?: string
  readonly VITE_ENABLE_PERMANENT_DELETION?: string
  readonly VITE_ENABLE_AUTOMATIC_BIN_CLEANUP?: string
  readonly VITE_ENABLE_HOLIDAY_PERMANENT_DELETION?: string
  readonly VITE_ENABLE_PROGRESSION_UI?: string
  readonly VITE_TRACKER_LIFECYCLE_STRESS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
