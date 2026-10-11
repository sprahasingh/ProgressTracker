# Schedules and streaks

A schedule determines which dates are expected check-in opportunities. Standard Mode counts scheduled, non-holiday opportunities. Strict Mode counts every active calendar day, including rest days and past holidays. An unlogged current date stays open rather than counting as missed. A check-in qualifies according to the tracker success rule; streak calculations use the same qualification model and respect the active date range.

Changing schedules affects future opportunity calculations, not saved check-in rows. Holidays are stored as date-only values in the workspace time zone.

Source references: `src/domain/trackers/planning.ts`, `src/domain/trackers/progression.ts`, `src/domain/trackers/activityStatus.ts`, `src/features/today/TodayPage.tsx`, `src/domain/holidays.ts`.
