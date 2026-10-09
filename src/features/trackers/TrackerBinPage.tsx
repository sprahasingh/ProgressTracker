import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { PermanentDeletionRequest, StoredTrackerDefinition } from '../../db/models'
import { isPermanentDeletionEnabled } from '../../domain/trackers/schemaVersionGate'
import { subscribeToWorkspaceMutations } from '../../db/workspaceMutationEvents'
import { useAuth } from '../auth/AuthProvider'

const recoveryMs = 30 * 24 * 60 * 60 * 1000
const kindLabel = { habit: 'Habit', goal: 'Goal', challenge: 'Challenge', project: 'Project' }

function recoveryLabel(deletedAt: string, now: number, accountOwned: boolean) {
  const remaining = Date.parse(deletedAt) + recoveryMs - now
  if (remaining <= 0) return accountOwned ? 'Local estimate passed · reconnect to verify recovery status' : 'Recovery period ended · local cleanup pending'
  const days = Math.ceil(remaining / (24 * 60 * 60 * 1000))
  const deadline = new Date(Date.parse(deletedAt) + recoveryMs)
  return `${days} ${days === 1 ? 'day' : 'days'} left · eligible ${deadline.toLocaleDateString(undefined, { dateStyle: 'medium' })}`
}

export function TrackerBinPage() {
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending, syncNow, isOnline } = useAuth()
  const owner = status === 'signed-in' ? user?.id ?? null : null
  const ready = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === owner
  const workspaceKey = ready ? owner ?? 'guest' : null
  const workspaceRef = useRef({ key: workspaceKey, ready })
  workspaceRef.current = { key: workspaceKey, ready }
  const [snapshot, setSnapshot] = useState<{ key: string; trackers: StoredTrackerDefinition[]; requests: PermanentDeletionRequest[] } | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [busyId, setBusyId] = useState<string | null>(null)
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
    const unsubscribe = subscribeToWorkspaceMutations((changedOwner) => { if (changedOwner === owner) void refresh() })
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => { unsubscribe(); window.clearInterval(timer) }
  }, [owner, ready, refresh, workspaceKey])

  async function restore(tracker: StoredTrackerDefinition) {
    setBusyId(tracker.id); setError('')
    try { await localRepository.restoreTracker(tracker.id); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Restore failed. Your data is unchanged.') }
    finally { setBusyId(null) }
  }

  async function permanentlyDelete(tracker: StoredTrackerDefinition) {
    const scope = owner ? 'from this account and every synchronized device' : 'from this guest workspace on this device'
    if (!window.confirm(`Permanently delete “${tracker.name}” ${scope}? Its tracker, full progress history, and planning data will be erased and cannot be recovered.`)) return
    setBusyId(tracker.id); setError('')
    try {
      const result = await localRepository.requestPermanentDeletion(tracker.id)
      if (result === 'queued') {
        await refresh()
        if (isOnline) void syncNow().catch(() => undefined)
      } else await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Permanent deletion could not be requested. Your data is unchanged.') }
    finally { setBusyId(null) }
  }

  return <section className="tracker-page bin-page" aria-labelledby="bin-title">
    <PageHeader headingId="bin-title" eyebrow="A SECOND CHANCE" title="The Bin" description="Deleted trackers stay here for 30 days. Restore one to bring back its complete progress and plan." action={<Link className="button button-secondary button-medium" to="/trackers">Back to trackers</Link>} />
    {owner && !isPermanentDeletionEnabled() && <p className="bin-system-note" role="status">Permanent deletion is locked until the hosted database migration and scheduled cleanup have been verified.</p>}
    {owner && isPermanentDeletionEnabled() && !isOnline && <p className="bin-system-note" role="status">You’re offline. Permanent deletion requests will remain pending until the server confirms them.</p>}
    {error && <p className="form-alert" role="alert">{error}</p>}
    {loading ? <p role="status" className="tracker-loading">Opening your Bin…</p> : trackers.length === 0 ? <Surface><EmptyState title="Your Bin is empty" description="When you delete a tracker, it will appear here with 30 days to restore it." action={<Link className="button button-primary button-medium" to="/trackers">View trackers</Link>} /></Surface> : <div className="tracker-card-grid">
      {trackers.map((tracker) => {
        const request = requests.find((item) => item.trackerId === tracker.id)
        const expired = now >= Date.parse(tracker.deletedAt!) + recoveryMs
        const guestExpired = expired && !owner
        return <Surface className="bin-card" key={tracker.id}>
          <div className="tracker-card-top"><span className="tracker-kind-chip">{kindLabel[tracker.kind]}</span><span className={expired ? 'bin-countdown expired' : 'bin-countdown'}>{recoveryLabel(tracker.deletedAt!, now, Boolean(owner))}</span></div>
          <h2>{tracker.name}</h2>
          <p>{tracker.metrics.length} {tracker.metrics.length === 1 ? 'measure' : 'measures'} · progress and planning are preserved</p>
          {request && <p className="bin-pending" role="status">{request.status === 'pending' ? 'Permanent deletion pending server confirmation.' : request.lastError ?? 'Deletion needs attention.'}</p>}
          <div className="tracker-card-actions">
            <Button variant="secondary" size="small" disabled={Boolean(busyId) || guestExpired || Boolean(request && request.status === 'pending')} onClick={() => void restore(tracker)}>{guestExpired ? 'Recovery ended' : expired ? 'Check recovery status' : busyId === tracker.id ? 'Working…' : 'Restore'}</Button>
            {isPermanentDeletionEnabled() && <Button variant="secondary" className="bin-delete-button" size="small" disabled={Boolean(busyId) || Boolean(request && request.status === 'pending')} onClick={() => void permanentlyDelete(tracker)}>{request?.status === 'pending' ? 'Deletion pending' : 'Permanently delete'}</Button>}
          </div>
        </Surface>
      })}
    </div>}
  </section>
}
