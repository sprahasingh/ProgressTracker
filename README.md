# ProgressTracker

A local-first personal productivity app for daily consistency, focused work, and measurable goals.

## Project status

The project foundation, reusable interface layer, IndexedDB schema, and local repositories are in place. A Supabase email-link sign-in screen and persisted browser session handling are implemented. Daily tracking UI and cloud synchronization are still planned steps.

## Tech stack

- React 19 and TypeScript with strict compiler checks
- Vite for development and production builds
- Tailwind CSS 4 for utility styling, with a small CSS layer for the initial visual system
- React Router using hash-based URLs for reliable navigation and refreshes on GitHub Pages
- React Hook Form and Zod for upcoming form workflows
- Supabase JavaScript client for optional account-based cloud integration
- Vitest, jsdom, and React Testing Library for upcoming domain and UI tests

## Application structure

- `src/app` contains the shared application shell.
- `src/routes` defines client-side navigation.
- `src/features` groups page-level work by product area.
- `src/components/ui` contains shared presentation primitives.
- `src/styles/tokens.css` defines color, type, and radius tokens used by the interface.
- `src/test` contains shared test setup.

Shared UI components should remain presentation-focused. Product rules belong in domain modules as those features are introduced. The design tokens include a dark palette hook (`data-theme="dark"`); appearance controls are not implemented yet.

## Local data foundation

Dexie wraps IndexedDB behind `src/db/localRepository.ts`; components should call repository methods rather than access object stores directly. The versioned database contains categories, per-category daily entries, daily journals, goals, goal metrics, append-only metric progress snapshots, settings, and a pending sync operation table. Calendar dates are stored as `YYYY-MM-DD` strings, separate from event timestamps.

Database schema version 2 upgrades version 1 records in place. It preserves record IDs and history, fills missing update timestamps from creation timestamps, and adds deletion tombstones without clearing site data. Daily entries have a unique category/date index to prevent duplicate logical records. Repository methods validate calendar dates and use date strings as the daily identity, separate from timestamps. Progress history stores each recorded value; it does not keep only a mutable current total. Sync execution is planned for a later step.

## Supabase configuration

The browser client is optional until configured. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. The publishable key is expected to be visible in a client bundle; database access must be protected by authenticated sessions and Row Level Security. Never place a Supabase secret key or legacy `service_role` key in Vite variables. Local IndexedDB use does not require Supabase configuration.

## Email authentication

ProgressTracker requests a passwordless email sign-in link through Supabase Auth. The callback uses PKCE and returns to the current app path, which is compatible with the GitHub Pages repository path and hash-based client routing. The Supabase JS client persists the session locally and refreshes it; logging in does not yet synchronize productivity records.

In **Authentication → URL Configuration**, set the Site URL to `https://sprahasingh.github.io/ProgressTracker/` and add that URL plus `http://localhost:5173/ProgressTracker/` to the allowed Redirect URLs. Keep the Email provider enabled under **Authentication → Sign In / Providers**. Supabase's built-in email sender is limited to project organization members and 2 emails per hour; broader delivery requires custom SMTP, which is not configured by this project.

## Dependency audit note

On 2026-10-07, `npm audit --omit=dev` reported no production dependency vulnerabilities. The full audit reported one moderate and two critical findings in the development-only Vitest 3 toolchain (`@vitest/mocker` and `tinypool`); these do not ship in the GitHub Pages bundle. npm offered Vitest 5.0.3 as an automatic fix, which is a major upgrade with breaking changes, so it was not applied automatically. Re-audit before production CI is added and review a Vitest upgrade separately.

The same install reported npm's script-approval notice for esbuild 0.28.2. Its platform binary runs and the production build succeeds without approving that postinstall script, so no install-script approval or dependency change was needed for this foundation.

## Local development

Requires Node.js 20.19 or newer and npm.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

## Deployment path

Vite is configured to build assets under `/ProgressTracker/`, matching the GitHub Pages repository URL. Client navigation currently uses hash URLs so direct page loads and refreshes do not depend on server-side route rewrites. Automated GitHub Pages deployment will be added in a later step.

## Interface foundation

The current visual language uses a muted botanical green accent, warm neutral surfaces, editorial serif headings, and restrained borders. Shared `Button`, `Surface`, `PageHeader`, and `EmptyState` components establish reusable patterns. The layout includes a compact mobile navigation and honors reduced-motion preferences. Theme switching and the final accessibility review remain future steps.

## Planned architecture

IndexedDB provides the immediate local persistence layer through Dexie repositories. Supabase Authentication and PostgreSQL with Row Level Security will support optional account-based synchronization across devices. The deployed static application will not include a custom backend. No analytics service is configured.
