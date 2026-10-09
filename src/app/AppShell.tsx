import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuth } from '../features/auth/AuthProvider'
import { InstallAppPrompt } from '../components/InstallAppPrompt'
import { WorkspaceTimeZoneProvider } from '../features/settings/WorkspaceTimeZone'

const primaryNavigation = [
  { to: '/', label: 'Today', icon: '◷', matches: ['/'], end: true },
  { to: '/trackers', label: 'Trackers', icon: '✳', matches: ['/trackers', '/goals'] },
  { to: '/calendar', label: 'Calendar', icon: '▦', matches: ['/calendar', '/history'] },
  { to: '/dashboard', label: 'Insights', icon: '↗', matches: ['/dashboard', '/analytics', '/achievements'] },
]

const mobileMoreNavigation = [
  { to: '/holidays', label: 'Holidays & breaks' },
  { to: '/bin', label: 'Bin' },
  { to: '/settings', label: 'Settings' },
  { to: '/auth', label: 'Account & sync' },
]

function routeMatches(pathname: string, destinations: readonly string[]) {
  return destinations.some((path) => path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`))
}

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

        <div className="sidebar-scroll">
          <nav className="nav-list" aria-label="Primary navigation">
          {primaryNavigation.map(({ to, label, icon, matches, end }) => {
            const active = routeMatches(location.pathname, matches)
            return <NavLink key={to} to={to} end={end} aria-current={active ? 'page' : undefined} className={`nav-link${active ? ' active' : ''}`}>
              <span className="nav-icon" aria-hidden="true">{icon}</span>
              {label}
            </NavLink>
          })}
          </nav>
          <div className="sidebar-secondary" aria-label="More destinations">
            <span className="nav-caption nav-caption-secondary">MORE</span>
            <NavLink to="/holidays" className="nav-link secondary-link"><span className="nav-icon" aria-hidden="true">☀</span>Holidays & breaks</NavLink>
            <NavLink to="/settings" className="nav-link secondary-link"><span className="nav-icon" aria-hidden="true">⚙</span>Settings</NavLink>
            <NavLink to="/bin" className="nav-link secondary-link"><span className="nav-icon" aria-hidden="true">▤</span>Bin</NavLink>
            <NavLink to="/auth" className="nav-link secondary-link"><span className="nav-icon" aria-hidden="true">◉</span>Account & sync</NavLink>
          </div>
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
          {primaryNavigation.map(({ to, label, icon, matches, end }) => {
            const active = routeMatches(location.pathname, matches)
            return <NavLink key={to} to={to} end={end} aria-current={active ? 'page' : undefined} className={`mobile-nav-link${active ? ' active' : ''}`}>
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
