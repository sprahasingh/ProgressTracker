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
import { isAutomaticBinCleanupEnabled, isPermanentDeletionEnabled } from '../../domain/trackers/schemaVersionGate'
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

function binDescription(automaticCleanupEnabled: boolean, permanentDeletionEnabled: boolean) {
  if (automaticCleanupEnabled) return 'Scheduled cleanup permanently removes eligible tracker data after 30 days and keeps its recorded name and reward context in Wins. You can restore trackers during recovery.'
  if (permanentDeletionEnabled) return 'Restore a deleted tracker during its 30-day recovery period, or choose what happens to its Wins when you permanently delete it. Automatic deletion after 30 days is not configured.'
  return 'Deleted trackers can be restored for 30 days. Automatic cleanup is not configured, and permanent deletion isn’t available in this app version.'
}

export function TrackerBinPage() {
  const { notify } = useToast()
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending, syncNow, isOnline } = useAuth()
  const permanentDeletionEnabled = isPermanentDeletionEnabled()
  const automaticCleanupEnabled = isAutomaticBinCleanupEnabled()
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
    catch { notify({ kind: 'error', title: 'Couldn’t restore tracker', description: 'Your data is unchanged. Please try again.', duration: 0, dedupeKey: `tracker:${tracker.id}` }) }
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
    <PageHeader headingId="bin-title" eyebrow="A SECOND CHANCE" title="The Bin" description={binDescription(automaticCleanupEnabled, permanentDeletionEnabled)} help={{ title: 'The Bin', summary: automaticCleanupEnabled ? 'Scheduled cleanup attempts to permanently delete eligible Bin items after 30 days and preserves recorded tracker names and reward context in Wins.' : 'Restore a deleted tracker during its 30-day recovery period.', description: `A tracker in the Bin retains its saved progress and planning data until it is restored or deletion is confirmed. The countdown starts from the server-confirmed deletion time for signed-in accounts. Manual Delete Wins is refused when the account has reconstructed, shared, goal-linked, achievement, or unattributed rewards that cannot be reversed exactly. Keep my Wins history retains recorded tracker names and reward reasons in a separate historical context record; tracker and activity data are deleted. It does not retain notes, entries, or tracker identifiers. If scheduled cleanup is configured, it uses Keep my Wins history. An offline deletion request remains pending until the server confirms it.` }} action={<Link className="button button-secondary button-medium" to="/trackers">Back to trackers</Link>} />
    {owner && !permanentDeletionEnabled && <p className="bin-system-note" role="status" data-ai-capability="bin.permanent_delete" data-ai-availability="disabled">Permanent deletion isn’t available in this app version. You can restore trackers during their 30-day recovery period.</p>}
    {owner && permanentDeletionEnabled && !isOnline && <p className="bin-system-note" role="status">You’re offline. Permanent deletion requests will remain pending until the server confirms them.</p>}
    {error && <p className="form-alert" role="alert">{error}</p>}
    {loading ? <p role="status" className="tracker-loading">Opening your Bin…</p> : trackers.length === 0 && pendingRestores.length === 0 ? <Surface><EmptyState icon={<AppIcon name="bin" className="empty-state-svg-icon" />} title="Your Bin is empty" description="When you delete a tracker, it will appear here with 30 days to restore it." action={<Link className="button button-primary button-medium" to="/trackers">View trackers</Link>} /></Surface> : <div className="tracker-card-grid">
      {pendingRestores.map(({ tracker, status: restoreStatus, message }) => <Surface className="bin-card bin-restore-pending" key={`restore:${tracker.id}`}>
        <div className="tracker-card-top"><span className="tracker-kind-chip">{kindLabel[tracker.kind]}</span><span className="bin-countdown" data-state={restoreStatus}>{restoreStatus === 'attention' ? 'Restore needs attention' : 'Restore pending verification'}</span></div>
        <h2>{tracker.name}</h2>
        <p>This tracker is saved on this device. Its activity and planning data are preserved while the server checks the restoration.</p>
        <p className="bin-pending" role="status">{restoreStatus === 'pending' && !isOnline ? 'You’re offline. This restoration is saved locally and will wait for server confirmation when you reconnect. The tracker remains unavailable until then.' : message}</p>
        {restoreStatus === 'attention' && <p className="bin-restore-help">Resolve this tracker’s sync issue in <Link to="/auth">Sync &amp; account</Link>. It will remain unavailable until the server confirms the restore.</p>}
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
          {request && <p className="bin-pending" role="status">{request.status === 'pending' && !request.lastError ? 'Permanent deletion pending server confirmation.' : request.status === 'pending' ? `Deletion not confirmed; it will retry when sync runs. ${request.lastError}` : request.lastError ?? 'Deletion needs attention.'}</p>}
          <div className="tracker-card-actions">
            <Button data-ai-capability="bin.restore" variant="secondary" size="small" disabled={Boolean(busyId) || guestExpired || requestBlocked} onClick={() => void restore(tracker)}>{guestExpired ? 'Recovery ended' : expired ? 'Check recovery status' : busyId === tracker.id ? 'Working…' : 'Restore'}</Button>
            {permanentDeletionEnabled && <Button data-ai-capability="bin.permanent_delete" data-ai-availability="available" variant="destructive" size="small" aria-busy={busyId === tracker.id} disabled={Boolean(busyId) || requestBlocked} onClick={() => openPermanentDeletion(tracker)}>{request?.status === 'pending' ? 'Deletion pending' : request?.status === 'conflict' ? 'Resolve sync conflict' : busyId === tracker.id ? 'Deleting…' : 'Permanently delete'}</Button>}
          </div>
        </Surface>
      })}
    </div>}
    {pendingPermanentDeletion && <ConfirmActionDialog
      title={`Delete “${pendingPermanentDeletion.name}” permanently?`}
      description="This erases the tracker and its saved activity irreversibly. Choose how its Wins should be handled. The server will leave everything unchanged if it cannot safely apply your choice."
      actionLabel="Permanently delete tracker" destructive
      onCancel={() => setPendingPermanentDeletion(null)}
      onConfirm={() => { const tracker = pendingPermanentDeletion; const retention = winsRetention; setPendingPermanentDeletion(null); void permanentlyDelete(tracker, retention) }}
    >
      <fieldset className="tracker-deletion-choice">
        <legend>Wins history after deletion</legend>
        <label>
          <input type="radio" name="tracker-wins-retention" value="keep_wins" checked={winsRetention === 'keep_wins'} onChange={() => setWinsRetention('keep_wins')} />
          <span><strong>Keep my Wins history</strong><small>Your earned XP and achievements remain in your history, including the tracker name and what each reward was earned for. The tracker and its activity data are permanently deleted.</small></span>
        </label>
        <label>
          <input type="radio" name="tracker-wins-retention" value="delete_wins" checked={winsRetention === 'delete_wins'} onChange={() => setWinsRetention('delete_wins')} />
          <span><strong>Delete tracker and its Wins history</strong><small>The tracker, its activity data, and safely attributable rewards are removed. Your level or badge progress may decrease. Reconstructed XP, shared rewards, and unsupported achievement history cannot be reversed, so the server may refuse this option without deleting anything.</small></span>
        </label>
      </fieldset>
    </ConfirmActionDialog>}
  </section>
}
