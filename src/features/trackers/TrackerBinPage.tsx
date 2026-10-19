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
  if (request.status === 'pending' && !request.lastError) return 'Deletion is saved on this device and waiting for server confirmation.'
  if (request.status === 'pending' && request.lastError?.startsWith('Waiting for tracker sync:')) return 'Deletion is queued. Rejected configuration will be skipped, and the request will use the latest cloud revision. Your original Wins choice is saved.'
  if (request.status === 'pending') return `${request.lastError} Your deletion request and original Wins choice are saved.`
  if (isRejectedWinsAttributionPolicy(request)) return 'Some past rewards can’t be reliably linked to this tracker. You can still permanently delete the tracker while keeping your Wins.'
  if (request.lastError) return request.lastError
  return 'Deletion needs confirmation again. The saved Wins choice will be retained.'
}

function isRejectedWinsAttributionPolicy(request: PermanentDeletionRequest) {
  return request.status === 'failed' && request.winsRetention === 'delete_wins'
    && /server rejected the selected Wins policy:.*(reconstructed, incomplete, or unattributed rewards|cannot be removed safely)/i.test(request.lastError ?? '')
}

export function TrackerBinPage() {
  const { notify } = useToast()
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending, syncNow, isOnline, syncStatus } = useAuth()
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
  const [recoveringRejectedPolicy, setRecoveringRejectedPolicy] = useState(false)
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
    setRecoveringRejectedPolicy(false)
    setWinsRetention(requests.find((request) => request.trackerId === tracker.id)?.winsRetention ?? 'keep_wins')
    setPendingPermanentDeletion(tracker)
  }

  function openKeepWinsRecovery(tracker: StoredTrackerDefinition) {
    setRecoveringRejectedPolicy(true)
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
        const expired = now >= Date.parse(tracker.deletedAt!) + recoveryMs
        const guestExpired = expired && !owner
        return <Surface className="bin-card" key={tracker.id}>
          <div className="tracker-card-top"><span className="tracker-kind-chip">{kindLabel[tracker.kind]}</span><span className="tracker-kind-chip">Was {tracker.status === 'archived' ? 'Archived' : 'Active'}</span><span className={expired ? 'bin-countdown expired' : 'bin-countdown'}>{recoveryLabel(tracker.deletedAt!, now, Boolean(owner))}</span></div>
          <h2>{tracker.name}</h2>
          <p>Moved to Bin {new Date(tracker.deletedAt!).toLocaleString()} · {tracker.metrics.length} {tracker.metrics.length === 1 ? 'measure' : 'measures'} · progress and planning are preserved</p>
          {request && <p className="bin-pending" role={request.status === 'pending' ? 'status' : 'alert'}>{request.status === 'pending' && syncStatus === 'syncing' ? 'Deleting… waiting for server confirmation.' : request.status === 'pending' && !isOnline ? `Deletion is saved on this device and will be sent when you reconnect. ${deletionRequestMessage(request)}` : deletionRequestMessage(request)}</p>}
          {request?.lastError && <details className="bin-deletion-diagnostics"><summary>Deletion details</summary><p>{request.lastError}</p></details>}
          {request && isRejectedWinsAttributionPolicy(request) && <Button variant="secondary" size="small" disabled={Boolean(busyId)} onClick={() => openKeepWinsRecovery(tracker)}>Delete tracker, keep Wins</Button>}
          {request && request.status !== 'pending' && !isRejectedWinsAttributionPolicy(request) && <Button variant="secondary" size="small" disabled={Boolean(busyId) || !isOnline} onClick={() => openPermanentDeletion(tracker)}>Review and retry deletion</Button>}
          <div className="tracker-card-actions">
            <Button data-ai-capability="bin.restore" variant="secondary" size="small" disabled={Boolean(busyId) || guestExpired || Boolean(request)} onClick={() => void restore(tracker)}>{guestExpired ? 'Recovery ended' : expired ? 'Check recovery status' : busyId === tracker.id ? 'Working…' : 'Restore'}</Button>
            {permanentDeletionEnabled && !request && <Button data-ai-capability="bin.permanent_delete" data-ai-availability="available" variant="destructive" size="small" aria-busy={busyId === tracker.id} disabled={Boolean(busyId)} onClick={() => openPermanentDeletion(tracker)}>{busyId === tracker.id ? 'Deleting…' : 'Permanently Delete'}</Button>}
          </div>
        </Surface>
      })}
    </div>}
    {pendingPermanentDeletion && <ConfirmActionDialog
      className="tracker-deletion-dialog tracker-rule-application-dialog"
      backdropClassName="tracker-rule-application-backdrop"
      title={recoveringRejectedPolicy ? 'Can’t remove Wins safely' : `Permanently Delete “${pendingPermanentDeletion.name}”?`}
      description={recoveringRejectedPolicy
        ? 'Some past rewards can’t be reliably linked to this tracker. You can still permanently delete the tracker while keeping your Wins.'
        : 'This is permanent. Unsynced changes and all tracker-owned history, including measures, goals, check-ins, journals, and rule history, may be lost. Deletion will be saved offline and sent when you reconnect. Choose what happens to this tracker’s Wins.'}
      actionLabel={recoveringRejectedPolicy ? 'Delete tracker, keep Wins' : 'Permanently Delete'} destructive
      showCloseButton
      onCancel={() => { setPendingPermanentDeletion(null); setRecoveringRejectedPolicy(false) }}
      onConfirm={() => { const tracker = pendingPermanentDeletion; const retention = winsRetention; setPendingPermanentDeletion(null); setRecoveringRejectedPolicy(false); void permanentlyDelete(tracker, retention) }}
    >
      {recoveringRejectedPolicy ? <p className="tracker-deletion-recovery-note">The rejected Delete Wins request has stopped. Confirming creates a new Keep My Wins request. Your tracker and history stay in the Bin until the server confirms deletion.</p> : <fieldset className="tracker-deletion-choice">
        <legend>Choose what happens to its Wins</legend>
        {requests.some((request) => request.trackerId === pendingPermanentDeletion.id) && <p role="status">The original Wins choice is locked for this saved deletion request.</p>}
        <label>
          <input type="radio" name="tracker-wins-retention" value="keep_wins" checked={winsRetention === 'keep_wins'} disabled={requests.some((request) => request.trackerId === pendingPermanentDeletion.id)} onChange={() => setWinsRetention('keep_wins')} />
          <span><strong>Keep My Wins</strong><small>Permanently removes the tracker and its activity. Keeps your XP, badges, achievements, and reward history with appropriate tracker context.</small></span>
        </label>
        <label>
          <input type="radio" name="tracker-wins-retention" value="delete_wins" checked={winsRetention === 'delete_wins'} disabled={requests.some((request) => request.trackerId === pendingPermanentDeletion.id)} onChange={() => setWinsRetention('delete_wins')} />
          <span><strong>Delete Tracker and Wins</strong><small>Permanently removes the tracker and its activity. Reverses only rewards linked to this tracker; other rewards and achievements stay. If rewards can’t be safely separated, nothing will be deleted.</small></span>
        </label>
      </fieldset>}
    </ConfirmActionDialog>}
  </section>
}
