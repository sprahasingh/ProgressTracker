import { createHashRouter } from 'react-router-dom'
import { AppShell } from '../app/AppShell'
import { TodayPage } from '../features/today/TodayPage'
import { RouteErrorFallback, RouteNotFound } from './RouteFallback'

const loadTrackerSetup = async () => ({ Component: (await import('../features/trackers/TrackerSetupPage')).TrackerSetupPage })

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorFallback />,
    children: [
      { index: true, element: <TodayPage /> },
      { path: 'dashboard', lazy: async () => ({ Component: (await import('../features/dashboard/DashboardPage')).DashboardPage }) },
      { path: 'calendar', lazy: async () => ({ Component: (await import('../features/calendar/CalendarPage')).CalendarPage }) },
      { path: 'history', lazy: async () => ({ Component: (await import('../features/history/HistoryPage')).HistoryPage }) },
      { path: 'analytics', lazy: async () => ({ Component: (await import('../features/analytics/AnalyticsPage')).AnalyticsPage }) },
      { path: 'goals', lazy: async () => ({ Component: (await import('../features/goals/GoalsPage')).GoalsPage }) },
      { path: 'trackers', lazy: async () => ({ Component: (await import('../features/trackers/TrackerLibraryPage')).TrackerLibraryPage }) },
      { path: 'bin', lazy: async () => ({ Component: (await import('../features/trackers/TrackerBinPage')).TrackerBinPage }) },
      { path: 'holidays', lazy: async () => ({ Component: (await import('../features/holidays/HolidaysPage')).HolidaysPage }) },
      { path: 'trackers/new', lazy: loadTrackerSetup },
      { path: 'trackers/:trackerId/edit', lazy: loadTrackerSetup },
      { path: 'achievements', lazy: async () => ({ Component: (await import('../features/dashboard/AchievementsPage')).AchievementsPage }) },
      { path: 'achievements/challenges', lazy: async () => ({ Component: (await import('../features/dashboard/LegacyAchievementsPage')).LegacyAchievementsPage }) },
      { path: 'settings', lazy: async () => ({ Component: (await import('../features/settings/WorkspaceTimeZone')).SettingsPage }) },
      { path: 'ai-knowledge', lazy: async () => ({ Component: (await import('../features/ai-knowledge/AIKnowledgePage')).AIKnowledgePage }) },
      { path: 'auth', lazy: async () => {
        const { AuthPage } = await import('../features/auth/AuthPage')
        return { Component: () => <AuthPage redirectSignedIn /> }
      } },
      { path: '*', element: <RouteNotFound /> },
    ],
  },
])
