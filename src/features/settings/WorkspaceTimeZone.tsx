import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { PageHeader } from '../../components/ui/PageHeader'
import { InfoButton } from '../../components/ui/InfoButton'
import { localRepository } from '../../db/localRepository'

type WorkspaceTimeZoneState = {
  timeZone: string
  appearance: 'light' | 'dark' | 'system'
  setTimeZone: (timeZone: string) => Promise<void>
  setAppearance: (appearance: 'light' | 'dark' | 'system') => Promise<void>
}
const WorkspaceTimeZoneContext = createContext<WorkspaceTimeZoneState | null>(null)

export function WorkspaceTimeZoneProvider({ ownerUserId, children }: { ownerUserId: string | null; children: ReactNode }) {
  const [loaded, setLoaded] = useState<{ ownerUserId: string | null; timeZone: string; appearance: WorkspaceTimeZoneState['appearance'] } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    setLoaded(null)
    setError('')
    void localRepository.getAppSettings(ownerUserId).then((settings) => {
      if (current) setLoaded({ ownerUserId, timeZone: settings.timezone, appearance: settings.appearance })
    }).catch(() => {
      if (current) setError('Your workspace settings could not be loaded.')
    })
    return () => { current = false }
  }, [ownerUserId])

  const value = useMemo<WorkspaceTimeZoneState | null>(() => {
    if (!loaded || loaded.ownerUserId !== ownerUserId) return null
    return {
      timeZone: loaded.timeZone,
      appearance: loaded.appearance,
      setTimeZone: async (timeZone) => {
        const settings = await localRepository.setTimeZone(timeZone, ownerUserId)
        setLoaded({ ownerUserId, timeZone: settings.timezone, appearance: settings.appearance })
      },
      setAppearance: async (appearance) => {
        const settings = await localRepository.setAppearance(appearance, ownerUserId)
        setLoaded({ ownerUserId, timeZone: settings.timezone, appearance: settings.appearance })
      },
    }
  }, [loaded, ownerUserId])

  useEffect(() => {
    if (!loaded || loaded.ownerUserId !== ownerUserId) return
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    const apply = () => {
      const dark = loaded.appearance === 'dark' || (loaded.appearance === 'system' && Boolean(media?.matches))
      if (dark) document.documentElement.dataset.theme = 'dark'
      else delete document.documentElement.dataset.theme
    }
    apply()
    if (loaded.appearance === 'system') media?.addEventListener('change', apply)
    return () => {
      media?.removeEventListener('change', apply)
      delete document.documentElement.dataset.theme
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
    appearance: 'system',
    setTimeZone: async (timeZone) => { await localRepository.setTimeZone(timeZone, null) },
    setAppearance: async (appearance) => { await localRepository.setAppearance(appearance, null) },
  }
}

const suggestedZones = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Toronto',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
]

export function SettingsPage() {
  const { timeZone, appearance, setTimeZone, setAppearance } = useWorkspaceTimeZone()
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

  async function changeAppearance(next: 'light' | 'dark' | 'system') {
    setSaved('')
    setError('')
    try {
      await setAppearance(next)
      setSaved('Appearance saved for this workspace.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Appearance could not be saved.')
    }
  }

  return <section className="tracker-page settings-page" aria-labelledby="settings-title">
    <PageHeader headingId="settings-title" eyebrow="YOUR PREFERENCES" title="Settings" description="Adjust the calendar and appearance for this workspace." help={{ title: 'Workspace settings', summary: 'Choose how dates and colors appear on this device and workspace.', description: 'Calendar time zone determines which date is today and how scheduled opportunities are evaluated. Appearance chooses light, dark, or your device’s setting. These preferences are stored locally for this workspace and currently do not sync across devices.' }} />
    <div className="settings-card">
      <label className="form-field"><span>Calendar time zone <InfoButton title="Calendar time zone" summary="Controls which local calendar date ProgressTracker treats as today." description="Schedules, streak days, deadlines, and date labels use this time zone. Changing it does not shift date-only historical entries. This preference is stored locally and is not yet synchronized across devices." /></span><select className="auth-input" value={timeZone} onChange={(event) => void changeTimeZone(event.target.value)}>
        {!zones.includes(timeZone) && <option value={timeZone}>{timeZone}</option>}
        {zones.map((zone) => <option value={zone} key={zone}>{zone.replaceAll('_', ' ')}</option>)}
      </select></label>
      {deviceZone !== timeZone && <button className="button button-secondary button-medium" onClick={() => void changeTimeZone(deviceZone)}>Use device time zone ({deviceZone.replaceAll('_', ' ')})</button>}
      <p>Saved locally in this workspace and used to decide which calendar day is “today.” Date-only history entries stay on their original dates. This preference is not uploaded or synchronized to other devices yet.</p>
      <label className="form-field"><span>Appearance <InfoButton title="Appearance" summary="Choose light or dark colors, or follow your device preference." description="System appearance follows your operating system. Light and dark set this workspace’s display mode. This setting is local and currently does not sync across devices." /></span><select className="auth-input" value={appearance} onChange={(event) => void changeAppearance(event.target.value as 'light' | 'dark' | 'system')}><option value="system">Use device setting</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <p>System appearance follows the device’s light or dark setting. This preference is local to the workspace and does not sync across devices.</p>
      {saved && <p className="auth-success" role="status">{saved}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
    </div>
  </section>
}
