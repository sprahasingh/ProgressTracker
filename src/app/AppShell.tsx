import { NavLink, Outlet } from 'react-router-dom'

const navigation = [
  { to: '/', label: 'Today', icon: '◷', end: true },
  { to: '/dashboard', label: 'Overview', icon: '▦' },
  { to: '/history', label: 'History', icon: '▤' },
  { to: '/goals', label: 'Goals', icon: '◎' },
  { to: '/achievements', label: 'Wins', icon: '✳' },
]

export function AppShell() {
  return (
    <div className="app-frame">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#/" aria-label="ProgressTracker home">
          <span className="brand-mark" aria-hidden="true">p</span>
          <span>progress<span className="brand-light">tracker</span></span>
        </a>

        <div className="nav-caption">YOUR SPACE</div>
        <nav className="nav-list">
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
          <div className="sync-state"><span className="sync-dot" />Local mode <span className="sync-note">· ready</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark" aria-hidden="true">p</span> ProgressTracker</div>
          <div className="topbar-spacer" />
          <span className="date-chip">A little progress, every day</span>
          <button className="avatar" aria-label="Open account settings" onClick={() => { window.location.hash = '#/settings' }}>S</button>
        </header>
        <div className="page-content"><Outlet /></div>
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
