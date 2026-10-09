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

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <TodayPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'goals', element: <GoalsPage /> },
      { path: 'trackers', element: <TrackerLibraryPage /> },
      { path: 'trackers/new', element: <TrackerSetupPage /> },
      { path: 'trackers/:trackerId/edit', element: <TrackerSetupPage /> },
      { path: 'achievements', element: <AchievementsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'auth', element: <AuthPage /> },
    ],
  },
])
