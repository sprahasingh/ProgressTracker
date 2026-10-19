/** Production schema-v3 writes remain off until the hosted migration is verified. */
export function isSchemaV3WriteEnabled(): boolean {
  return !import.meta.env.PROD || import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V3 === 'true'
}

/** Precision-aware v4 records stay read-only in production until the v4 migration is verified. */
export function isSchemaV4WriteEnabled(): boolean {
  return !import.meta.env.PROD || import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V4 === 'true'
}

/** Manual-only goal allocations stay read-only until the schema v5 migration is verified. */
export function isSchemaV5WriteEnabled(): boolean {
  return !import.meta.env.PROD || import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V5 === 'true'
}

/** Unified scheduling v6 is disabled in production until the hosted constraint migration is verified. */
export function isSchemaV6WriteEnabled(): boolean {
  return !import.meta.env.PROD || import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V6 === 'true'
}

export function isSchemaV7WriteEnabled(): boolean {
  return !import.meta.env.PROD || import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V7 === 'true'
}

/** Separate streak-rule writes require the v8 migration and all prerequisite v7 semantics. */
export function isSchemaV8WriteEnabled(): boolean {
  return !import.meta.env.PROD || (import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V8 === 'true' && isSchemaV7WriteEnabled())
}

/** Typed milestone definitions require the v9 server constraint and downgrade guard. */
export function isSchemaV9WriteEnabled(): boolean {
  return !import.meta.env.PROD || (import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V9 === 'true' && isSchemaV8WriteEnabled())
}

/** Versioned historical tracker rules require the v10 server validator and v9 prerequisites. */
export function isSchemaV10WriteEnabled(): boolean {
  return !import.meta.env.PROD || (import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V10 === 'true' && isSchemaV9WriteEnabled())
}

/** Three-option tracker edits also require the serialized boundary guard migration. */
export function isTrackerEditHistorySyncGuardEnabled(): boolean {
  return !import.meta.env.PROD || (import.meta.env.VITE_ENABLE_TRACKER_EDIT_SYNC_GUARDS === 'true' && isSchemaV10WriteEnabled())
}

export function isTrackerSchemaWriteEnabled(version: number): boolean {
  if (version >= 10) return isSchemaV10WriteEnabled()
  if (version >= 9) return isSchemaV9WriteEnabled()
  if (version >= 8) return isSchemaV8WriteEnabled()
  if (version >= 7) return isSchemaV7WriteEnabled()
  if (version >= 6) return isSchemaV6WriteEnabled()
  if (version >= 5) return isSchemaV5WriteEnabled()
  if (version >= 4) return isSchemaV4WriteEnabled()
  if (version === 3) return isSchemaV3WriteEnabled()
  return true
}

/** Permanent deletion stays disabled in production until migration and cron are verified. */
export function isPermanentDeletionEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_PERMANENT_DELETION === 'true'
}

/** Show automatic Bin cleanup claims only after the production schedule and DB control are verified. */
export function isAutomaticBinCleanupEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_AUTOMATIC_BIN_CLEANUP === 'true'
}

/** Holiday permanent deletion stays unavailable until its owner-scoped RPC and ledger migration is applied. */
export function isHolidayPermanentDeletionEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_HOLIDAY_PERMANENT_DELETION === 'true'
}

/** Progression presentation remains opt-in until a reviewed frontend release enables it. */
export function isProgressionUiEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_PROGRESSION_UI === 'true'
}
