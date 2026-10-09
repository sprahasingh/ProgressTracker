import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuth } from '../features/auth/AuthProvider'
import { InstallAppPrompt } from '../components/InstallAppPrompt'
import { WorkspaceTimeZoneProvider } from '../features/settings/WorkspaceTimeZone'

const primaryNavigation = [
  { to: '/', label: 'Today', icon: '◷', group: 'today', end: true },
  { to: '/trackers', label: 'My Space', icon: '✳', group: 'space' },
  { to: '/dashboard', label: 'Insights', icon: '▥', group: 'insights' },
  { to: '/settings', label: 'Settings', icon: '⚙', group: 'settings' },
]

const groupedNavigation = {
  space: [
    { to: '/goals', label: 'Goals' },
  ],
  insights: [
    { to: '/analytics', label: 'Analytics' },
    { to: '/history', label: 'History' },
    { to: '/achievements', label: 'Wins' },
  ],
  settings: [
    { to: '/auth', label: 'Account & sync' },
  ],
}

const mobileMoreNavigation = [
  { to: '/goals', label: 'Goals' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/history', label: 'History' },
  { to: '/achievements', label: 'Wins & achievements' },
  { to: '/auth', label: 'Account & sync' },
]

export function AppShell() {
  const { status, user, passwordRecovery, workspaceStatus, workspaceUserId, sessionTransitionPending, guestSummary, workspaceError, chooseGuestData, retryWorkspace, syncStatus, isOnline } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => { if (passwordRecovery) navigate('/auth', { replace: true }) }, [navigate, passwordRecovery])
  const syncLabel = status === 'loading' ? 'Checking account'
    : status !== 'signed-in' ? 'Local mode'
      : isOnline === false || syncStatus === 'offline' ? 'Offline · changes saved'
        : syncStatus === 'syncing' ? 'Syncing account'
          : syncStatus === 'waiting' ? 'Sync pending'
            : syncStatus === 'error' ? 'Sync needs attention'
              : syncStatus === 'complete' ? 'Synced'
                : 'Account ready'
  const syncTone = syncStatus === 'error' ? 'error' : syncStatus === 'offline' || isOnline === false ? 'offline' : syncStatus === 'syncing' ? 'syncing' : syncStatus === 'complete' ? 'complete' : 'local'
  const expectedWorkspaceUserId = status === 'signed-in' ? user?.id ?? null : null
  const workspaceOwnerVerified = workspaceUserId === expectedWorkspaceUserId
  const workspaceReady = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceOwnerVerified
  const guestChoiceReady = !sessionTransitionPending && status === 'signed-in' && workspaceStatus === 'needs-guest-choice' && workspaceOwnerVerified

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault()
        document.getElementById('main-content')?.focus()
      }}>Skip to main content</a>
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#/" aria-label="ProgressTracker home">
          <span className="brand-mark" aria-hidden="true">p</span>
          <span>progress<span className="brand-light">tracker</span></span>
        </a>

        <div className="nav-caption">WORKSPACE</div>
        <nav className="nav-list" aria-label="Primary navigation">
          {primaryNavigation.map(({ to, label, icon, group, end }) => {
            const activeGroup = group === 'space' ? location.pathname.startsWith('/trackers') || location.pathname.startsWith('/goals')
              : group === 'insights' ? ['/dashboard', '/analytics', '/history', '/achievements'].includes(location.pathname)
                : group === 'settings' ? ['/settings', '/auth'].includes(location.pathname) : false
            return <NavLink key={to} to={to} end={end} aria-current={activeGroup ? 'page' : undefined} className={({ isActive }) => `nav-link${isActive || activeGroup ? ' active' : ''}`}>
              <span className="nav-icon" aria-hidden="true">{icon}</span>
              {label}
            </NavLink>
          })}
        </nav>

        <div className="nav-secondary">
          <span className="nav-caption nav-caption-secondary">MY SPACE</span>
          {groupedNavigation.space.map(({ to, label }) => <NavLink key={to} to={to} end={to === '/trackers'} className={({ isActive }) => `nav-sub-link${isActive ? ' active' : ''}`}>{label}</NavLink>)}
          <span className="nav-caption nav-caption-secondary">INSIGHTS</span>
          {groupedNavigation.insights.map(({ to, label }) => <NavLink key={to} to={to} end={to === '/dashboard'} className={({ isActive }) => `nav-sub-link${isActive ? ' active' : ''}`}>{label}</NavLink>)}
          <span className="nav-caption nav-caption-secondary">ACCOUNT</span>
          {groupedNavigation.settings.map(({ to, label }) => <NavLink key={to} to={to} className={({ isActive }) => `nav-sub-link${isActive ? ' active' : ''}`}>{label}</NavLink>)}
        </div>

        <div className="sidebar-bottom">
          <Link className={`sync-state ${syncTone}`} to="/auth"><span className="sync-dot" /><span>{syncLabel}</span><span className="sync-note">· details</span></Link>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark" aria-hidden="true">p</span> ProgressTracker</div>
          <div className="topbar-spacer" />
          <span className="date-chip">A little progress, every day</span>
          <InstallAppPrompt />
          <Link className={`topbar-sync-state ${syncTone}`} to="/auth"><span className="sync-dot" /><span>{syncLabel}</span></Link>
          <Link className="avatar" to="/auth" aria-label="Open account and sign-in">{user?.email?.trim().charAt(0).toUpperCase() || 'S'}</Link>
        </header>
        <div id="main-content" className="page-content" tabIndex={-1}>
          {!workspaceReady && !guestChoiceReady ? (
            <section className="workspace-gate" role={workspaceStatus === 'error' ? 'alert' : 'status'}>
              <h1>{workspaceStatus === 'error' ? 'Workspace unavailable' : 'Opening your workspace'}</h1>
              <p>{workspaceStatus === 'error' ? workspaceError : 'Your local data is being opened for this session.'}</p>
              {workspaceStatus === 'error' && <button className="button button-secondary button-medium" onClick={retryWorkspace}>Try again</button>}
            </section>
          ) : guestChoiceReady ? (
            <section className="workspace-gate" aria-labelledby="guest-import-title">
              <h1 id="guest-import-title">You have progress saved as a guest</h1>
              <p>Your guest workspace has {Object.values(guestSummary?.counts ?? {}).reduce((sum, count) => sum + count, 0)} saved records. Choose whether to copy it into {user?.email ?? 'this account'}.</p>
              <p>The guest copy stays on this device either way. Importing copies records into this account’s separate local workspace; it does not upload anything.</p>
              <p>If IDs overlap, choose the copy option to keep both sets of records under new IDs. The account’s current settings are kept; the guest settings remain in the guest workspace.</p>
              {workspaceError && <p role="alert" className="auth-error">{workspaceError}</p>}
              <div className="workspace-choice-actions">
                <button className="button button-primary button-medium" onClick={() => void chooseGuestData?.('imported')}>Copy guest progress into this account</button>
                <button className="button button-secondary button-medium" onClick={() => void chooseGuestData?.('imported-as-copies')}>Copy and keep both if IDs overlap</button>
                <button className="button button-secondary button-medium" onClick={() => void chooseGuestData?.('kept-separate')}>Keep guest progress separate</button>
              </div>
            </section>
          ) : <WorkspaceTimeZoneProvider ownerUserId={expectedWorkspaceUserId}><Outlet /></WorkspaceTimeZoneProvider>}
        </div>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {primaryNavigation.map(({ to, label, icon, group, end }) => {
            const activeGroup = group === 'space' ? location.pathname.startsWith('/trackers') || location.pathname.startsWith('/goals')
              : group === 'insights' ? ['/dashboard', '/analytics', '/history', '/achievements'].includes(location.pathname)
                : group === 'settings' ? ['/settings', '/auth'].includes(location.pathname) : false
            return <NavLink key={to} to={to} end={end} aria-current={activeGroup ? 'page' : undefined} className={({ isActive }) => `mobile-nav-link${isActive || activeGroup ? ' active' : ''}`}>
              <span aria-hidden="true">{icon}</span><small>{label}</small>
            </NavLink>
          })}
          <details className="mobile-more">
            <summary aria-label="More destinations">•••<small>More</small></summary>
            <div className="mobile-more-menu">
              {mobileMoreNavigation.map(({ to, label }) => <NavLink key={to} to={to} onClick={(event) => {
                const details = event.currentTarget.closest('details')
                if (details) details.open = false
              }}>{label}</NavLink>)}
            </div>
          </details>
        </nav>
      </main>
    </div>
  )
}
