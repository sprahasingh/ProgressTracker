import { createHashRouter } from 'react-router-dom'
import { AppShell } from '../app/AppShell'
import { TodayPage } from '../features/today/TodayPage'
import { PlaceholderPage } from '../features/shared/PlaceholderPage'

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <TodayPage /> },
      { path: 'dashboard', element: <PlaceholderPage title="Dashboard" /> },
      { path: 'history', element: <PlaceholderPage title="History" /> },
      { path: 'goals', element: <PlaceholderPage title="Goals" /> },
      { path: 'achievements', element: <PlaceholderPage title="Achievements" /> },
      { path: 'settings', element: <PlaceholderPage title="Settings" /> },
    ],
  },
])
