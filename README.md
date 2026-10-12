# ProgressTracker

ProgressTracker is a local-first app for tracking habits, goals, challenges, and projects. Record daily check-ins, review progress over time, and optionally sync an account across devices.

**[Open the live app](https://sprahasingh.github.io/ProgressTracker/)** · [GitHub repository](https://github.com/sprahasingh/ProgressTracker)

## Features

- Create custom habits, goals, challenges, and projects with schedules, measures, targets, and optional milestones.
- Record daily check-ins, track streaks, and review activity in History and Calendar.
- Use Goals, Analytics, Insights, and Achievements to understand progress and pacing.
- Add holidays and breaks that affect schedule-based progress.
- Sign in to sync tracker data across devices. Guest workspaces stay on the current browser.
- Archive trackers, restore deleted trackers from the Bin, or permanently delete them when the deployment enables that option.
- Choose a light, dark, or device-based theme and configure workspace preferences.
- Install the app where supported. Its offline shell does not cache account data or API responses.

## Screenshots

The repository does not currently include maintained application screenshots.

## Tech stack

| Area | Technology |
| --- | --- |
| UI | React 19, TypeScript, Tailwind CSS 4 |
| Build and routing | Vite, React Router with hash-based routes |
| Local storage | IndexedDB through Dexie |
| Optional account services | Supabase Auth, PostgreSQL, and RPC-based synchronization |
| Quality checks | Vitest, jsdom, and React Testing Library |

## Getting started

### Requirements

- Node.js 20.19 or newer
- npm

### Install and run

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Supabase is optional for local guest mode. To use authentication and account sync, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local`. These are public browser values. Never put a Supabase secret or `service_role` key in a `VITE_` variable. The VAPID public key and feature flags in `.env.example` are only needed for the corresponding enabled features.

### Checks and production build

```sh
npm test
npm run typecheck
npm run build
```

The build runs `prebuild`, which regenerates the AI Help bundles from their reviewed source files before TypeScript and Vite build the app. See [AI Help operations](docs/ai-help/operations.md) before editing those sources.

## Documentation

- [AI Help product map](docs/ai-help/core-application.md)
- [Measures and success rules](docs/ai-help/measures-and-success-rules.md)
- [Goals and milestones](docs/ai-help/goals-and-milestones.md)
- [History, Analytics, and sync](docs/ai-help/history-analytics-sync.md)
- [AI Help operations and release process](docs/ai-help/operations.md)
- [Automatic Bin cleanup runbook](docs/operations/tracker-bin-automatic-cleanup.md)
- [Supabase migrations](supabase/migrations/)
- [Supabase verification scripts](supabase/verification/)

## Data and known limitations

Guest data is stored in the current browser and does not sync. Signed-in tracker and check-in data syncs through Supabase when online; local edits remain queued while offline. Workspace preferences do not currently sync. Backups are local JSON files and are not encrypted by the app, so store them privately.

Some schedule and pacing calculations are date-based approximations. Read the feature guides and implementation before relying on a plan for timezone-sensitive scheduling. Browser and assistive-technology checks that require real devices remain manual.

## Deployment

The project is hosted on GitHub Pages. A push to `main` runs tests, typechecking, and the production build, then deploys the Pages artifact. Production settings are supplied as GitHub Actions repository variables and embedded at build time. See [the deployment workflow](.github/workflows/deploy.yml) and [the automatic Bin cleanup runbook](docs/operations/tracker-bin-automatic-cleanup.md) for the relevant configuration and operational checks.
