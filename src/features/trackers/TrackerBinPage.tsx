import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { useToast } from '../../components/ui/ToastProvider'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { AppIcon } from '../../components/ui/AppIcon'
import { localRepository } from '../../db/localRepository'
import type { PendingTrackerRestore, PermanentDeletionRequest, StoredTrackerDefinition, TrackerWinsRetention } from '../../db/models'
import { isPermanentDeletionEnabled } from '../../domain/trackers/schemaVersionGate'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import { useAuth } from '../auth/AuthProvider'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { permanentDeletionNotificationKey } from '../../services/permanentDeletionNotifications'

const recoveryMs = 30 * 24 * 60 * 60 * 1000
const kindLabel = { habit: 'Habit', goal: 'Goal', challenge: 'Challenge', project: 'Project' }

function recoveryLabel(deletedAt: string, now: number, accountOwned: boolean) {
  const remaining = Date.parse(deletedAt) + recoveryMs - now
  if (remaining <= 0) return accountOwned ? 'Recovery estimate passed · reconnect to check status' : 'Recovery period ended · restore unavailable'
  const days = Math.ceil(remaining / (24 * 60 * 60 * 1000))
  const deadline = new Date(Date.parse(deletedAt) + recoveryMs)
  return `${days} ${days === 1 ? 'day' : 'days'} left to restore · recovery ends ${deadline.toLocaleDateString(undefined, { dateStyle: 'medium' })}`
}

function binDescription(permanentDeletionEnabled: boolean) {
  return permanentDeletionEnabled
    ? 'Restore trackers from the Bin during recovery, or permanently delete one and choose what happens to its Wins.'
    : 'Restore trackers from the Bin during recovery. Permanent deletion isn’t available in this app version.'
}

function deletionRequestMessage(request: PermanentDeletionRequest) {
  if (request.status === 'conflict') return 'This tracker changed on another device. Resolve the account issue before trying again.'
  if (request.status === 'pending' && !request.lastError) return 'Deletion is waiting to finish.'
  if (request.status === 'pending') return 'Deletion could not be confirmed. Reconnect and try again.'
  if (request.winsRetention === 'delete_wins') return 'Delete Tracker and Wins could not be completed safely. Nothing was deleted. Choose Keep My Wins or try again later.'
  return 'Deletion could not be completed. Your tracker is still in the Bin. Please try again.'
}

export function TrackerBinPage() {
  const { notify } = useToast()
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending, syncNow, isOnline } = useAuth()
  const permanentDeletionEnabled = isPermanentDeletionEnabled()
  const owner = status === 'signed-in' ? user?.id ?? null : null
  const ready = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === owner
  const workspaceKey = ready ? owner ?? 'guest' : null
  const workspaceRef = useRef({ key: workspaceKey, ready })
  workspaceRef.current = { key: workspaceKey, ready }
  const [snapshot, setSnapshot] = useState<{ key: string; trackers: StoredTrackerDefinition[]; pendingRestores: PendingTrackerRestore[]; requests: PermanentDeletionRequest[] } | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pendingPermanentDeletion, setPendingPermanentDeletion] = useState<StoredTrackerDefinition | null>(null)
  const [winsRetention, setWinsRetention] = useState<TrackerWinsRetention>('keep_wins')
  const trackers = snapshot?.key === workspaceKey ? snapshot.trackers : []
  const pendingRestores = snapshot?.key === workspaceKey ? snapshot.pendingRestores : []
  const requests = snapshot?.key === workspaceKey ? snapshot.requests : []
  const loading = !ready || Boolean(workspaceKey && snapshot?.key !== workspaceKey)

  const refresh = useCallback(async () => {
    const context = workspaceRef.current
    if (!context.ready || !context.key) return
    try {
      const [items, restores, pending] = await Promise.all([
        localRepository.listDeletedTrackers(),
        context.key === 'guest' ? Promise.resolve([]) : localRepository.listPendingTrackerRestores(context.key),
        context.key === 'guest' ? Promise.resolve([]) : localRepository.listPermanentDeletionRequests(context.key),
      ])
      if (workspaceRef.current.ready && workspaceRef.current.key === context.key) {
        setSnapshot({ key: context.key, trackers: items, pendingRestores: restores, requests: pending })
        setError('')
      }
    } catch {
      if (workspaceRef.current.ready && workspaceRef.current.key === context.key) setError('The Bin could not be loaded. Your saved data is unchanged.')
    }
  }, [])

  useEffect(() => {
    if (!ready || !workspaceKey) return
    void refresh()
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => { window.clearInterval(timer) }
  }, [owner, ready, refresh, workspaceKey])
  useWorkspaceDataChanges(owner, ready, refresh)

  async function restore(tracker: StoredTrackerDefinition) {
    setBusyId(tracker.id); setError('')
    try { await localRepository.restoreTracker(tracker.id); await refresh(); notify({ kind: 'success', title: 'Tracker restored', description: tracker.status === 'archived' ? 'It is back in Archived with its saved history.' : 'It is active again with its saved history.', dedupeKey: `tracker:${tracker.id}` }) }
    catch { notify({ kind: 'error', title: 'Couldn’t restore tracker', description: 'Your tracker is still in the Bin. Please try again.', duration: 0, dedupeKey: `tracker:${tracker.id}` }) }
    finally { setBusyId(null) }
  }

  function openPermanentDeletion(tracker: StoredTrackerDefinition) {
    setWinsRetention('keep_wins')
    setPendingPermanentDeletion(tracker)
  }

  async function permanentlyDelete(tracker: StoredTrackerDefinition, retention: TrackerWinsRetention) {
    setBusyId(tracker.id); setError('')
    const dedupeKey = permanentDeletionNotificationKey(owner ?? 'guest', tracker.id)
    try {
      const result = await localRepository.requestPermanentDeletion(tracker.id, retention)
      if (result === 'queued') {
        await refresh()
        if (isOnline) void syncNow().catch(() => undefined)
      } else { await refresh(); notify({ kind: 'success', title: 'Tracker permanently deleted.', duration: 4000, dedupeKey }) }
    } catch { notify({ kind: 'error', title: 'Couldn’t request permanent deletion', description: 'Your tracker is unchanged. Check your connection and try again.', duration: 0, dedupeKey }) }
    finally { setBusyId(null) }
  }

  return <section className="tracker-page bin-page" aria-labelledby="bin-title">
    <PageHeader headingId="bin-title" eyebrow="A SECOND CHANCE" title="The Bin" description={binDescription(permanentDeletionEnabled)} help={{ title: 'The Bin', summary: 'Restore a tracker or permanently delete it.', description: 'Moving a tracker here keeps its saved progress and rewards. Restore it to use it again. Permanent deletion cannot be undone; choose whether to keep or remove its Wins.' }} action={<Link className="button button-secondary button-medium" to="/trackers">Back to trackers</Link>} />
    {owner && !permanentDeletionEnabled && <p className="bin-system-note" role="status" data-ai-capability="bin.permanent_delete" data-ai-availability="disabled">Permanent deletion isn’t available in this app version. You can restore trackers during their 30-day recovery period.</p>}
    {owner && permanentDeletionEnabled && !isOnline && <p className="bin-system-note" role="status">You’re offline. Permanent deletion will finish when you reconnect.</p>}
    {error && <p className="form-alert" role="alert">{error}</p>}
    {loading ? <p role="status" className="tracker-loading">Opening your Bin…</p> : trackers.length === 0 && pendingRestores.length === 0 ? <Surface><EmptyState icon={<AppIcon name="bin" className="empty-state-svg-icon" />} title="Your Bin is empty" description="Trackers you move here can be restored during recovery or permanently deleted." action={<Link className="button button-primary button-medium" to="/trackers">View trackers</Link>} /></Surface> : <div className="tracker-card-grid">
      {pendingRestores.map(({ tracker, status: restoreStatus }) => <Surface className="bin-card bin-restore-pending" key={`restore:${tracker.id}`}>
        <div className="tracker-card-top"><span className="tracker-kind-chip">{kindLabel[tracker.kind]}</span><span className="bin-countdown" data-state={restoreStatus}>{restoreStatus === 'attention' ? 'Restore needs attention' : 'Restore in progress'}</span></div>
        <h2>{tracker.name}</h2>
        <p>Your saved progress and plan are preserved while the restore finishes.</p>
        <p className="bin-pending" role="status">{restoreStatus === 'pending' ? isOnline ? 'Restore is waiting to finish. The tracker stays unavailable until it does.' : 'You’re offline. Restore will finish when you reconnect; the tracker stays unavailable until then.' : 'Restore needs attention. Your tracker and progress are still saved.'}</p>
        {restoreStatus === 'attention' && <p className="bin-restore-help">Review your account status in <Link to="/auth">Account and sync</Link> before trying again.</p>}
      </Surface>)}
      {trackers.map((tracker) => {
        const request = requests.find((item) => item.trackerId === tracker.id)
        const requestBlocked = Boolean(request && (request.status === 'pending' || request.status === 'conflict'))
        const expired = now >= Date.parse(tracker.deletedAt!) + recoveryMs
        const guestExpired = expired && !owner
        return <Surface className="bin-card" key={tracker.id}>
          <div className="tracker-card-top"><span className="tracker-kind-chip">{kindLabel[tracker.kind]}</span><span className="tracker-kind-chip">Was {tracker.status === 'archived' ? 'Archived' : 'Active'}</span><span className={expired ? 'bin-countdown expired' : 'bin-countdown'}>{recoveryLabel(tracker.deletedAt!, now, Boolean(owner))}</span></div>
          <h2>{tracker.name}</h2>
          <p>Moved to Bin {new Date(tracker.deletedAt!).toLocaleString()} · {tracker.metrics.length} {tracker.metrics.length === 1 ? 'measure' : 'measures'} · progress and planning are preserved</p>
          {request && <p className="bin-pending" role={request.status === 'failed' || request.status === 'conflict' ? 'alert' : 'status'}>{deletionRequestMessage(request)}</p>}
          <div className="tracker-card-actions">
            <Button data-ai-capability="bin.restore" variant="secondary" size="small" disabled={Boolean(busyId) || guestExpired || requestBlocked} onClick={() => void restore(tracker)}>{guestExpired ? 'Recovery ended' : expired ? 'Check recovery status' : busyId === tracker.id ? 'Working…' : 'Restore'}</Button>
            {permanentDeletionEnabled && <Button data-ai-capability="bin.permanent_delete" data-ai-availability="available" variant="destructive" size="small" aria-busy={busyId === tracker.id} disabled={Boolean(busyId) || requestBlocked} onClick={() => openPermanentDeletion(tracker)}>{request?.status === 'pending' ? 'Deletion in progress' : request?.status === 'conflict' ? 'Resolve account issue' : busyId === tracker.id ? 'Deleting…' : 'Permanently Delete'}</Button>}
          </div>
        </Surface>
      })}
    </div>}
    {pendingPermanentDeletion && <ConfirmActionDialog
      className="tracker-deletion-dialog"
      title={`Permanently Delete “${pendingPermanentDeletion.name}”?`}
      description="This cannot be undone. Choose what happens to this tracker’s Wins."
      actionLabel="Permanently Delete" destructive
      onCancel={() => setPendingPermanentDeletion(null)}
      onConfirm={() => { const tracker = pendingPermanentDeletion; const retention = winsRetention; setPendingPermanentDeletion(null); void permanentlyDelete(tracker, retention) }}
    >
      <fieldset className="tracker-deletion-choice">
        <legend>Choose what happens to its Wins</legend>
        <label>
          <input type="radio" name="tracker-wins-retention" value="keep_wins" checked={winsRetention === 'keep_wins'} onChange={() => setWinsRetention('keep_wins')} />
          <span><strong>Keep My Wins</strong><small>Permanently removes the tracker and its activity. Keeps your XP, badges, achievements, and reward history with appropriate tracker context.</small></span>
        </label>
        <label>
          <input type="radio" name="tracker-wins-retention" value="delete_wins" checked={winsRetention === 'delete_wins'} onChange={() => setWinsRetention('delete_wins')} />
          <span><strong>Delete Tracker and Wins</strong><small>Permanently removes the tracker and its activity. Reverses only rewards linked to this tracker; other rewards and achievements stay. If rewards can’t be safely separated, nothing will be deleted.</small></span>
        </label>
      </fieldset>
    </ConfirmActionDialog>}
  </section>
}
