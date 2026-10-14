import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useAuth } from '../features/auth/AuthProvider'
import { InstallAppPrompt } from '../components/InstallAppPrompt'
import { WorkspaceTimeZoneProvider } from '../features/settings/WorkspaceTimeZone'
import { WorkspaceLoadingState } from '../components/ui/WorkspaceLoadingState'
import { ToastProvider } from '../components/ui/ToastProvider'
import { NotificationCenter } from '../components/NotificationCenter'
import { ForegroundReminderMonitor } from '../features/notifications/ForegroundReminderMonitor'
import { AppIcon, type AppIconName } from '../components/ui/AppIcon'
import { AIHelpAssistant } from '../features/ai-help/AIHelpAssistant'
import { useMaintainerAccess } from '../features/ai-knowledge/useMaintainerAccess'
import { BadgeCelebrationMonitor } from '../features/dashboard/BadgeCelebrationDialog'

type NavigationDestination = {
  group: 'primary' | 'more'
  to: string
  label: string
  icon: AppIconName
  matches?: readonly string[]
  end?: boolean
  requiresMaintainer?: boolean
}

const navigationConfiguration: readonly NavigationDestination[] = [
  { group: 'primary', to: '/', label: 'Today', icon: 'today', matches: ['/'], end: true },
  { group: 'primary', to: '/trackers', label: 'Trackers', icon: 'trackers', matches: ['/trackers', '/goals'] },
  { group: 'primary', to: '/calendar', label: 'Calendar', icon: 'calendar', matches: ['/calendar', '/history'] },
  { group: 'primary', to: '/dashboard', label: 'Insights', icon: 'insights', matches: ['/dashboard', '/analytics', '/achievements'] },
  { group: 'more', to: '/holidays', label: 'Holidays & breaks', icon: 'holiday' },
  { group: 'more', to: '/settings', label: 'Settings', icon: 'settings' },
  { group: 'more', to: '/bin', label: 'Bin', icon: 'bin' },
  { group: 'more', to: '/ai-knowledge', label: 'AI Knowledge', icon: 'spark', requiresMaintainer: true },
]

const primaryNavigation = navigationConfiguration.filter((destination) => destination.group === 'primary')
const moreNavigation = navigationConfiguration.filter((destination) => destination.group === 'more')

const contextualNavigation = { to: '/auth', label: 'Account & sync', icon: 'account' } as const

function routeMatches(pathname: string, destinations: readonly string[]) {
  return destinations.some((path) => path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`))
}

function routeCapabilityId(pathname: string) {
  if (pathname === '/') return 'route.today'
  if (pathname === '/ai-knowledge') return null
  if (/^\/trackers\/[^/]+\/edit\/?$/.test(pathname)) return 'route.trackers.:trackerId.edit'
  if (pathname === '/trackers/new') return 'route.trackers.new'
  return `route.${pathname.replace(/^\//, '').replaceAll('/', '.')}`
}

export function getAvatarInitial(user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined) {
  const metadata = user?.user_metadata
  const displayName = [metadata?.display_name, metadata?.full_name, metadata?.name]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const value = displayName?.trim() || user?.email?.trim()
  return value ? value.charAt(0).toLocaleUpperCase() : null
}

export function AppShell() {
  const { status, user, passwordRecovery, workspaceStatus, workspaceUserId, sessionTransitionPending, guestSummary, workspaceError, chooseGuestData, retryWorkspace, syncStatus, isOnline } = useAuth()
  const maintainerAccess = useMaintainerAccess()
  const navigate = useNavigate()
  const location = useLocation()
  const moreRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const moreTriggerRef = useRef<HTMLButtonElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  useEffect(() => { setMoreOpen(false) }, [location.key, location.pathname, location.search, location.hash])
  useEffect(() => {
    if (!moreOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) setMoreOpen(false)
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMoreOpen(false); moreTriggerRef.current?.focus() }
    }
    const closeForOtherLayers = () => setMoreOpen(false)
    const closeOnFocusOutside = (event: FocusEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) setMoreOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    document.addEventListener('progress-tracker:open-info', closeForOtherLayers)
    document.addEventListener('focusin', closeOnFocusOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
      document.removeEventListener('progress-tracker:open-info', closeForOtherLayers)
      document.removeEventListener('focusin', closeOnFocusOutside)
    }
  }, [moreOpen])
  useEffect(() => { if (passwordRecovery) navigate('/auth', { replace: true }) }, [navigate, passwordRecovery])
  const syncLabel = status === 'loading' ? 'Checking account'
    : status !== 'signed-in' ? 'Local mode'
      : isOnline === false || syncStatus === 'offline' ? 'Offline · changes saved'
        : syncStatus === 'syncing' ? 'Syncing account'
          : syncStatus === 'waiting' ? 'Sync pending'
            : syncStatus === 'error' ? 'Sync needs attention'
              : syncStatus === 'complete' ? 'Synced'
                : 'Account ready'
  const compactSyncLabel = status === 'loading' ? 'Checking'
    : status !== 'signed-in' ? 'Local'
      : isOnline === false || syncStatus === 'offline' ? 'Offline'
        : syncStatus === 'syncing' ? 'Syncing'
          : syncStatus === 'waiting' ? 'Pending'
            : syncStatus === 'error' ? 'Error'
              : syncStatus === 'complete' ? 'Synced'
                : 'Ready'
  const syncTone = syncStatus === 'error' ? 'error' : syncStatus === 'offline' || isOnline === false ? 'offline' : syncStatus === 'syncing' ? 'syncing' : syncStatus === 'complete' ? 'complete' : 'local'
  const expectedWorkspaceUserId = status === 'signed-in' ? user?.id ?? null : null
  const accountSettingsHref = status === 'signed-in' ? '/settings#personal-information' : '/auth'
  const syncSettingsHref = status === 'signed-in' ? '/settings#sync-data' : '/auth'
  const canSeeAiKnowledge = status === 'signed-in' && maintainerAccess.status === 'authorized'
  const checkingAiKnowledgeAccess = status === 'loading' || (status === 'signed-in' && ['checking', 'error'].includes(maintainerAccess.status))
  const aiKnowledgeRouteActive = routeMatches(location.pathname, ['/ai-knowledge'])
  const visibleMoreNavigation = moreNavigation.filter(({ requiresMaintainer }) => !requiresMaintainer || canSeeAiKnowledge)
  const showAccountNavigation = status === 'local-only' || status === 'signed-out'
  const moreRouteActive = visibleMoreNavigation.some(({ to }) => routeMatches(location.pathname, [to])) || (checkingAiKnowledgeAccess && aiKnowledgeRouteActive)
  const workspaceOwnerVerified = workspaceUserId === expectedWorkspaceUserId
  const workspaceReady = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceOwnerVerified
  const guestChoiceReady = !sessionTransitionPending && status === 'signed-in' && workspaceStatus === 'needs-guest-choice' && workspaceOwnerVerified

  function handleMoreMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = moreMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
    if (!items?.length) return
    event.preventDefault()
    const current = [...items].indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length
        : current <= 0 ? items.length - 1 : current - 1
    items[next]?.focus()
  }

  return (
    <ToastProvider><div className="app-frame">
      {status === 'signed-in' && user?.id && <BadgeCelebrationMonitor userId={user.id} />}
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
          {primaryNavigation.map(({ to, label, icon, matches = [], end = false }) => {
            const active = routeMatches(location.pathname, matches)
            return <NavLink key={to} to={to} end={end} aria-current={active ? 'page' : undefined} className={`nav-link${active ? ' active' : ''}`}>
              <AppIcon className="nav-icon" name={icon} />
              {label}
            </NavLink>
          })}
          </nav>
          <nav className="sidebar-secondary" aria-label="More destinations">
            <span className="nav-caption nav-caption-secondary">MORE</span>
            {visibleMoreNavigation.map(({ to, label, icon }) => <NavLink key={to} to={to} className="nav-link secondary-link"><AppIcon className="nav-icon" name={icon} />{label}</NavLink>)}
            {checkingAiKnowledgeAccess && <div className={`nav-link secondary-link nav-access-pending${aiKnowledgeRouteActive ? ' active' : ''}`} role="status" aria-disabled="true" aria-current={aiKnowledgeRouteActive ? 'page' : undefined} aria-label="Checking AI Knowledge access">
              <AppIcon className="nav-icon" name="spark" />AI Knowledge
            </div>}
            {showAccountNavigation && <NavLink to={contextualNavigation.to} className="nav-link secondary-link"><AppIcon className="nav-icon" name={contextualNavigation.icon} />{contextualNavigation.label}</NavLink>}
          </nav>
          <Link className={`sync-state ${syncTone}`} to={syncSettingsHref}><span className="sync-dot" /><span>{syncLabel}</span><span className="sync-note">· details</span></Link>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark" aria-hidden="true">p</span> ProgressTracker</div>
          <div className="topbar-spacer" />
          <span className="date-chip">A little progress, every day</span>
          <InstallAppPrompt />
          <Link className={`topbar-sync-state ${syncTone}`} to={syncSettingsHref} aria-label={`${syncLabel}. Open sync details`}><span className="sync-dot" aria-hidden="true" /><span className="sync-status-full" aria-hidden="true">{syncLabel}</span><span className="sync-status-compact" aria-hidden="true">{compactSyncLabel}</span></Link>
          <AIHelpAssistant />
          <NotificationCenter ownerUserId={workspaceReady ? expectedWorkspaceUserId : null} ready={workspaceReady} />
          <Link className="avatar" to={accountSettingsHref} aria-label={status === 'signed-in' ? 'Open profile settings' : 'Open account and sign-in'}>
            {getAvatarInitial(user) ? <span aria-hidden="true">{getAvatarInitial(user)}</span> : <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></svg>}
          </Link>
        </header>
        <div id="main-content" className="page-content" data-ai-capability={routeCapabilityId(location.pathname)} tabIndex={-1}>
          {!workspaceReady && !guestChoiceReady ? (
            workspaceStatus === 'error' ? <section className="workspace-gate" role="alert">
              <h1>Workspace unavailable</h1>
              <p>{workspaceError}</p>
              <button className="button button-secondary button-medium" onClick={retryWorkspace}>Try again</button>
            </section> : <WorkspaceLoadingState />
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
          ) : <WorkspaceTimeZoneProvider ownerUserId={expectedWorkspaceUserId}><ForegroundReminderMonitor enabled={workspaceReady} /><Outlet context={maintainerAccess} /></WorkspaceTimeZoneProvider>}
        </div>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {primaryNavigation.map(({ to, label, icon, matches = [], end = false }) => {
            const active = routeMatches(location.pathname, matches)
            return <NavLink key={to} to={to} end={end} aria-current={active ? 'page' : undefined} className={`mobile-nav-link${active ? ' active' : ''}`}>
              <AppIcon className="mobile-nav-icon" name={icon} /><small>{label}</small>
            </NavLink>
          })}
          <div className={`mobile-more${moreRouteActive ? ' has-active-route' : ''}${moreOpen ? ' is-open' : ''}`} ref={moreRef}>
            <button ref={moreTriggerRef} type="button" aria-label="More destinations" aria-haspopup="menu" aria-expanded={moreOpen} aria-controls={moreOpen ? 'mobile-more-menu' : undefined} className="mobile-more-trigger" onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (moreOpen) moreMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
                else {
                  setMoreOpen(true)
                  requestAnimationFrame(() => moreMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus())
                }
              }
            }} aria-current={moreRouteActive ? 'page' : undefined} onClick={() => setMoreOpen((value) => !value)}><AppIcon className="mobile-nav-icon" name="more" /><small>More</small></button>
            {moreOpen && <div ref={moreMenuRef} id="mobile-more-menu" className="mobile-more-menu" role="menu" aria-label="More destinations" onKeyDown={handleMoreMenuKeyDown}>
              {visibleMoreNavigation.map(({ to, label, icon }) => <NavLink key={to} to={to} role="menuitem" className={({ isActive }) => `mobile-more-item${isActive ? ' active' : ''}`} aria-current={routeMatches(location.pathname, [to]) ? 'page' : undefined} onClick={(event) => {
                setMoreOpen(false)
                event.currentTarget.blur()
              }}><AppIcon className="mobile-more-icon" name={icon} />{label}</NavLink>)}
              {checkingAiKnowledgeAccess && <div role="menuitem" aria-disabled="true" aria-current={aiKnowledgeRouteActive ? 'page' : undefined} className={`mobile-more-item nav-access-pending${aiKnowledgeRouteActive ? ' active' : ''}`} aria-label="Checking AI Knowledge access">
                <AppIcon className="mobile-more-icon" name="spark" />AI Knowledge
              </div>}
              {showAccountNavigation && <NavLink to={contextualNavigation.to} role="menuitem" className={({ isActive }) => `mobile-more-item${isActive ? ' active' : ''}`} aria-current={routeMatches(location.pathname, [contextualNavigation.to]) ? 'page' : undefined} onClick={(event) => {
                setMoreOpen(false)
                event.currentTarget.blur()
              }}><AppIcon className="mobile-more-icon" name={contextualNavigation.icon} />{contextualNavigation.label}</NavLink>}
            </div>}
          </div>
        </nav>
      </main>
    </div></ToastProvider>
  )
}
