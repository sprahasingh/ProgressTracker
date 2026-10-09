/** Production schema-v3 writes remain off until the hosted migration is verified. */
export function isSchemaV3WriteEnabled(): boolean {
  return !import.meta.env.PROD || import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V3 === 'true'
}

/** Precision-aware v4 records stay read-only in production until the v4 migration is verified. */
export function isSchemaV4WriteEnabled(): boolean {
  return !import.meta.env.PROD || import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V4 === 'true'
}

export function isTrackerSchemaWriteEnabled(version: number): boolean {
  if (version >= 4) return isSchemaV4WriteEnabled()
  if (version === 3) return isSchemaV3WriteEnabled()
  return true
}

/** Permanent deletion stays disabled in production until migration and cron are verified. */
export function isPermanentDeletionEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_PERMANENT_DELETION === 'true'
}
