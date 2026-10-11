# ProgressTracker product map

ProgressTracker is an offline-first personal tracker for habits, goals, challenges, and projects. The main routes are Today (`/`), Trackers (`/trackers`), Calendar (`/calendar`), History (`/history`), Analytics (`/analytics`), Goals (`/goals`), Dashboard (`/dashboard`), Holidays (`/holidays`), and Settings (`/settings`).

Tracker definitions and check-ins are stored locally in IndexedDB through the repository layer. A signed-in account can synchronize workspace records through Supabase. The assistant explains product behavior only; it does not read tracker definitions, check-ins, or workspace settings.

Source references: `src/routes/router.tsx`, `src/app/AppShell.tsx`, `src/db/localRepository.ts`, `src/services/supabase/syncEngine.ts`.
