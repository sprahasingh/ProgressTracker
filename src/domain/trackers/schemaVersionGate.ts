/** Production schema-v3 writes remain off until the hosted migration is verified. */
export function isSchemaV3WriteEnabled(): boolean {
  return !import.meta.env.PROD || import.meta.env.VITE_ENABLE_TRACKER_SCHEMA_V3 === 'true'
}
