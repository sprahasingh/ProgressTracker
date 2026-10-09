import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuth } from '../features/auth/AuthProvider'

const navigation = [
  { to: '/', label: 'Today', icon: '◷', end: true },
  { to: '/dashboard', label: 'Overview', icon: '▦' },
  { to: '/history', label: 'History', icon: '▤' },
  { to: '/trackers', label: 'Trackers', icon: '✳' },
  { to: '/goals', label: 'Goals', icon: '◎' },
  { to: '/achievements', label: 'Wins', icon: '✳' },
]

export function AppShell() {
  const { status, user, passwordRecovery, workspaceStatus, workspaceUserId, guestSummary, workspaceError, chooseGuestData, retryWorkspace } = useAuth()
  const navigate = useNavigate()
  useEffect(() => { if (passwordRecovery) navigate('/auth', { replace: true }) }, [navigate, passwordRecovery])
  const localStatus = status === 'signed-in' ? 'Account ready' : status === 'loading' ? 'Checking account' : 'Local mode'

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

        <div className="nav-caption">YOUR SPACE</div>
        <nav className="nav-list" aria-label="Primary navigation">
          {navigation.map(({ to, label, icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <span className="nav-icon" aria-hidden="true">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <NavLink to="/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span className="nav-icon" aria-hidden="true">⚙</span>Settings
          </NavLink>
          <div className="sync-state"><span className="sync-dot" />{localStatus}<span className="sync-note">· saved here</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark" aria-hidden="true">p</span> ProgressTracker</div>
          <div className="topbar-spacer" />
          <span className="date-chip">A little progress, every day</span>
          <Link className="avatar" to="/auth" aria-label="Open account and sign-in">S</Link>
        </header>
        <div id="main-content" className="page-content" tabIndex={-1}>
          {workspaceStatus && (workspaceStatus === 'loading' || workspaceStatus === 'error' || workspaceUserId !== (status === 'signed-in' ? user?.id ?? null : null)) ? (
            <section className="workspace-gate" role={workspaceStatus === 'error' ? 'alert' : 'status'}>
              <h1>{workspaceStatus === 'error' ? 'Workspace unavailable' : 'Opening your workspace'}</h1>
              <p>{workspaceStatus === 'error' ? workspaceError : 'Your local data is being opened for this session.'}</p>
              {workspaceStatus === 'error' && <button className="button button-secondary button-medium" onClick={retryWorkspace}>Try again</button>}
            </section>
          ) : workspaceStatus === 'needs-guest-choice' ? (
            <section className="workspace-gate" aria-labelledby="guest-import-title">
              <h1 id="guest-import-title">You have progress saved as a guest</h1>
              <p>Your guest workspace has {Object.values(guestSummary?.counts ?? {}).reduce((sum, count) => sum + count, 0)} saved records. Choose whether to copy it into {user?.email ?? 'this account'}.</p>
              <p>The guest copy stays on this device either way. Importing copies records into this account’s separate local workspace; it does not upload anything.</p>
              {workspaceError && <p role="alert" className="auth-error">{workspaceError}</p>}
              <div className="workspace-choice-actions">
                <button className="button button-primary button-medium" onClick={() => void chooseGuestData?.('imported')}>Copy guest progress into this account</button>
                <button className="button button-secondary button-medium" onClick={() => void chooseGuestData?.('kept-separate')}>Keep guest progress separate</button>
              </div>
            </section>
          ) : <Outlet />}
        </div>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {navigation.slice(0, 5).map(({ to, label, icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `mobile-nav-link${isActive ? ' active' : ''}`}>
              <span aria-hidden="true">{icon}</span><small>{label}</small>
            </NavLink>
          ))}
        </nav>
      </main>
    </div>
  )
}
