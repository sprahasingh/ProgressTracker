import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { AppIcon } from '../../components/ui/AppIcon'
import { getSupabaseClient } from '../../services/supabase/client'
import { detectNotificationCapabilities } from './capabilities'
import { localRepository } from '../../db/localRepository'
import type { LocalMotivationMessage, LocalNotificationPreferences } from '../../db/models'

type NotificationPreferences = Omit<LocalNotificationPreferences, 'id' | 'updatedAt' | 'syncPending'>
const defaults = (timezone: string): NotificationPreferences => ({ enabled: false, daily_enabled: true, daily_times: ['16:00','22:00'], overdue_enabled: true, overdue_times: ['00:00','10:00'], remind_partial: false, motivation_mode: 'off', motivation_times: ['18:00'], motivation_weekdays: [0,1,2,3,4,5,6], timezone, quiet_start: null, quiet_end: null, allow_overdue_during_quiet: false, daily_limit: 4, motivation_daily_limit: 1, tracker_ids: null })

function normalizePreferences(value: Partial<NotificationPreferences> | null | undefined, timezone: string): NotificationPreferences {
  const base = { ...defaults(timezone), ...value }
  const time = (candidate: string | null | undefined, fallback: string | null) => candidate ? candidate.slice(0, 5) : fallback
  return { ...base, daily_times: (base.daily_times ?? []).map((item) => item.slice(0, 5)), overdue_times: (base.overdue_times ?? []).map((item) => item.slice(0, 5)), motivation_times: (base.motivation_times ?? []).map((item) => item.slice(0, 5)), quiet_start: time(base.quiet_start, null), quiet_end: time(base.quiet_end, null), timezone }
}

function cloudShape(preferences: NotificationPreferences) {
  return { ...preferences, daily_times: preferences.daily_times, overdue_times: preferences.overdue_times, motivation_times: preferences.motivation_times }
}

export function NotificationsSettings() {
  const { status, user } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const capabilities = detectNotificationCapabilities({ isSecureContext: globalThis.isSecureContext, serviceWorker: 'serviceWorker' in navigator, Notification: 'Notification' in globalThis ? Notification : undefined, PushManager: 'PushManager' in globalThis ? PushManager : undefined, standalone: window.matchMedia?.('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone), userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints })
  const [preferences, setPreferences] = useState(() => defaults(timeZone))
  const [messages, setMessages] = useState<LocalMotivationMessage[]>([])
  const [trackers, setTrackers] = useState<{ id: string; name: string }[]>([])
  const [messageDraft, setMessageDraft] = useState('')
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessage, setEditingMessage] = useState('')
  const [statusText, setStatusText] = useState('Loading notification settings…')
  const [saving, setSaving] = useState(false)
  const [preferencesReady, setPreferencesReady] = useState(false)
  const preferenceSaveQueue = useRef<Promise<void>>(Promise.resolve())
  const client = getSupabaseClient()

  useEffect(() => {
    let live = true
    setPreferences(defaults(timeZone))
    setMessages([])
    setTrackers([])
    setPreferencesReady(false)
    if (status !== 'signed-in' || !user) { setStatusText('Notifications are available for signed-in accounts. Guest tracking remains local and unchanged.'); return }
    void (async () => {
      try {
        const [localPreferences, localMessages, trackerRows] = await Promise.all([
          localRepository.getNotificationPreferences(), localRepository.listCustomMotivationMessages(), localRepository.listTrackers(),
        ])
        if (!live) return
        const cached = localPreferences !== undefined
        let nextPreferences = normalizePreferences(localPreferences, timeZone)
        let nextMessages = localMessages.filter((message) => !message.deleted)
        setTrackers(trackerRows.map(({ id, name }) => ({ id, name })))
        setPreferences(nextPreferences)
        setMessages(nextMessages)
        setPreferencesReady(true)
        setStatusText(client ? 'Preferences are ready. Changes save on this device and sync to your account when available.' : 'Preferences are saved on this device. Account sync setup is unavailable.')

        if (!client) return
        const [prefResult, messageResult] = await Promise.all([
          client.from('notification_preferences').select('*').eq('user_id', user.id).maybeSingle(),
          client.from('custom_motivation_messages').select('id,message,enabled').eq('user_id', user.id).order('created_at'),
        ])
        if (!live) return
        if (prefResult.error || messageResult.error) {
          setStatusText(cached || localMessages.length ? 'Saved on this device. Account sync is unavailable; your preferences remain available here.' : 'Preferences are saved on this device. Account sync needs the notifications database setup.')
          return
        }
        if (!cached && prefResult.data) {
          nextPreferences = normalizePreferences(prefResult.data, timeZone)
          setPreferences(nextPreferences)
          await localRepository.saveNotificationPreferences(nextPreferences, false)
        } else if (cached) {
          const { error } = await client.from('notification_preferences').upsert({ ...cloudShape(nextPreferences), user_id: user.id }, { onConflict: 'user_id' })
          if (error && live) setStatusText('Saved on this device. Account sync is waiting for the server.')
          else await localRepository.markNotificationPreferencesSynced()
        }
        if (localMessages.length === 0 && messageResult.data) {
          nextMessages = messageResult.data.map((row: { id: string; message: string; enabled: boolean }) => ({ ...row, deleted: false, updatedAt: new Date().toISOString(), syncPending: false }))
          for (const message of nextMessages) await localRepository.saveCustomMotivationMessage(message, false)
          setMessages(nextMessages)
        } else if (localMessages.length > 0) {
          for (const message of localMessages) {
            const result = message.deleted
              ? await client.from('custom_motivation_messages').delete().eq('id', message.id).eq('user_id', user.id)
              : await client.from('custom_motivation_messages').upsert({ id: message.id, user_id: user.id, message: message.message, enabled: message.enabled }, { onConflict: 'id' })
            if (!result.error && message.deleted) await localRepository.deleteSyncedCustomMotivationMessage(message.id)
            else if (!result.error) await localRepository.markCustomMotivationMessageSynced(message.id)
          }
        }
        const [pendingPreferences, pendingMessages] = await Promise.all([localRepository.getNotificationPreferences(), localRepository.listCustomMotivationMessages()])
        if (live) setStatusText(pendingPreferences?.syncPending || pendingMessages.some((message) => message.syncPending)
          ? 'Saved on this device. Some account changes are waiting to sync.'
          : 'Preferences are saved on this device and synchronized with your account.')
      } catch {
        if (live) {
          setStatusText('Account preferences could not be loaded. Local preferences remain available when storage opens.')
          setPreferencesReady(true)
        }
      }
    })()
    return () => { live = false }
  }, [client, status, timeZone, user?.id])

  async function save(next = preferences): Promise<void> {
    if (!user) return
    setSaving(true)
    const operation = preferenceSaveQueue.current.then(async () => {
      try {
        await localRepository.saveNotificationPreferences({ ...next, timezone: timeZone })
      } catch { setStatusText('Could not save preferences on this device. Please retry.'); return }
      setStatusText('Saved on this device. Syncing to your account when available.')
      if (!client) { setStatusText('Saved on this device. Account sync setup is unavailable; changes are retained locally.'); return }
      try {
        const { error } = await client.from('notification_preferences').upsert({ ...cloudShape({ ...next, timezone: timeZone }), user_id: user.id }, { onConflict: 'user_id' })
        if (!error) await localRepository.markNotificationPreferencesSynced()
        setStatusText(error ? 'Saved on this device. Account sync is unavailable; changes are retained locally.' : 'Preferences saved on this device and to your account.')
      } catch { setStatusText('Saved on this device. Account sync is unavailable; changes are retained locally.') }
    })
    preferenceSaveQueue.current = operation.catch(() => undefined)
    try { await operation } finally { setSaving(false) }
  }
  function update<K extends keyof NotificationPreferences>(key: K, value: NotificationPreferences[K]) {
    const next = { ...preferences, [key]: value }
    setPreferences(next)
    void save(next)
  }
  async function addMessage() {
    const message = messageDraft.trim()
    if (!user || !message || message.length > 240 || messages.some((item) => item.message.toLocaleLowerCase() === message.toLocaleLowerCase())) return
    const id = crypto.randomUUID()
    const row = await localRepository.saveCustomMotivationMessage({ id, message, enabled: true, deleted: false })
    setMessages((items) => [...items, row]); setMessageDraft('')
    setStatusText('Message saved on this device. Account sync will resume when available.')
    if (client) {
      try {
        const { error } = await client.from('custom_motivation_messages').insert({ id, user_id: user.id, message, enabled: true })
        if (!error) await localRepository.markCustomMotivationMessageSynced(id)
        setStatusText(error ? 'Message saved on this device. Account sync is unavailable.' : 'Message saved on this device and to your account.')
      } catch { setStatusText('Message saved on this device. Account sync is unavailable.') }
    }
  }
  async function toggleMessage(item: LocalMotivationMessage) {
    const row = await localRepository.saveCustomMotivationMessage({ ...item, deleted: false, enabled: !item.enabled })
    setMessages((items) => items.map((value) => value.id === row.id ? row : value))
    setStatusText('Message change saved on this device. Account sync will resume when available.')
    if (client && user) {
      try {
        const { error } = await client.from('custom_motivation_messages').upsert({ id: row.id, user_id: user.id, message: row.message, enabled: row.enabled }, { onConflict: 'id' })
        if (!error) await localRepository.markCustomMotivationMessageSynced(row.id)
        setStatusText(error ? 'Message change saved on this device. Account sync is unavailable.' : 'Message change saved on this device and to your account.')
      } catch { setStatusText('Message change saved on this device. Account sync is unavailable.') }
    }
  }
  async function deleteMessage(id: string) {
    await localRepository.deleteCustomMotivationMessage(id)
    setMessages((items) => items.filter((row) => row.id !== id))
    setStatusText('Message removed on this device. Account sync will resume when available.')
    if (client && user) {
      try {
        const { error } = await client.from('custom_motivation_messages').delete().eq('id', id).eq('user_id', user.id)
        if (error) setStatusText('Message removed on this device. Account sync is unavailable.')
        else await localRepository.deleteSyncedCustomMotivationMessage(id)
      } catch { setStatusText('Message removed on this device. Account sync is unavailable.') }
    }
  }
  async function saveMessageEdit(id: string) {
    const message = editingMessage.trim()
    if (!message || message.length > 240 || messages.some((item) => item.id !== id && item.message.toLocaleLowerCase() === message.toLocaleLowerCase())) return
    const old = messages.find((item) => item.id === id)
    if (!old) return
    const row = await localRepository.saveCustomMotivationMessage({ ...old, deleted: false, message })
    setMessages((items) => items.map((item) => item.id === id ? row : item))
    setEditingMessageId(null)
    setStatusText('Message edit saved on this device. Account sync will resume when available.')
    if (client && user) {
      try {
        const { error } = await client.from('custom_motivation_messages').upsert({ id, user_id: user.id, message, enabled: row.enabled }, { onConflict: 'id' })
        if (!error) await localRepository.markCustomMotivationMessageSynced(id)
        setStatusText(error ? 'Message edit saved on this device. Account sync is unavailable.' : 'Message edit saved on this device and to your account.')
      } catch { setStatusText('Message edit saved on this device. Account sync is unavailable.') }
    }
  }
  async function enableOnDevice() {
    if (!('Notification' in globalThis)) return
    const permission = await Notification.requestPermission()
    setStatusText(permission === 'granted' ? 'Device notifications: Enabled. Background reminders still require server push setup.' : permission === 'denied' ? 'Permission is blocked. Change it in your browser or device settings.' : 'Permission was not granted.')
  }
  async function sendTest() {
    if (Notification.permission !== 'granted') return
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration?.showNotification) await registration.showNotification('ProgressTracker test', { body: 'This confirms device display only; it does not test reminder scheduling or background delivery.', icon: `${import.meta.env.BASE_URL}icons/progress-tracker.svg`, tag: 'progress-tracker:test' })
    else new Notification('ProgressTracker test', { body: 'This confirms device display only; it does not test reminder scheduling or background delivery.' })
  }

  if (status !== 'signed-in') return <section className="settings-section notification-settings" aria-label="Notifications"><h2>Notifications</h2><p>Account reminder preferences require sign-in. Guest tracking remains local and unchanged.</p></section>
  return <section className="settings-section notification-settings" id="notifications" aria-labelledby="notifications-heading">
    <h2 id="notifications-heading">Notifications</h2>
    <p id="notification-settings-status" aria-live="polite">{saving ? 'Saving notification preferences…' : statusText}</p>
    <div className="notification-capability"><p><strong>Device notifications:</strong> {capabilities.permission === 'granted' ? 'Enabled' : capabilities.permission === 'denied' ? 'Blocked in device settings' : 'Not enabled'}</p><p><strong>In-app reminders:</strong> {preferences.enabled ? 'Enabled while the app is open' : 'Off'}</p><p><strong>Background reminders:</strong> Setup required</p><span>Closed-app delivery requires an operational server scheduler, secure push subscription handling, and delivery worker. A device test notification does not verify those services.</span>{capabilities.standalone && <small>Installed app display detected.</small>}</div>
    {capabilities.secureContext && capabilities.notificationApi && capabilities.permission !== 'denied' && <div className="notification-actions"><button className="button button-secondary button-small" onClick={() => void enableOnDevice()}>Enable on this device</button>{capabilities.permission === 'granted' && <button className="button button-secondary button-small" onClick={() => void sendTest()}>Send test notification</button>}</div>}
    {capabilities.permission === 'denied' && <p role="status">Permission is denied. Change notification permission in your browser or operating-system settings; ProgressTracker will not prompt again automatically.</p>}
    <fieldset className="notification-preferences-fieldset" disabled={!preferencesReady} aria-describedby="notification-settings-status"><label className="notification-switch"><input type="checkbox" disabled={saving} checked={preferences.enabled} onChange={(event) => update('enabled', event.target.checked)} /><span><strong>Enable reminders in this account</strong><small>Evaluated while the authenticated app is open using local progress. Background delivery is separate and currently unavailable.</small></span></label>
    <details className="notification-preferences" open><summary>Daily check-in reminders</summary><label><input type="checkbox" checked={preferences.daily_enabled} onChange={(event) => update('daily_enabled', event.target.checked)} /> Remind me about unmarked activities</label><TimeSlots values={preferences.daily_times} onChange={(times) => update('daily_times', times)} /><label><input type="checkbox" checked={preferences.remind_partial} onChange={(event) => update('remind_partial', event.target.checked)} /> Also remind about partially completed targets</label><div className="notification-tracker-filter"><strong>Trackers</strong><label><input type="radio" name="notification-tracker-scope" checked={preferences.tracker_ids === null} onChange={() => update('tracker_ids', null)} /> All eligible trackers</label><label><input type="radio" name="notification-tracker-scope" checked={preferences.tracker_ids !== null} onChange={() => update('tracker_ids', [])} /> Choose trackers</label>{preferences.tracker_ids !== null && trackers.map((tracker) => <label key={tracker.id}><input type="checkbox" checked={preferences.tracker_ids?.includes(tracker.id) ?? false} onChange={(event) => update('tracker_ids', event.target.checked ? [...(preferences.tracker_ids ?? []), tracker.id] : (preferences.tracker_ids ?? []).filter((id) => id !== tracker.id))} /> {tracker.name}</label>)}</div></details>
    <details className="notification-preferences"><summary>Overdue reminders</summary><label><input type="checkbox" checked={preferences.overdue_enabled} onChange={(event) => update('overdue_enabled', event.target.checked)} /> Remind me about unresolved check-ins from yesterday</label><TimeSlots values={preferences.overdue_times} onChange={(times) => update('overdue_times', times)} /></details>
    <details className="notification-preferences"><summary>Motivation</summary><label className="form-field"><span>Message type</span><select className="auth-input" value={preferences.motivation_mode} onChange={(event) => update('motivation_mode', event.target.value as NotificationPreferences['motivation_mode'])}><option value="off">Off</option><option value="general">General messages</option><option value="custom">My messages only</option><option value="both">Both</option></select></label><TimeSlots values={preferences.motivation_times} onChange={(times) => update('motivation_times', times)} /><div className="notification-weekdays" aria-label="Motivation weekdays">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((label, day) => <label key={label}><input type="checkbox" checked={preferences.motivation_weekdays.includes(day)} onChange={(event) => update('motivation_weekdays', event.target.checked ? [...preferences.motivation_weekdays, day].sort() : preferences.motivation_weekdays.filter((value) => value !== day))} />{label}</label>)}</div><div className="custom-motivation-editor"><label className="form-field"><span>My messages</span><textarea className="auth-input" rows={2} maxLength={240} placeholder="Write a kind reminder to yourself" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} /></label><button className="button button-secondary button-small" disabled={!messageDraft.trim() || messageDraft.trim().length > 240} onClick={() => void addMessage()}>Add message</button>{preferences.motivation_mode === 'custom' && messages.every((item) => !item.enabled) && <p role="status">Add and enable a message to use Custom Only. General messages will not be substituted.</p>}{messages.map((item) => <div className="custom-message-row" key={item.id}>{editingMessageId === item.id ? <input aria-label="Edit motivation message" className="auth-input" maxLength={240} value={editingMessage} onChange={(event) => setEditingMessage(event.target.value)} /> : <span>{item.message}</span>}<label><input aria-label={`Enable message: ${item.message}`} type="checkbox" checked={item.enabled} onChange={() => void toggleMessage(item)} /> Enabled</label>{editingMessageId === item.id ? <button className="button button-secondary button-small" onClick={() => void saveMessageEdit(item.id)}>Save</button> : <button className="button button-secondary button-small" onClick={() => { setEditingMessageId(item.id); setEditingMessage(item.message) }}>Edit</button>}<button className="button button-secondary button-small" onClick={() => void deleteMessage(item.id)}>Delete</button></div>)}</div></details>
    <details className="notification-preferences"><summary>Advanced</summary><label className="form-field"><span>Quiet hours start</span><input className="auth-input" type="time" value={preferences.quiet_start ?? ''} onChange={(event) => update('quiet_start', event.target.value || null)} /></label><label className="form-field"><span>Quiet hours end</span><input className="auth-input" type="time" value={preferences.quiet_end ?? ''} onChange={(event) => update('quiet_end', event.target.value || null)} /></label><label className="form-field"><span>Maximum notifications per day</span><input className="auth-input" type="number" min={1} max={20} value={preferences.daily_limit} onChange={(event) => update('daily_limit', Math.max(1, Math.min(20, Number(event.target.value))))} /></label><label className="form-field"><span>Maximum motivation messages per day</span><input className="auth-input" type="number" min={0} max={5} value={preferences.motivation_daily_limit} onChange={(event) => update('motivation_daily_limit', Math.max(0, Math.min(5, Number(event.target.value))))} /></label><label><input type="checkbox" checked={preferences.allow_overdue_during_quiet} onChange={(event) => update('allow_overdue_during_quiet', event.target.checked)} /> Allow overdue reminders during quiet hours</label><p>Recurring times use {timeZone}. Times are local wall-clock times. They schedule foreground checks only.</p></details></fieldset>
  </section>
}

function TimeSlots({ values, onChange }: { values: string[]; onChange: (times: string[]) => void }) {
  const candidates = ['20:00','12:00','08:00','14:00','19:00','21:00']
  return <div className="notification-times">{values.map((value, index) => <label key={index}>Reminder {index + 1}<span><input type="time" value={value} onChange={(event) => { if (!values.some((time, i) => i !== index && time === event.target.value)) onChange(values.map((time, i) => i === index ? event.target.value : time)) }} /><button type="button" className="button button-secondary button-small" aria-label={`Remove reminder time ${index + 1}`} disabled={values.length <= 1} onClick={() => onChange(values.filter((_, i) => i !== index))}><AppIcon name="close" /></button></span></label>)}<button type="button" className="button button-secondary button-small" disabled={values.length >= 6 || !candidates.some((time) => !values.includes(time))} onClick={() => { const value = candidates.find((time) => !values.includes(time)); if (value) onChange([...values, value]) }}>Add time</button></div>
}
