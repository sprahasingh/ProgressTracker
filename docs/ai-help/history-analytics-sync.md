# Check-ins, History, Analytics, and sync

Recorded check-ins retain values by stable measure ID. History displays a measure's saved name, unit, and type, including retired measures. Analytics calculates observations for each measure separately so different units are never combined. A newer revision for a date supersedes the older revision; tombstoned entries are excluded from current check-in and trend calculations.

Local tracker edits and account sync are separate concerns. Signed-in changes enter a revisioned sync queue; the sync engine detects incompatible remote measure changes and retains a conflict for resolution. The assistant does not inspect personal records and cannot edit trackers.

Source references: `src/features/history/HistoryPage.tsx`, `src/domain/trackers/analytics.ts`, `src/services/supabase/syncEngine.ts`, `src/db/localRepository.ts`, `src/db/database.ts`.
