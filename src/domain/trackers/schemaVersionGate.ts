/** Production schema-v3 writes remain off until the hosted migration is verified. */
export function isSchemaV3WriteEnabled(): boolean {
  return !import.meta.env.PROD || import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V3 === 'true'
}

/** Permanent deletion stays disabled in production until migration and cron are verified. */
export function isPermanentDeletionEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_PERMANENT_DELETION === 'true'
}
