import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { useToast } from '../../components/ui/ToastProvider'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { AppIcon } from '../../components/ui/AppIcon'
import { localRepository } from '../../db/localRepository'
import type { PermanentDeletionRequest, StoredTrackerDefinition } from '../../db/models'
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

export function TrackerBinPage() {
  const { notify } = useToast()
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending, syncNow, isOnline } = useAuth()
  const permanentDeletionEnabled = isPermanentDeletionEnabled()
  const owner = status === 'signed-in' ? user?.id ?? null : null
  const ready = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === owner
  const workspaceKey = ready ? owner ?? 'guest' : null
  const workspaceRef = useRef({ key: workspaceKey, ready })
  workspaceRef.current = { key: workspaceKey, ready }
  const [snapshot, setSnapshot] = useState<{ key: string; trackers: StoredTrackerDefinition[]; requests: PermanentDeletionRequest[] } | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pendingPermanentDeletion, setPendingPermanentDeletion] = useState<StoredTrackerDefinition | null>(null)
  const trackers = snapshot?.key === workspaceKey ? snapshot.trackers : []
  const requests = snapshot?.key === workspaceKey ? snapshot.requests : []
  const loading = !ready || Boolean(workspaceKey && snapshot?.key !== workspaceKey)

  const refresh = useCallback(async () => {
    const context = workspaceRef.current
    if (!context.ready || !context.key) return
    try {
      const [items, pending] = await Promise.all([
        localRepository.listDeletedTrackers(),
        context.key === 'guest' ? Promise.resolve([]) : localRepository.listPermanentDeletionRequests(context.key),
      ])
      if (workspaceRef.current.ready && workspaceRef.current.key === context.key) {
        setSnapshot({ key: context.key, trackers: items, requests: pending })
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
    try { await localRepository.restoreTracker(tracker.id); await refresh(); notify({ kind: 'success', title: 'Tracker restored', description: 'It is active again with its saved history.', dedupeKey: `tracker:${tracker.id}` }) }
    catch { notify({ kind: 'error', title: 'Couldn’t restore tracker', description: 'Your data is unchanged. Please try again.', duration: 0, dedupeKey: `tracker:${tracker.id}` }) }
    finally { setBusyId(null) }
  }

  async function permanentlyDelete(tracker: StoredTrackerDefinition) {
    setBusyId(tracker.id); setError('')
    const dedupeKey = permanentDeletionNotificationKey(owner ?? 'guest', tracker.id)
    try {
      const result = await localRepository.requestPermanentDeletion(tracker.id)
      if (result === 'queued') {
        await refresh()
        if (isOnline) void syncNow().catch(() => undefined)
      } else { await refresh(); notify({ kind: 'success', title: 'Tracker permanently deleted.', duration: 4000, dedupeKey }) }
    } catch { notify({ kind: 'error', title: 'Couldn’t request permanent deletion', description: 'Your tracker is unchanged. Check your connection and try again.', duration: 0, dedupeKey }) }
    finally { setBusyId(null) }
  }

  return <section className="tracker-page bin-page" aria-labelledby="bin-title">
    <PageHeader headingId="bin-title" eyebrow="A SECOND CHANCE" title="The Bin" description={permanentDeletionEnabled ? 'Restore a deleted tracker during its 30-day recovery period, or permanently delete it at any time. Trackers are not automatically removed after 30 days.' : 'Deleted trackers can be restored for 30 days. Automatic cleanup is not configured, and permanent deletion isn’t available in this app version.'} help={{ title: 'The Bin', summary: 'Restore a deleted tracker during its 30-day recovery period.', description: 'A tracker in the Bin retains its saved progress and planning data until restored or permanently deleted. The countdown starts from the server-confirmed deletion time for signed-in accounts. Permanent deletion removes the tracker and its history from all synchronized devices; an offline request remains pending until the server confirms it.' }} action={<Link className="button button-secondary button-medium" to="/trackers">Back to trackers</Link>} />
    {owner && !permanentDeletionEnabled && <p className="bin-system-note" role="status" data-ai-capability="bin.permanent_delete" data-ai-availability="disabled">Permanent deletion isn’t available in this app version. You can restore trackers during their 30-day recovery period.</p>}
    {owner && permanentDeletionEnabled && !isOnline && <p className="bin-system-note" role="status">You’re offline. Permanent deletion requests will remain pending until the server confirms them.</p>}
    {error && <p className="form-alert" role="alert">{error}</p>}
    {loading ? <p role="status" className="tracker-loading">Opening your Bin…</p> : trackers.length === 0 ? <Surface><EmptyState icon={<AppIcon name="bin" className="empty-state-svg-icon" />} title="Your Bin is empty" description="When you delete a tracker, it will appear here with 30 days to restore it." action={<Link className="button button-primary button-medium" to="/trackers">View trackers</Link>} /></Surface> : <div className="tracker-card-grid">
      {trackers.map((tracker) => {
        const request = requests.find((item) => item.trackerId === tracker.id)
        const requestBlocked = Boolean(request && (request.status === 'pending' || request.status === 'conflict'))
        const expired = now >= Date.parse(tracker.deletedAt!) + recoveryMs
        const guestExpired = expired && !owner
        return <Surface className="bin-card" key={tracker.id}>
          <div className="tracker-card-top"><span className="tracker-kind-chip">{kindLabel[tracker.kind]}</span><span className={expired ? 'bin-countdown expired' : 'bin-countdown'}>{recoveryLabel(tracker.deletedAt!, now, Boolean(owner))}</span></div>
          <h2>{tracker.name}</h2>
          <p>{tracker.metrics.length} {tracker.metrics.length === 1 ? 'measure' : 'measures'} · progress and planning are preserved</p>
          {request && <p className="bin-pending" role="status">{request.status === 'pending' && !request.lastError ? 'Permanent deletion pending server confirmation.' : request.status === 'pending' ? `Deletion not confirmed; it will retry when sync runs. ${request.lastError}` : request.lastError ?? 'Deletion needs attention.'}</p>}
          <div className="tracker-card-actions">
            <Button data-ai-capability="bin.restore" variant="secondary" size="small" disabled={Boolean(busyId) || guestExpired || requestBlocked} onClick={() => void restore(tracker)}>{guestExpired ? 'Recovery ended' : expired ? 'Check recovery status' : busyId === tracker.id ? 'Working…' : 'Restore'}</Button>
            {permanentDeletionEnabled && <Button data-ai-capability="bin.permanent_delete" data-ai-availability="available" variant="destructive" size="small" aria-busy={busyId === tracker.id} disabled={Boolean(busyId) || requestBlocked} onClick={() => setPendingPermanentDeletion(tracker)}>{request?.status === 'pending' ? 'Deletion pending' : request?.status === 'conflict' ? 'Resolve sync conflict' : busyId === tracker.id ? 'Deleting…' : 'Permanently delete'}</Button>}
          </div>
        </Surface>
      })}
    </div>}
    {pendingPermanentDeletion && <ConfirmActionDialog title={`Delete “${pendingPermanentDeletion.name}” permanently?`} description="This permanently removes the tracker and all associated check-ins, measure progress, notes, and planning data. It cannot be restored. For a signed-in account, removal waits for server confirmation and applies across synchronized devices." actionLabel="Delete permanently" destructive onCancel={() => setPendingPermanentDeletion(null)} onConfirm={() => { const tracker = pendingPermanentDeletion; setPendingPermanentDeletion(null); void permanentlyDelete(tracker) }} />}
  </section>
}
