import { createHashRouter } from 'react-router-dom'
import { AppShell } from '../app/AppShell'
import { TodayPage } from '../features/today/TodayPage'
import { AuthPage } from '../features/auth/AuthPage'
import { GoalsPage } from '../features/goals/GoalsPage'
import { TrackerLibraryPage } from '../features/trackers/TrackerLibraryPage'
import { TrackerSetupPage } from '../features/trackers/TrackerSetupPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { HistoryPage } from '../features/history/HistoryPage'
import { SettingsPage } from '../features/settings/WorkspaceTimeZone'
import { AchievementsPage } from '../features/dashboard/AchievementsPage'
import { AnalyticsPage } from '../features/analytics/AnalyticsPage'
import { TrackerBinPage } from '../features/trackers/TrackerBinPage'
import { HolidaysPage } from '../features/holidays/HolidaysPage'
import { CalendarPage } from '../features/calendar/CalendarPage'

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <TodayPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'goals', element: <GoalsPage /> },
      { path: 'trackers', element: <TrackerLibraryPage /> },
      { path: 'bin', element: <TrackerBinPage /> },
      { path: 'holidays', element: <HolidaysPage /> },
      { path: 'trackers/new', element: <TrackerSetupPage /> },
      { path: 'trackers/:trackerId/edit', element: <TrackerSetupPage /> },
      { path: 'achievements', element: <AchievementsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'auth', element: <AuthPage /> },
    ],
  },
])
