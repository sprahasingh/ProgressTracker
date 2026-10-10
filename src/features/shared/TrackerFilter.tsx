import { useEffect, useState } from 'react'
import type { TrackerDefinition } from '../../domain/trackers/types'

function readFilter(key: string): string | null {
  try { return window.sessionStorage.getItem(key) } catch { return null }
}

export function useTrackerFilter(workspaceId: string | null, trackers: readonly TrackerDefinition[], ready: boolean) {
  const key = `progress-tracker-filter:${workspaceId ?? 'guest'}`
  const [stored, setStored] = useState<{ key: string; id: string | null }>(() => ({ key, id: readFilter(key) }))
  const selectedId = stored.key === key ? stored.id : null
  useEffect(() => {
    if (stored.key !== key) setStored({ key, id: readFilter(key) })
  }, [key, stored.key])
  useEffect(() => {
    if (!ready || selectedId === null || trackers.some((tracker) => tracker.id === selectedId && tracker.deletedAt === null)) return
    try { window.sessionStorage.removeItem(key) } catch { /* Storage may be disabled. */ }
    setStored({ key, id: null })
  }, [key, ready, selectedId, trackers])
  function select(id: string | null) {
    try { if (id) window.sessionStorage.setItem(key, id); else window.sessionStorage.removeItem(key) } catch { /* Keep the filter in memory if storage is unavailable. */ }
    setStored({ key, id })
  }
  return { selectedId, select }
}

export function TrackerFilter({ trackers, selectedId, onChange, label = 'Tracker' }: {
  trackers: readonly TrackerDefinition[]; selectedId: string | null; onChange: (id: string | null) => void; label?: string
}) {
  return <label className="history-filter tracker-filter"><span>{label}</span><select className="auth-input" value={selectedId ?? ''} onChange={(event) => onChange(event.target.value || null)}>
    <option value="">All Trackers</option>
    {trackers.filter((tracker) => tracker.deletedAt === null).map((tracker) => <option key={tracker.id} value={tracker.id}>{tracker.name}</option>)}
  </select></label>
}
