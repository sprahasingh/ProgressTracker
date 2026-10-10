import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { getSupabaseClient } from '../../services/supabase/client'
import { detectNotificationCapabilities } from './capabilities'
import { localRepository } from '../../db/localRepository'

type NotificationPreferences = {
  enabled: boolean; daily_enabled: boolean; daily_times: string[]; overdue_enabled: boolean; overdue_times: string[]
  remind_partial: boolean; motivation_mode: 'off' | 'general' | 'custom' | 'both'; motivation_times: string[]
  motivation_weekdays: number[]; timezone: string; quiet_start: string | null; quiet_end: string | null
  allow_overdue_during_quiet: boolean; daily_limit: number; motivation_daily_limit: number
  tracker_ids: string[] | null
}
const defaults = (timezone: string): NotificationPreferences => ({ enabled: false, daily_enabled: true, daily_times: ['16:00','22:00'], overdue_enabled: true, overdue_times: ['00:00','10:00'], remind_partial: false, motivation_mode: 'off', motivation_times: ['18:00'], motivation_weekdays: [0,1,2,3,4,5,6], timezone, quiet_start: null, quiet_end: null, allow_overdue_during_quiet: false, daily_limit: 4, motivation_daily_limit: 1, tracker_ids: null })

export function NotificationsSettings() {
  const { status, user } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const capabilities = detectNotificationCapabilities({ isSecureContext: globalThis.isSecureContext, serviceWorker: 'serviceWorker' in navigator, Notification: 'Notification' in globalThis ? Notification : undefined, PushManager: 'PushManager' in globalThis ? PushManager : undefined, standalone: window.matchMedia?.('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone), userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints })
  const [preferences, setPreferences] = useState(() => defaults(timeZone))
  const [messages, setMessages] = useState<{ id: string; message: string; enabled: boolean }[]>([])
  const [trackers, setTrackers] = useState<{ id: string; name: string }[]>([])
  const [messageDraft, setMessageDraft] = useState('')
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessage, setEditingMessage] = useState('')
  const [statusText, setStatusText] = useState('Loading notification settings…')
  const [saving, setSaving] = useState(false)
  const [preferencesReady, setPreferencesReady] = useState(false)
  const client = getSupabaseClient()

  useEffect(() => {
    let live = true
    setPreferences(defaults(timeZone))
    setMessages([])
    setTrackers([])
    setPreferencesReady(false)
    if (status !== 'signed-in' || !user) { setStatusText('Notifications are available for signed-in accounts. Guest tracking remains local and unchanged.'); return }
    if (!client) { setStatusText('Account preferences require Supabase configuration and the notifications migration. The in-app center remains available on this device.'); return }
    void Promise.all([
      client.from('notification_preferences').select('*').eq('user_id', user.id).maybeSingle(),
      client.from('custom_motivation_messages').select('id,message,enabled').eq('user_id', user.id).order('created_at'),
      localRepository.listTrackers(),
    ]).then(([prefResult, messageResult, trackerRows]) => {
      if (!live) return
      if (prefResult.error || messageResult.error) { setStatusText('Notification settings need the local database migration before they can be saved.'); return }
      if (prefResult.data) setPreferences({ ...defaults(timeZone), ...prefResult.data, daily_times: prefResult.data.daily_times?.map((time: string) => time.slice(0,5)) ?? ['16:00','22:00'], overdue_times: prefResult.data.overdue_times?.map((time: string) => time.slice(0,5)) ?? ['00:00','10:00'], motivation_times: prefResult.data.motivation_times?.map((time: string) => time.slice(0,5)) ?? ['18:00'], quiet_start: prefResult.data.quiet_start?.slice(0,5) ?? null, quiet_end: prefResult.data.quiet_end?.slice(0,5) ?? null })
      setMessages(messageResult.data ?? [])
      setTrackers(trackerRows.map(({ id, name }) => ({ id, name })))
      setPreferencesReady(true)
      setStatusText('Preferences sync with your signed-in account when online.')
    }).catch(() => { if (live) setStatusText('Notification settings could not be loaded.') })
    return () => { live = false }
  }, [client, status, timeZone, user?.id])

  async function save(next = preferences): Promise<boolean> {
    if (!user || !client) return false
    setSaving(true)
    const { error } = await client.from('notification_preferences').upsert({ ...next, user_id: user.id, timezone: timeZone, daily_times: next.daily_times, overdue_times: next.overdue_times, motivation_times: next.motivation_times }, { onConflict: 'user_id' })
    setSaving(false)
    setStatusText(error ? 'Could not save notification preferences. Check your connection and database setup.' : 'Notification preferences saved to your account.')
    return !error
  }
  function update<K extends keyof NotificationPreferences>(key: K, value: NotificationPreferences[K]) {
    const previous = preferences
    const next = { ...preferences, [key]: value }
    setPreferences(next)
    void save(next).then((saved) => { if (!saved) setPreferences((current) => current === next ? previous : current) })
  }
  async function addMessage() {
    const message = messageDraft.trim()
    if (!client || !user || !message || message.length > 240 || messages.some((item) => item.message.toLocaleLowerCase() === message.toLocaleLowerCase())) return
    const { data, error } = await client.from('custom_motivation_messages').insert({ user_id: user.id, message }).select('id,message,enabled').single()
    if (error) { setStatusText('Message could not be saved.'); return }
    setMessages((items) => [...items, data]); setMessageDraft('')
  }
  async function toggleMessage(item: typeof messages[number]) {
    if (!client) return
    const enabled = !item.enabled
    const { error } = await client.from('custom_motivation_messages').update({ enabled }).eq('id', item.id)
    if (!error) setMessages((items) => items.map((row) => row.id === item.id ? { ...row, enabled } : row))
  }
  async function deleteMessage(id: string) {
    if (!client) return
    const { error } = await client.from('custom_motivation_messages').delete().eq('id', id)
    if (!error) setMessages((items) => items.filter((row) => row.id !== id))
  }
  async function saveMessageEdit(id: string) {
    const message = editingMessage.trim()
    if (!client || !message || message.length > 240 || messages.some((item) => item.id !== id && item.message.toLocaleLowerCase() === message.toLocaleLowerCase())) return
    const { error } = await client.from('custom_motivation_messages').update({ message }).eq('id', id)
    if (error) { setStatusText('Message could not be updated.'); return }
    setMessages((items) => items.map((row) => row.id === id ? { ...row, message } : row))
    setEditingMessageId(null)
  }
  async function enableOnDevice() {
    if (!('Notification' in globalThis)) return
    const permission = await Notification.requestPermission()
    setStatusText(permission === 'granted' ? 'Permission granted. Background reminders still require server push setup.' : permission === 'denied' ? 'Permission is blocked. Change it in your browser or device settings.' : 'Permission was not granted.')
  }
  async function sendTest() {
    if (Notification.permission !== 'granted') return
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration?.showNotification) await registration.showNotification('ProgressTracker test', { body: 'Notifications are visible on this device.', icon: `${import.meta.env.BASE_URL}icons/progress-tracker.svg`, tag: 'progress-tracker:test' })
    else new Notification('ProgressTracker test', { body: 'Notifications are visible on this device.' })
  }

  if (status !== 'signed-in') return <section className="settings-section notification-settings" aria-label="Notifications"><h2>Notifications</h2><p>Scheduled account notifications are available after sign-in. Guest tracking remains available locally.</p></section>
  return <section className="settings-section notification-settings" id="notifications" aria-labelledby="notifications-heading">
    <h2 id="notifications-heading">Notifications</h2>
    <p id="notification-settings-status" aria-live="polite">{saving ? 'Saving notification preferences…' : statusText}</p>
    <div className="notification-capability"><strong>{capabilities.level === 'web-push-capable' ? 'Web Push APIs available' : capabilities.level === 'in-app-only' ? 'In-app notifications available' : 'System notifications blocked or unsupported'}</strong><span>{capabilities.reason}</span>{capabilities.standalone && <small>Installed app display detected.</small>}</div>
    {capabilities.secureContext && capabilities.notificationApi && capabilities.permission !== 'denied' && <div className="notification-actions"><button className="button button-secondary button-small" onClick={() => void enableOnDevice()}>Enable on this device</button>{capabilities.permission === 'granted' && <button className="button button-secondary button-small" onClick={() => void sendTest()}>Send test notification</button>}</div>}
    {capabilities.permission === 'denied' && <p role="status">Permission is denied. Change notification permission in your browser or operating-system settings; ProgressTracker will not prompt again automatically.</p>}
    <fieldset className="notification-preferences-fieldset" disabled={!preferencesReady} aria-describedby="notification-settings-status"><label className="notification-switch"><input type="checkbox" disabled={saving} checked={preferences.enabled} onChange={(event) => update('enabled', event.target.checked)} /><span><strong>Enable reminders in this account</strong><small>When ProgressTracker is open, it checks local progress at your chosen times. Closed-app delivery requires additional server push setup.</small></span></label>
    <details className="notification-preferences" open><summary>Daily check-in reminders</summary><label><input type="checkbox" checked={preferences.daily_enabled} onChange={(event) => update('daily_enabled', event.target.checked)} /> Remind me about unmarked activities</label><TimeSlots values={preferences.daily_times} onChange={(times) => update('daily_times', times)} /><label><input type="checkbox" checked={preferences.remind_partial} onChange={(event) => update('remind_partial', event.target.checked)} /> Also remind about partially completed targets</label><div className="notification-tracker-filter"><strong>Trackers</strong><label><input type="radio" name="notification-tracker-scope" checked={preferences.tracker_ids === null} onChange={() => update('tracker_ids', null)} /> All eligible trackers</label><label><input type="radio" name="notification-tracker-scope" checked={preferences.tracker_ids !== null} onChange={() => update('tracker_ids', [])} /> Choose trackers</label>{preferences.tracker_ids !== null && trackers.map((tracker) => <label key={tracker.id}><input type="checkbox" checked={preferences.tracker_ids?.includes(tracker.id) ?? false} onChange={(event) => update('tracker_ids', event.target.checked ? [...(preferences.tracker_ids ?? []), tracker.id] : (preferences.tracker_ids ?? []).filter((id) => id !== tracker.id))} /> {tracker.name}</label>)}</div></details>
    <details className="notification-preferences"><summary>Overdue reminders</summary><label><input type="checkbox" checked={preferences.overdue_enabled} onChange={(event) => update('overdue_enabled', event.target.checked)} /> Remind me about unresolved check-ins from yesterday</label><TimeSlots values={preferences.overdue_times} onChange={(times) => update('overdue_times', times)} /></details>
    <details className="notification-preferences"><summary>Motivation</summary><label className="form-field"><span>Message type</span><select className="auth-input" value={preferences.motivation_mode} onChange={(event) => update('motivation_mode', event.target.value as NotificationPreferences['motivation_mode'])}><option value="off">Off</option><option value="general">General messages</option><option value="custom">My messages only</option><option value="both">Both</option></select></label><TimeSlots values={preferences.motivation_times} onChange={(times) => update('motivation_times', times)} /><div className="notification-weekdays" aria-label="Motivation weekdays">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((label, day) => <label key={label}><input type="checkbox" checked={preferences.motivation_weekdays.includes(day)} onChange={(event) => update('motivation_weekdays', event.target.checked ? [...preferences.motivation_weekdays, day].sort() : preferences.motivation_weekdays.filter((value) => value !== day))} />{label}</label>)}</div><div className="custom-motivation-editor"><label className="form-field"><span>My messages</span><textarea className="auth-input" rows={2} maxLength={240} placeholder="Write a kind reminder to yourself" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} /></label><button className="button button-secondary button-small" disabled={!messageDraft.trim() || messageDraft.trim().length > 240} onClick={() => void addMessage()}>Add message</button>{preferences.motivation_mode === 'custom' && messages.every((item) => !item.enabled) && <p role="status">Add and enable a message to use Custom Only. General messages will not be substituted.</p>}{messages.map((item) => <div className="custom-message-row" key={item.id}>{editingMessageId === item.id ? <input aria-label="Edit motivation message" className="auth-input" maxLength={240} value={editingMessage} onChange={(event) => setEditingMessage(event.target.value)} /> : <span>{item.message}</span>}<label><input aria-label={`Enable message: ${item.message}`} type="checkbox" checked={item.enabled} onChange={() => void toggleMessage(item)} /> Enabled</label>{editingMessageId === item.id ? <button className="button button-secondary button-small" onClick={() => void saveMessageEdit(item.id)}>Save</button> : <button className="button button-secondary button-small" onClick={() => { setEditingMessageId(item.id); setEditingMessage(item.message) }}>Edit</button>}<button className="button button-secondary button-small" onClick={() => void deleteMessage(item.id)}>Delete</button></div>)}</div></details>
    <details className="notification-preferences"><summary>Advanced</summary><label className="form-field"><span>Quiet hours start</span><input className="auth-input" type="time" value={preferences.quiet_start ?? ''} onChange={(event) => update('quiet_start', event.target.value || null)} /></label><label className="form-field"><span>Quiet hours end</span><input className="auth-input" type="time" value={preferences.quiet_end ?? ''} onChange={(event) => update('quiet_end', event.target.value || null)} /></label><label className="form-field"><span>Maximum notifications per day</span><input className="auth-input" type="number" min={1} max={20} value={preferences.daily_limit} onChange={(event) => update('daily_limit', Math.max(1, Math.min(20, Number(event.target.value))))} /></label><label className="form-field"><span>Maximum motivation messages per day</span><input className="auth-input" type="number" min={0} max={5} value={preferences.motivation_daily_limit} onChange={(event) => update('motivation_daily_limit', Math.max(0, Math.min(5, Number(event.target.value))))} /></label><label><input type="checkbox" checked={preferences.allow_overdue_during_quiet} onChange={(event) => update('allow_overdue_during_quiet', event.target.checked)} /> Allow overdue reminders during quiet hours</label><p>Recurring times use {timeZone}. Nonexistent daylight-saving wall times are skipped; a repeated wall time is deduplicated. Times are local wall-clock times; server scheduling is not configured.</p></details></fieldset>
  </section>
}

function TimeSlots({ values, onChange }: { values: string[]; onChange: (times: string[]) => void }) {
  const candidates = ['20:00','12:00','08:00','14:00','19:00','21:00']
  return <div className="notification-times">{values.map((value, index) => <label key={index}>Reminder {index + 1}<span><input type="time" value={value} onChange={(event) => { if (!values.some((time, i) => i !== index && time === event.target.value)) onChange(values.map((time, i) => i === index ? event.target.value : time)) }} /><button type="button" className="button button-secondary button-small" aria-label={`Remove reminder time ${index + 1}`} disabled={values.length <= 1} onClick={() => onChange(values.filter((_, i) => i !== index))}>×</button></span></label>)}<button type="button" className="button button-secondary button-small" disabled={values.length >= 6 || !candidates.some((time) => !values.includes(time))} onClick={() => { const value = candidates.find((time) => !values.includes(time)); if (value) onChange([...values, value]) }}>Add time</button></div>
}
