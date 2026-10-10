import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode, type FormEvent } from 'react'
import { PageHeader } from '../../components/ui/PageHeader'
import { InfoButton } from '../../components/ui/InfoButton'
import { localRepository } from '../../db/localRepository'
import { applyDocumentAppearance, rememberAppearance } from './appearance'
import { useAuth } from '../auth/AuthProvider'
import { updateAccountName, requestAccountEmailChange } from '../auth/authService'
import { AuthPage } from '../auth/AuthPage'

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

  useLayoutEffect(() => {
    if (!loaded || loaded.ownerUserId !== ownerUserId) return
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    const apply = () => {
      applyDocumentAppearance(loaded.appearance, Boolean(media?.matches))
      rememberAppearance(loaded.appearance)
    }
    apply()
    if (loaded.appearance === 'system') media?.addEventListener('change', apply)
    return () => {
      media?.removeEventListener('change', apply)
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
  const auth = useAuth()
  const { timeZone, appearance, setTimeZone, setAppearance } = useWorkspaceTimeZone()
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const [profileError, setProfileError] = useState('')
  const [profileNotice, setProfileNotice] = useState('')
  const [nameEditing, setNameEditing] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const [emailEditing, setEmailEditing] = useState(false)
  const [emailValue, setEmailValue] = useState('')
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const zones = [...new Set([...suggestedZones, deviceZone, timeZone])]
  const metadata = auth.user?.user_metadata
  const displayName = [metadata?.display_name, metadata?.full_name, metadata?.name].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? ''
  const avatarInitial = (displayName || auth.user?.email?.trim())?.charAt(0).toLocaleUpperCase() || null
  const requestedEmail = pendingEmail ?? auth.user?.new_email ?? null

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const clean = nameValue.trim()
    setProfileError(''); setProfileNotice('')
    if (!clean) { setProfileError('Enter your name before saving.'); return }
    const result = await updateAccountName(clean)
    if (result.error) { setProfileError(result.error); return }
    setProfileNotice('Your name was saved.')
    setNameEditing(false)
  }

  async function saveEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const clean = emailValue.trim().toLowerCase()
    setProfileError(''); setProfileNotice('')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) { setProfileError('Enter a valid email address.'); return }
    const result = await requestAccountEmailChange(clean, `${window.location.origin}${window.location.pathname}`)
    if (result.error) { setProfileError(result.error); return }
    setPendingEmail(result.pendingEmail)
    setEmailEditing(false)
    setProfileNotice('Check the confirmation messages from Supabase to finish changing your email. Your current email stays active until confirmation.')
  }

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

  if (auth.status === 'signed-in' && auth.user) return <section className="tracker-page settings-page unified-settings" aria-labelledby="settings-title">
    <PageHeader headingId="settings-title" eyebrow="YOUR PREFERENCES" title="Settings" description="Your profile, preferences, and account sync in one place." />
    <section className="settings-section" id="personal-information" aria-labelledby="personal-title">
      <h2 id="personal-title">Personal Information</h2>
      <div className="settings-profile-summary"><span className="settings-profile-avatar" aria-hidden="true">{avatarInitial ?? '◉'}</span><div><strong>{displayName || 'Add your name'}</strong><span>{auth.user.email || 'Email unavailable'}</span></div></div>
      {!displayName && <p className="settings-hint">Add your name to complete your profile. You can keep using your trackers either way.</p>}
      <div className="settings-account-rows">
        <div><span><strong>Full name</strong><small>{displayName || 'Not set'}</small></span><button className="button button-secondary button-small" onClick={() => { setNameValue(displayName); setNameEditing(!nameEditing); setProfileError('') }}>{nameEditing ? 'Cancel' : 'Edit'}</button></div>
        {nameEditing && <form className="settings-edit-form" onSubmit={(event) => void saveName(event)} noValidate><label className="form-field"><span>Full name</span><input className="auth-input" autoComplete="name" value={nameValue} onChange={(event) => setNameValue(event.target.value)} /></label><button className="button button-primary button-medium">Save name</button></form>}
        <div><span><strong>Email address</strong><small>{auth.user.email || 'Not available'}{requestedEmail ? ` · confirmation pending for ${requestedEmail}` : ''}</small></span><button className="button button-secondary button-small" onClick={() => { setEmailValue(''); setEmailEditing(!emailEditing); setProfileError('') }}>{emailEditing ? 'Cancel' : 'Change email'}</button></div>
        {emailEditing && <form className="settings-edit-form" onSubmit={(event) => void saveEmail(event)} noValidate><label className="form-field"><span>New email address</span><input className="auth-input" type="email" inputMode="email" autoComplete="email" value={emailValue} onChange={(event) => setEmailValue(event.target.value)} /></label><p className="settings-hint">Supabase sends verification messages. Your current email remains in use until the change is confirmed.</p><button className="button button-primary button-medium">Send confirmation</button></form>}
      </div>
      {profileError && <p className="auth-error" role="alert">{profileError}</p>}{profileNotice && <p className="auth-success" role="status">{profileNotice}</p>}
    </section>
    <section className="settings-section" aria-labelledby="security-title"><h2 id="security-title">Security</h2><p>Passwordless email sign-in remains available. Set or change a password in Sync &amp; Data below; password updates use Supabase Auth.</p></section>
    <section className="settings-section"><h2>Calendar &amp; Time</h2>{renderPreferences(timeZone, appearance, changeTimeZone, changeAppearance, deviceZone, zones, saved, error)}</section>
    <section className="settings-section" id="sync-data"><h2>Sync &amp; Data</h2><AuthPage embedded /></section>
  </section>

  return <section className="tracker-page settings-page" aria-labelledby="settings-title">
    <PageHeader headingId="settings-title" eyebrow="YOUR PREFERENCES" title="Settings" description="Adjust the calendar and appearance for this workspace." help={{ title: 'Workspace settings', summary: 'Choose how dates and colors appear on this device and workspace.', description: 'Calendar time zone determines which date is today and how scheduled opportunities are evaluated. Appearance chooses light, dark, or your device’s setting. These preferences are stored locally for this workspace and currently do not sync across devices.' }} />
    {renderPreferences(timeZone, appearance, changeTimeZone, changeAppearance, deviceZone, zones, saved, error)}
  </section>
}

function renderPreferences(timeZone: string, appearance: 'light' | 'dark' | 'system', changeTimeZone: (value: string) => void, changeAppearance: (value: 'light' | 'dark' | 'system') => void, deviceZone: string, zones: string[], saved: string, error: string) {
  return <div className="settings-card">
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
}
