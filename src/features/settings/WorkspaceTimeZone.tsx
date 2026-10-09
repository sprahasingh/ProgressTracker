import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { PageHeader } from '../../components/ui/PageHeader'
import { localRepository } from '../../db/localRepository'

type WorkspaceTimeZoneState = { timeZone: string; setTimeZone: (timeZone: string) => Promise<void> }
const WorkspaceTimeZoneContext = createContext<WorkspaceTimeZoneState | null>(null)

export function WorkspaceTimeZoneProvider({ ownerUserId, children }: { ownerUserId: string | null; children: ReactNode }) {
  const [loaded, setLoaded] = useState<{ ownerUserId: string | null; timeZone: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    setLoaded(null)
    setError('')
    void localRepository.getAppSettings(ownerUserId).then((settings) => {
      if (current) setLoaded({ ownerUserId, timeZone: settings.timezone })
    }).catch(() => {
      if (current) setError('Your workspace settings could not be loaded.')
    })
    return () => { current = false }
  }, [ownerUserId])

  const value = useMemo<WorkspaceTimeZoneState | null>(() => {
    if (!loaded || loaded.ownerUserId !== ownerUserId) return null
    return {
      timeZone: loaded.timeZone,
      setTimeZone: async (timeZone) => {
        const settings = await localRepository.setTimeZone(timeZone, ownerUserId)
        setLoaded({ ownerUserId, timeZone: settings.timezone })
      },
    }
  }, [loaded, ownerUserId])

  if (error) return <section className="workspace-gate" role="alert"><h1>Settings unavailable</h1><p>{error}</p></section>
  if (!value) return <section className="workspace-gate" role="status"><h1>Opening your preferences</h1><p>Loading settings for this workspace.</p></section>
  return <WorkspaceTimeZoneContext.Provider value={value}>{children}</WorkspaceTimeZoneContext.Provider>
}

export function useWorkspaceTimeZone(): WorkspaceTimeZoneState {
  const value = useContext(WorkspaceTimeZoneContext)
  return value ?? {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    setTimeZone: async (timeZone) => { await localRepository.setTimeZone(timeZone, null) },
  }
}

const suggestedZones = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Toronto',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
]

export function SettingsPage() {
  const { timeZone, setTimeZone } = useWorkspaceTimeZone()
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const zones = [...new Set([...suggestedZones, deviceZone, timeZone])]

  async function changeTimeZone(next: string) {
    setSaved('')
    setError('')
    try {
      await setTimeZone(next)
      setSaved('Time zone saved for this workspace.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The time zone could not be saved.')
    }
  }

  return <section className="tracker-page settings-page" aria-labelledby="settings-title">
    <PageHeader headingId="settings-title" eyebrow="YOUR PREFERENCES" title="Settings" description="Choose the calendar time zone used for daily check-ins and progress dates." />
    <div className="settings-card">
      <label className="form-field"><span>Calendar time zone</span><select className="auth-input" value={timeZone} onChange={(event) => void changeTimeZone(event.target.value)}>
        {!zones.includes(timeZone) && <option value={timeZone}>{timeZone}</option>}
        {zones.map((zone) => <option value={zone} key={zone}>{zone.replaceAll('_', ' ')}</option>)}
      </select></label>
      {deviceZone !== timeZone && <button className="button button-secondary button-medium" onClick={() => void changeTimeZone(deviceZone)}>Use device time zone ({deviceZone.replaceAll('_', ' ')})</button>}
      <p>Saved locally in this workspace and used to decide which calendar day is “today.” Date-only history entries stay on their original dates. This preference is not uploaded or synchronized to other devices yet.</p>
      {saved && <p className="auth-success" role="status">{saved}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
    </div>
  </section>
}
