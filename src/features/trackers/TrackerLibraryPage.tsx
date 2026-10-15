import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionTabs, trackerSectionTabs } from '../../components/ui/SectionTabs'
import { Surface } from '../../components/ui/Surface'
import { useToast } from '../../components/ui/ToastProvider'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import type { StoredTrackerDefinition } from '../../db/models'
import { useAuth } from '../auth/AuthProvider'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { isScheduledDate } from '../../domain/trackers/planning'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { calendarDateLabel, useWorkspaceCalendarDate } from '../shared/localDates'
import { InfoButton } from '../../components/ui/InfoButton'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { getChallengeDayDisplay } from '../../domain/trackers/challengeDay'

const kindLabels = { habit: 'Habit', goal: 'Goal', challenge: 'Challenge', project: 'Project' }

export function TrackerLibraryPage() {
  const { notify } = useToast()
  const { status: authStatus, user, workspaceStatus, workspaceUserId, sessionTransitionPending, syncStatus, isOnline } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const today = useWorkspaceCalendarDate(timeZone)
  const expectedOwner = authStatus === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && authStatus !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === expectedOwner
  const workspaceKey = workspaceReady ? expectedOwner ?? 'guest' : null
  const workspaceRef = useRef({ key: workspaceKey, ready: workspaceReady })
  workspaceRef.current = { key: workspaceKey, ready: workspaceReady }
  const readGenerationRef = useRef(0)
  const [trackerSnapshot, setTrackerSnapshot] = useState<{ workspaceKey: string; trackers: StoredTrackerDefinition[]; checkedInToday: string[]; holidays: string[] } | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('active')
  const [pendingBinTracker, setPendingBinTracker] = useState<StoredTrackerDefinition | null>(null)
  const [kindFilter, setKindFilter] = useState<'all' | StoredTrackerDefinition['kind']>('all')
  const [loading, setLoading] = useState(true)
  const [errorState, setErrorState] = useState<{ workspaceKey: string; message: string } | null>(null)
  const trackers = workspaceKey && trackerSnapshot?.workspaceKey === workspaceKey ? trackerSnapshot.trackers : []
  const checkedInToday = new Set(workspaceKey && trackerSnapshot?.workspaceKey === workspaceKey ? trackerSnapshot.checkedInToday : [])
  const holidays = new Set(workspaceKey && trackerSnapshot?.workspaceKey === workspaceKey ? trackerSnapshot.holidays : [])
  const error = workspaceKey && errorState?.workspaceKey === workspaceKey ? errorState.message : ''
  const visibleLoading = loading || !workspaceReady || Boolean(workspaceKey && trackerSnapshot?.workspaceKey !== workspaceKey)
  const statusFilteredTrackers = statusFilter === 'all' ? trackers : trackers.filter((tracker) => tracker.status === statusFilter)
  const visibleTrackers = kindFilter === 'all' ? statusFilteredTrackers : statusFilteredTrackers.filter((tracker) => tracker.kind === kindFilter)

  const refresh = useCallback(async () => {
    const context = workspaceRef.current
    if (!context.ready || !context.key) return
    const generation = ++readGenerationRef.current
    setLoading(true)
    setErrorState(null)
    try {
      const [result, entries, holidayRows] = await Promise.all([
        localRepository.listTrackers(true),
        localRepository.listTrackerEntriesBetween(today, today),
        localRepository.listAccountHolidays(),
      ])
      if (readGenerationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === context.key) {
        setTrackerSnapshot({ workspaceKey: context.key, trackers: result, checkedInToday: entries.filter((entry) => entry.deletedAt === null).map((entry) => entry.trackerId), holidays: holidayRows.map((holiday) => holiday.date) })
      }
    } catch {
      if (readGenerationRef.current === generation && workspaceRef.current.ready && workspaceRef.current.key === context.key) {
        setErrorState({ workspaceKey: context.key, message: 'Your trackers could not be loaded from this device.' })
      }
    } finally {
      if (readGenerationRef.current === generation) setLoading(false)
    }
  }, [today])

  useEffect(() => {
    if (!workspaceReady || !workspaceKey) {
      setLoading(true)
      return () => { readGenerationRef.current += 1 }
    }
    void refresh()
    return () => { readGenerationRef.current += 1 }
  }, [refresh, workspaceKey, workspaceReady])
  useWorkspaceDataChanges(expectedOwner, workspaceReady, refresh)

  async function archive(id: string) {
    try {
      await localRepository.archiveTracker(id)
      await refresh()
      notify({ kind: 'success', title: 'Tracker archived', description: 'Its history and plan are still available.', dedupeKey: `tracker:${id}` })
    } catch {
      notify({ kind: 'error', title: 'Couldn’t archive tracker', description: 'Your tracker is unchanged. Please try again.', duration: 0, dedupeKey: `tracker:${id}` })
    }
  }

  async function unarchive(id: string) {
    try {
      await localRepository.unarchiveTracker(id)
      await refresh()
      notify({ kind: 'success', title: 'Tracker restored', description: 'It is active again with its saved history.', dedupeKey: `tracker:${id}` })
    } catch {
      notify({ kind: 'error', title: 'Couldn’t restore tracker', description: 'Your tracker is unchanged. Please try again.', duration: 0, dedupeKey: `tracker:${id}` })
    }
  }

  async function moveToBin(tracker: StoredTrackerDefinition) {
    try {
      await localRepository.deleteTracker(tracker.id)
      await refresh()
      notify({ kind: 'success', title: 'Moved to Bin', description: 'You can restore it from the Bin.', dedupeKey: `tracker:${tracker.id}` })
    } catch {
      notify({ kind: 'error', title: 'Couldn’t move tracker to the Bin', description: 'Your tracker is unchanged. Please try again.', duration: 0, dedupeKey: `tracker:${tracker.id}` })
    }
  }

  return (
    <section className="tracker-page" aria-labelledby="trackers-title">
      <PageHeader
        headingId="trackers-title"
        eyebrow="YOUR PRACTICE"
        title="Trackers & Goals"
        description="Habits, goals, challenges, and projects you choose to make progress on."
        help={{ title: 'Trackers', summary: 'Your active routines, goals, challenges, and projects live here.', description: 'Open a tracker to record a check-in or edit its setup. Archive hides a tracker from active work while retaining it. Move a tracker to the Bin to keep its progress and restore it later.' }}
        action={<Link className="button button-primary button-medium" to="/trackers/new">＋ Create tracker</Link>}
      />
      <SectionTabs label="Trackers and goals" items={trackerSectionTabs} />
      <div className="tracker-kind-filters" role="group" aria-label="Filter trackers">
        {(['all', 'goal', 'habit', 'challenge', 'project'] as const).map((kind) => <button key={kind} type="button" className={`filter-chip${kindFilter === kind ? ' active' : ''}`} aria-pressed={kindFilter === kind} onClick={() => setKindFilter(kind)}>{kind === 'all' ? 'All' : kind === 'goal' ? 'Goals' : kind === 'habit' ? 'Habits' : kind === 'challenge' ? 'Challenges' : 'Projects'}</button>)}
      </div>
      <div className="tracker-library-toolbar">
        <p>{statusFilter === 'all' ? 'Showing all trackers' : statusFilter === 'archived' ? 'Showing archived trackers' : 'Showing active trackers'}</p>
        <div className="tracker-status-filters" role="group" aria-label="Tracker status filter">
          {(['all', 'active', 'archived'] as const).map((filter) => <button key={filter} type="button" className={`tracker-status-option${statusFilter === filter ? ' selected' : ''}`} aria-pressed={statusFilter === filter} onClick={() => setStatusFilter(filter)}>{filter === 'all' ? 'All' : filter === 'active' ? 'Active' : 'Archived'}</button>)}
        </div>
      </div>
      {error && <div role="alert" className="form-alert">{error}</div>}
      {visibleLoading ? <p role="status" className="tracker-loading">Loading your trackers…</p> : trackers.length === 0 ? (
        <Surface>
          {authStatus === 'signed-in' && (syncStatus === 'waiting' || syncStatus === 'syncing' || syncStatus === 'offline') ? (
            <EmptyState title={isOnline === false ? 'Cloud progress has not loaded yet' : 'Checking your cloud progress'} description={isOnline === false ? 'You are offline. Any progress on this device stays available, and the account’s cloud records will be checked after reconnecting.' : 'This account’s saved trackers are being checked. You can keep using this workspace while the check finishes.'} action={<Link className="button button-secondary button-medium" to="/auth">Account and sync status</Link>} />
          ) : authStatus === 'signed-in' && syncStatus === 'error' ? (
            <EmptyState title="Cloud sync could not finish" description="No local trackers are saved in this workspace yet. Your local data is safe; open Account to retry the cloud check." action={<Link className="button button-secondary button-medium" to="/auth">Open account and retry</Link>} />
          ) : (
            <EmptyState title={statusFilter === 'archived' ? 'No archived trackers' : 'A blank page is a good start'} description="Create a tracker with a schedule and a measure that feels useful to you. It will be available offline and sync to your account when you’re signed in." action={<Link className="button button-primary button-medium" to="/trackers/new">Create your first tracker</Link>} />
          )}
        </Surface>
      ) : visibleTrackers.length === 0 ? <Surface><p>{statusFilter === 'archived' ? 'No archived trackers match these filters.' : statusFilter === 'active' ? 'No active trackers match these filters.' : 'No trackers match these filters.'}</p></Surface> : (
        <div className="tracker-card-grid">
          {visibleTrackers.map((tracker) => (
            <Surface key={tracker.id} className="tracker-card">
              <div className="tracker-card-top"><span className="tracker-kind-chip">{kindLabels[tracker.kind]}</span><span className="tracker-card-policy">{tracker.strictMode ? <>Strict Mode <InfoButton title="Strict Mode" summary="This tracker requires qualifying progress every calendar day." description="Holidays, weekends, and unscheduled rest days count as streak opportunities. A qualifying voluntary check-in can preserve the streak without changing this tracker’s schedule or the holiday." /></> : 'Standard Mode'}</span>{tracker.status === 'archived' && <span className="tracker-archived-chip">Archived</span>}</div>
              <h2>{tracker.name}</h2>
              {tracker.description && <p className="tracker-card-description">{tracker.description}</p>}
              {getChallengeDayDisplay(tracker, today, timeZone, holidays) && <p className="challenge-day-label" aria-label={`Challenge ${getChallengeDayDisplay(tracker, today, timeZone, holidays)!.label}`}>{getChallengeDayDisplay(tracker, today, timeZone, holidays)!.label}</p>}
              <TrackerCardTargets tracker={tracker} />
              <div className="tracker-card-meta">
                <span>{tracker.schedule.kind === 'every-day' ? 'Every day' : tracker.schedule.kind === 'weekdays' ? 'Weekdays' : tracker.schedule.kind === 'times-per-week' ? `${tracker.schedule.count} times a week` : 'Flexible schedule'}</span>
                {tracker.deadline && <span>Due {calendarDateLabel(tracker.deadline)}</span>}
              </div>
              <div className="tracker-card-actions">
                {tracker.status === 'active' && (isScheduledDate(tracker, today, timeZone) || tracker.strictMode) && <Link className="button button-primary button-small" to="/">{checkedInToday.has(tracker.id) ? "Edit today's check-in" : tracker.strictMode && !isScheduledDate(tracker, today, timeZone) ? 'Voluntary check-in' : 'Check in today'}</Link>}
                <Link className="button button-secondary button-small" to={`/trackers/${encodeURIComponent(tracker.id)}/edit`}>Edit setup</Link>
                <TrackerActionsMenu tracker={tracker} onArchive={() => archive(tracker.id)} onRestore={() => unarchive(tracker.id)} onDelete={() => setPendingBinTracker(tracker)} />
              </div>
            </Surface>
          ))}
        </div>
      )}
      {pendingBinTracker && <ConfirmActionDialog title={`Move “${pendingBinTracker.name}” to Bin?`} description="Your tracker and its saved progress will be moved to the Bin. You can restore it while it’s in the Bin. Moving it won’t remove your earned XP, badges, or achievements. When you permanently delete the tracker, you can choose what happens to its Wins." actionLabel="Move to Bin" onCancel={() => setPendingBinTracker(null)} onConfirm={() => { const tracker = pendingBinTracker; setPendingBinTracker(null); void moveToBin(tracker) }} />}
    </section>
  )
}

function TrackerActionsMenu({ tracker, onArchive, onRestore, onDelete }: {
  tracker: StoredTrackerDefinition
  onArchive: () => Promise<void>
  onRestore: () => Promise<void>
  onDelete: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const dismissOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
        if (!items?.length) return
        event.preventDefault()
        const current = [...items].indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? (current + 1) % items.length : (current <= 0 ? items.length - 1 : current - 1)
        items[next]?.focus()
      }
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissEscape)
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [open])

  async function run(action: () => void | Promise<void>) {
    setOpen(false)
    await action()
  }

  return <div className="tracker-actions-menu" ref={rootRef}>
    <button ref={triggerRef} type="button" className="button button-secondary button-small tracker-actions-trigger" aria-label={`More actions for ${tracker.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>⋯</button>
    {open && <div className="tracker-actions-popover" role="menu" aria-label={`${tracker.name} actions`} ref={menuRef}>
      {tracker.status === 'archived'
        ? <button type="button" role="menuitem" onClick={() => void run(onRestore)}>Restore</button>
        : <button type="button" role="menuitem" onClick={() => void run(onArchive)}>Archive tracker</button>}
      <button type="button" role="menuitem" className="destructive" onClick={() => void run(onDelete)}>Move to Bin</button>
    </div>}
  </div>
}

function TrackerCardTargets({ tracker }: { tracker: StoredTrackerDefinition }) {
  const targets = tracker.metrics.flatMap((metric) => {
    if (metric.valueType === 'boolean') return []
    const planning = tracker.goalPlanning
    const planned = planning?.mode === 'daily-recurring' ? planning.dailyTargets[metric.id]
      : planning?.mode === 'cumulative-deadline' ? planning.cumulativeTargets[metric.id]
        : undefined
    const mode = planning?.mode === 'daily-recurring' ? 'per scheduled day'
      : planning?.mode === 'cumulative-deadline' ? 'total by deadline' : 'per check-in'
    const unit = metric.unit ? ` ${metric.unit}` : metric.valueType === 'checklist' ? ' items' : ''
    if (planned === undefined && metric.thresholds?.target === undefined) return []
    const rows = planned === undefined ? [] : [{ id: `${metric.id}:plan`, name: metric.name, amount: planned, unit, label: mode }]
    const threshold = metric.thresholds?.target
    if (threshold !== undefined) rows.push({ id: `${metric.id}:check-in`, name: planned === undefined ? metric.name : `${metric.name} · check-in`, amount: threshold, unit, label: 'per check-in' })
    return rows
  })
  if (targets.length === 0) return null
  return <ul className="tracker-card-targets" aria-label={`${tracker.name} targets`}>
    {targets.slice(0, 3).map((target) => <li key={target.id}><span>{target.name}</span><strong>{formatTrackerNumber(target.amount)}{target.unit} <small>{target.label}</small></strong></li>)}
    {targets.length > 3 && <li className="tracker-card-more-targets">+{targets.length - 3} more measures</li>}
  </ul>
}
