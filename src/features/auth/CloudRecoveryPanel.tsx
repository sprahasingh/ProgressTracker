import { useCallback, useEffect, useMemo, useState } from 'react'
import { Surface } from '../../components/ui/Surface'
import { CloudRecoveryFailure, readCloudRecoverySnapshot, type CloudRecoverySnapshot } from '../../services/supabase/cloudRecovery'

export function CloudRecoveryPanel({ userId, onRetryLocal, operationsPending = false, operationsSettled = false, initializationPending = false }: { userId: string; onRetryLocal: () => void; operationsPending?: boolean; operationsSettled?: boolean; initializationPending?: boolean }) {
  const [snapshot, setSnapshot] = useState<CloudRecoverySnapshot | null>(null)
  const [failure, setFailure] = useState<CloudRecoveryFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const trackerNames = useMemo(() => new Map((snapshot?.trackers ?? []).map(({ record }) => [record.id, record.name])), [snapshot])

  const load = useCallback(async () => {
    setLoading(true)
    setFailure(null)
    setSnapshot(null)
    try {
      const result = await readCloudRecoverySnapshot(userId)
      setSnapshot(result)
    } catch (error) {
      setFailure(error instanceof CloudRecoveryFailure ? error : new CloudRecoveryFailure('unknown'))
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { void load() }, [load])

  return <section className="workspace-gate cloud-recovery" aria-labelledby="cloud-recovery-title">
    <p className="eyebrow">CLOUD RECOVERY · READ ONLY</p>
    <h1 id="cloud-recovery-title">Cloud Recovery — Read Only</h1>
    <p>This view reads tracker definitions and check-ins from your signed-in account. It does not open or change this device’s local database, synchronize changes, or enable editing.</p>
      <p>Offline changes that have not reached the cloud will not appear here. Keep this browser’s site data intact while local access is investigated. This view does not calculate streaks, achievements, or XP awards.</p>
    {operationsPending && <p className="cloud-recovery-freshness" role="status">A {initializationPending ? 'workspace initialization or synchronization' : 'synchronization or device-account transition'} that started before recovery is still running. It has not been cancelled and may finish its already-started operations. This recovery view starts no new synchronization. Keep recovery open; local workspace retry is disabled until the existing operation settles.</p>}
    {!operationsPending && operationsSettled && <p className="cloud-recovery-freshness" role="status">The operation that was already running has settled. This does not confirm that synchronization succeeded; this recovery view did not start or retry it.</p>}
    {snapshot?.schemaCompatibility === 'legacy-no-holiday-treatment' && <p role="status">This cloud database predates explicit holiday-treatment storage. No such values could have been saved in that schema; all other returned check-in fields are shown as stored.</p>}
    <div className="cloud-recovery-actions">
      <button className="button button-secondary button-medium" onClick={() => void load()} disabled={loading}>{loading ? 'Reading cloud snapshot…' : 'Retry cloud read'}</button>
      <button className="button button-primary button-medium" onClick={onRetryLocal} disabled={operationsPending}>Retry local workspace</button>
    </div>
    {failure && <p className="form-alert" role="alert">{failure.message}</p>}
    {loading && <p role="status" className="tracker-loading">Reading your cloud snapshot…</p>}
    {snapshot && <>
      <p className="cloud-recovery-freshness" role="status">Cloud records read at {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(snapshot.retrievedAt))}. This is not a sync watermark or atomic snapshot; server records can change during the read, and this device’s offline changes may be absent.</p>
      {snapshot.trackers.length === 0 && snapshot.entries.length === 0 ? <Surface><p>No tracker or check-in rows were returned by the authenticated cloud read. This does not establish whether this device has unsynchronized local records.</p></Surface> : <>
        <h2>Cloud trackers ({snapshot.trackers.length})</h2>
        {snapshot.trackers.map(({ record: tracker, serverRevision }) => <Surface className="cloud-recovery-record" key={tracker.id}>
          <div className="cloud-recovery-record-heading"><h3>{tracker.name}</h3><span>{tracker.deletedAt ? 'Deleted in cloud' : tracker.status}</span></div>
          <p>Cloud revision {serverRevision}{tracker.deletedAt ? ` · deleted ${tracker.deletedAt}` : ''}</p>
          {tracker.metrics.length > 0 && <ul aria-label={`${tracker.name} measures`}>
            {tracker.metrics.map((metric) => <li key={metric.id}>{metric.name}{metric.unit ? ` · ${metric.unit}` : ''}{'retired' in metric && metric.retired ? ' · retired' : ''}</li>)}
          </ul>}
        </Surface>)}
        <h2>Cloud check-ins ({snapshot.entries.length})</h2>
        {snapshot.entries.length === 0 ? <p>No check-ins were returned for the cloud trackers.</p> : <ol className="cloud-recovery-entry-list">
          {snapshot.entries.map(({ record: entry, serverRevision }) => <li key={entry.id}>
            <Surface className="cloud-recovery-record">
              <div className="cloud-recovery-record-heading"><h3>{trackerNames.get(entry.trackerId) ?? 'Tracker unavailable in this snapshot'}</h3><span>{entry.date}{entry.deletedAt ? ' · deleted' : ''}</span></div>
              <p>{entry.outcome === 'recorded' ? 'Recorded' : 'Skipped'} · cloud revision {serverRevision}</p>
              {Object.keys(entry.values).length > 0 && <dl className="cloud-recovery-values">{Object.entries(entry.values).map(([key, value]) => {
                const metric = snapshot.trackers.find(({ record }) => record.id === entry.trackerId)?.record.metrics.find((item) => item.id === key)
                return <div key={key}><dt>{metric ? `${metric.name}${metric.unit ? ` (${metric.unit})` : ''}` : 'Saved value'}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>
              })}</dl>}
              {entry.note && <p>{entry.note}</p>}
            </Surface>
          </li>)}
        </ol>}
      </>}
    </>}
  </section>
}
