import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { AppIcon } from '../../components/ui/AppIcon'
import { InfoButton } from '../../components/ui/InfoButton'
import { getSupabaseClient } from '../../services/supabase/client'
import { detectNotificationCapabilities } from './capabilities'
import { localRepository } from '../../db/localRepository'
import type { LocalMotivationMessage, LocalNotificationPreferences } from '../../db/models'
import { getStoredPushOwner, managePushSubscriptionWithSupabase, registerCurrentPushSubscription, revokeCurrentPushSubscription, revokePushEndpoint, setStoredPushOwner, setWorkerPushOwner, withPushOwnershipLock } from './pushSubscriptionService'
import { validatePushSubscription } from '../../../supabase/functions/_shared/pushSubscriptionValidation'

type PushRegistrationState = 'unsupported' | 'permission-not-granted' | 'permission-denied' | 'not-registered' | 'pending' | 'registered' | 'failed'
const pushStateLabels: Record<PushRegistrationState, string> = {
  unsupported: 'Notifications unsupported',
  'permission-not-granted': 'Permission not granted',
  'permission-denied': 'Permission denied',
  'not-registered': 'Permission granted; device not registered',
  pending: 'Registration pending',
  registered: 'Device registered',
  failed: 'Registration failed',
}

type NotificationPreferences = Omit<LocalNotificationPreferences, 'id' | 'updatedAt' | 'syncPending'>
type NotificationGroup = 'general' | 'daily' | 'incomplete' | 'motivation' | 'quiet-hours' | 'device'
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
  const { status, user, pushOwnershipStatus, pushOwnershipMessage } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const location = useLocation()
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
  const [pushState, setPushState] = useState<PushRegistrationState>('permission-not-granted')
  const [pushError, setPushError] = useState('')
  const [pushBusy, setPushBusy] = useState(false)
  const [expandedGroup, setExpandedGroup] = useState<NotificationGroup | null>(null)
  const preferenceSaveQueue = useRef<Promise<void>>(Promise.resolve())
  const client = getSupabaseClient()
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''
  useEffect(() => { setExpandedGroup(null) }, [location.key, location.pathname, location.search, location.hash])
  const dailySummary = `${preferences.daily_enabled ? 'On' : 'Off'} · ${preferences.daily_times.length} ${preferences.daily_times.length === 1 ? 'time' : 'times'}`
  const incompleteSummary = `${preferences.overdue_enabled ? 'Overdue on' : 'Overdue off'} · Partial ${preferences.remind_partial ? 'on' : 'off'}`
  const motivationWeekdays = preferences.motivation_weekdays.length === 7 ? 'Every day' : preferences.motivation_weekdays.length === 0 ? 'No days' : ([['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6],['Sun',0]] as const).filter(([, day]) => preferences.motivation_weekdays.includes(day)).map(([label]) => label).join(', ')
  const motivationTimes = preferences.motivation_times.length === 0 ? 'No times' : preferences.motivation_times.slice(0, 2).map(formatReminderTime).join(', ') + (preferences.motivation_times.length > 2 ? ` +${preferences.motivation_times.length - 2}` : '')
  const motivationSummary = preferences.motivation_mode === 'off' ? 'Off' : `${{ general: 'General', custom: 'Custom only', both: 'General and custom' }[preferences.motivation_mode]} · ${motivationTimes} · ${motivationWeekdays}`
  const quietHoursSummary = preferences.quiet_start && preferences.quiet_end ? `${formatReminderTime(preferences.quiet_start)} – ${formatReminderTime(preferences.quiet_end)}` : 'Off'
  const deviceSummary = pushState === 'registered' ? 'Device subscribed' : pushStateLabels[pushState]

  async function managePush(action: 'register' | 'revoke', subscription: Parameters<typeof managePushSubscriptionWithSupabase>[2]) {
    if (!client) throw new Error('Account subscription management is not configured.')
    await managePushSubscriptionWithSupabase(client, action, subscription)
  }

  async function registrationForPush(): Promise<ServiceWorkerRegistration> {
    if (!('serviceWorker' in navigator)) throw new Error('This browser does not support service workers.')
    const existing = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
    if (existing?.active) return existing
    if (!existing && !import.meta.env.PROD) throw new Error('Push registration is available on the production service worker, not the development server.')
    const ready = await navigator.serviceWorker.ready
    if (!ready.scope.startsWith(new URL(import.meta.env.BASE_URL, window.location.origin).href)) throw new Error('ProgressTracker service worker is unavailable.')
    return ready
  }

  async function registerDevice(explicit = true) {
    if (!user || status !== 'signed-in') return
    if (pushOwnershipStatus !== 'ready') {
      setPushState('failed')
      setPushError(pushOwnershipMessage || 'Resolve the previous account’s device subscription before registering this device.')
      return
    }
    if (!capabilities.secureContext || !capabilities.serviceWorker || !capabilities.pushApi || !capabilities.notificationApi) {
      setPushState('unsupported')
      setPushError(capabilities.reason)
      return
    }
    setPushBusy(true)
    setPushState('pending')
    setPushError('')
    try {
      let permission = Notification.permission
      if (permission === 'default' && explicit) permission = await Notification.requestPermission()
      if (permission === 'denied') {
        setPushState('permission-denied')
        setPushError('Change notification permission in your browser or device settings.')
        return
      }
      if (permission !== 'granted') {
        setPushState('permission-not-granted')
        setPushError('Allow device notifications before registering this device.')
        return
      }
      if (!client) throw new Error('Supabase account services are not configured on this deployment.')
      const result = await withPushOwnershipLock(async () => {
        if (client && typeof client.auth?.getSession === 'function') {
          const { data } = await client.auth.getSession()
          if (data.session?.user.id !== user.id) throw new Error('The active account changed. Reload notification settings before registering this device.')
        }
        const registration = await registrationForPush()
        const result = await registerCurrentPushSubscription(registration, vapidPublicKey, managePush, explicit)
        if (result === 'registered') {
          setStoredPushOwner(user.id)
          setWorkerPushOwner(registration, user.id)
        }
        return result
      })
      setPushState(result === 'registered' ? 'registered' : 'not-registered')
      if (result === 'not-subscribed') setPushError('Use Register this device to create its first subscription.')
    } catch (error) {
      setPushState('failed')
      setPushError(error instanceof Error ? error.message : 'Device registration could not be completed.')
    } finally {
      setPushBusy(false)
    }
  }

  async function disableDevice() {
    if (!client) return
    setPushBusy(true)
    setPushState('pending')
    setPushError('')
    try {
      await withPushOwnershipLock(async () => {
        if (client && typeof client.auth?.getSession === 'function') {
          const { data } = await client.auth.getSession()
          if (data.session?.user.id !== user?.id) throw new Error('The active account changed. Reload notification settings before disabling this device.')
        }
        const registration = await registrationForPush()
        await revokeCurrentPushSubscription(registration, managePush)
        setStoredPushOwner(null)
        setWorkerPushOwner(registration, null)
      })
      setPushState('not-registered')
      setPushError('This device is no longer registered for account push notifications.')
    } catch (error) {
      setPushState('failed')
      setPushError(error instanceof Error ? error.message : 'This device could not be disabled. Retry when online.')
    } finally {
      setPushBusy(false)
    }
  }

  useEffect(() => {
    let live = true
    if (status !== 'signed-in' || !user) {
      setPushState('permission-not-granted')
      setPushError('Sign in to register this device to an account.')
      return
    }
    if (pushOwnershipStatus !== 'ready') {
      setPushState('failed')
      setPushError(pushOwnershipMessage || 'Device registration is paused until previous-account cleanup is complete.')
      return
    }
    if (!capabilities.secureContext || !capabilities.serviceWorker || !capabilities.pushApi || !capabilities.notificationApi) {
      setPushState('unsupported')
      setPushError(capabilities.reason)
      return
    }
    if (capabilities.permission === 'denied') {
      setPushState('permission-denied')
      setPushError('Change notification permission in your browser or device settings.')
      return
    }
    if (capabilities.permission !== 'granted') {
      setPushState('permission-not-granted')
      setPushError('Choose Enable device registration to grant permission and register this device.')
      return
    }
    setPushState('pending')
    void (async () => {
      try {
        if (!client) throw new Error('Supabase account services are not configured on this deployment.')
        const result = await withPushOwnershipLock(async () => {
          if (client && typeof client.auth?.getSession === 'function') {
            const { data } = await client.auth.getSession()
            if (data.session?.user.id !== user.id) throw new Error('The active account changed. Reload notification settings before checking this device.')
          }
          const registration = await registrationForPush()
          const result = await registerCurrentPushSubscription(registration, vapidPublicKey, managePush, false)
          if (result === 'registered') {
            setStoredPushOwner(user.id)
            setWorkerPushOwner(registration, user.id)
          }
          return result
        })
        if (live) setPushState(result === 'registered' ? 'registered' : 'not-registered')
      } catch (error) {
        if (live) {
          setPushState('failed')
          setPushError(error instanceof Error ? error.message : 'Device registration could not be checked.')
        }
      }
    })()
    return () => { live = false }
  }, [status, user?.id, pushOwnershipStatus, pushOwnershipMessage, capabilities.secureContext, capabilities.serviceWorker, capabilities.pushApi, capabilities.notificationApi, capabilities.permission, client, vapidPublicKey])

  useEffect(() => {
    if (status !== 'signed-in' || !user || !('serviceWorker' in navigator)) return
    const onWorkerMessage = (event: MessageEvent<unknown>) => {
      if (pushOwnershipStatus !== 'ready') return
      const data = event.data
      if (!data || typeof data !== 'object') return
      const message = data as { type?: unknown; changes?: unknown }
      const changes = message.type === 'PROGRESS_TRACKER_PENDING_PUSH_SUBSCRIPTION_CHANGE'
        ? Array.isArray(message.changes) ? message.changes : []
        : message.type === 'PROGRESS_TRACKER_PUSH_SUBSCRIPTION_CHANGED' ? [data] : []
      if (!changes.length) return
      setPushState('pending')
      void withPushOwnershipLock(async () => {
        try {
          if (!client) throw new Error('Supabase account services are not configured on this deployment.')
          if (typeof client.auth?.getSession === 'function') {
            const { data } = await client.auth.getSession()
            if (data.session?.user.id !== user.id) throw new Error('The active account changed. This queued subscription change was left untouched.')
          }
          let hasSubscription = false
          for (const rawChange of changes) {
            if (!rawChange || typeof rawChange !== 'object') continue
            const change = rawChange as { changeId?: unknown; id?: unknown; ownerUserId?: unknown; oldEndpoint?: unknown; newSubscription?: unknown }
            if (change.ownerUserId !== user.id) {
              throw new Error('A queued subscription change belongs to another account. Sign in to that account to finish device cleanup.')
            }
            const rememberedOwner = getStoredPushOwner()
            if (rememberedOwner && rememberedOwner !== user.id) {
              throw new Error('This browser subscription now belongs to another account. The stale renewal was left untouched.')
            }
            const newSubscription = validatePushSubscription(change.newSubscription)
            const activeRegistration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
            const browserSubscription = await activeRegistration?.pushManager?.getSubscription()
            if (typeof change.oldEndpoint === 'string' && (!newSubscription || newSubscription.endpoint !== change.oldEndpoint)) {
              await revokePushEndpoint(change.oldEndpoint, managePush)
            }
            if (newSubscription && browserSubscription?.endpoint === newSubscription.endpoint) {
              await managePush('register', newSubscription)
              setStoredPushOwner(user.id)
              setWorkerPushOwner(activeRegistration ?? null, user.id)
              hasSubscription = true
            }
            const changeId = typeof change.changeId === 'string' ? change.changeId : change.id
            if (typeof changeId === 'string') {
              const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
              registration?.active?.postMessage({ type: 'PROGRESS_TRACKER_ACK_PUSH_SUBSCRIPTION_CHANGE', changeId })
            }
          }
          setPushState(hasSubscription ? 'registered' : 'not-registered')
          setPushError(hasSubscription ? '' : 'The browser removed this subscription. Register this device again if you want push support.')
        } catch (error) {
          setPushState('failed')
          setPushError(error instanceof Error ? error.message : 'The renewed subscription could not be saved.')
        }
      })
    }
    navigator.serviceWorker.addEventListener('message', onWorkerMessage)
    void navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage({ type: 'PROGRESS_TRACKER_GET_PUSH_SUBSCRIPTION_CHANGES' }))
    return () => navigator.serviceWorker.removeEventListener('message', onWorkerMessage)
  }, [status, user?.id, client, pushOwnershipStatus])

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
  async function sendTest() {
    if (Notification.permission !== 'granted') return
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration?.showNotification) await registration.showNotification('ProgressTracker test', { body: 'This confirms device display only; it does not test reminder scheduling or background delivery.', icon: `${import.meta.env.BASE_URL}icons/progress-tracker.svg`, tag: 'progress-tracker:test' })
    else new Notification('ProgressTracker test', { body: 'This confirms device display only; it does not test reminder scheduling or background delivery.' })
  }
  async function requestDevicePermission() {
    if (!capabilities.secureContext || !capabilities.notificationApi) return
    const permission = await Notification.requestPermission()
    if (permission === 'denied') {
      setPushState('permission-denied')
      setPushError('Change notification permission in your browser or device settings.')
    } else if (permission === 'granted') {
      setPushState(capabilities.pushApi && capabilities.serviceWorker ? 'not-registered' : 'unsupported')
      setPushError(capabilities.pushApi && capabilities.serviceWorker ? 'Permission granted. Register this device to your account to enable push delivery.' : capabilities.reason)
    } else {
      setPushState('permission-not-granted')
      setPushError('Permission was not granted.')
    }
  }

  if (status !== 'signed-in') return <section className="settings-section notification-settings" aria-label="Notifications"><h2>Notifications</h2><p>Account reminder preferences require sign-in. Guest tracking remains local and unchanged.</p></section>
  return <section className="settings-section notification-settings" id="notifications" aria-labelledby="notifications-heading">
    <h2 id="notifications-heading">Notifications</h2>
    <p id="notification-settings-status" aria-live="polite">{saving ? 'Saving notification preferences…' : statusText}</p>
    <h3 className="notification-status-heading">Delivery status</h3>
    <div className="notification-capability" aria-label="Notification delivery status">
      <p><strong>Device notifications:</strong> {capabilities.permission === 'granted' ? 'Enabled' : capabilities.permission === 'denied' ? 'Blocked in device settings' : 'Not enabled'}</p>
      <p><strong>Push subscription:</strong> {pushStateLabels[pushState]}</p>
      <p><strong>Background reminders:</strong> Setup required <InfoButton title="Background delivery setup" summary="Device registration does not activate closed-app reminders." description="Background reminders require a server-side sender and scheduler, which are not deployed yet. Permission, device registration, and test notifications do not confirm background delivery." /></p>
      {pushError && pushState !== 'permission-denied' && <span role="status">{pushError}</span>}
      {pushOwnershipStatus !== 'ready' && <p role="status">{pushOwnershipMessage} {pushOwnershipStatus === 'cleanup-required' && 'Device registration remains paused until cleanup succeeds.'}</p>}
      {capabilities.permission === 'denied' && <span role="status">Permission is denied. Change notification permission in your browser or operating-system settings; ProgressTracker will not prompt again automatically.</span>}
      {pushState === 'unsupported' && !pushError && <span role="status">{capabilities.reason}</span>}
      <small>Closed-app delivery is not configured. Registering a device does not activate background reminders.</small>
    </div>
    <fieldset className="notification-preferences-fieldset" disabled={!preferencesReady} aria-describedby="notification-settings-status">
      <NotificationAccordion id="general" title="General notifications" summary={preferences.enabled ? 'On' : 'Off'} expanded={expandedGroup === 'general'} onToggle={() => setExpandedGroup((current) => current === 'general' ? null : 'general')}>
        <label className="notification-switch"><input type="checkbox" disabled={saving} checked={preferences.enabled} onChange={(event) => update('enabled', event.target.checked)} /><span><strong>Enable reminders in this account</strong><small>Evaluated while the authenticated app is open using local progress. Background delivery is separate and currently unavailable.</small></span></label>
      </NotificationAccordion>
      <NotificationAccordion id="daily" title="Daily reminders" summary={dailySummary} expanded={expandedGroup === 'daily'} onToggle={() => setExpandedGroup((current) => current === 'daily' ? null : 'daily')}>
        <p className="notification-group-note">Today’s unmarked activities, checked while the app is open. <InfoButton title="Daily reminders" summary="These reminders are for today’s activities that are still unmarked." description="Partially completed activities are controlled separately. Reminder times use your workspace timezone and checks run while the app is open." /></p>
        <label><input type="checkbox" checked={preferences.daily_enabled} onChange={(event) => update('daily_enabled', event.target.checked)} /> Remind me about unmarked activities</label>
        <TimeSlots kind="Daily reminder" values={preferences.daily_times} onChange={(times) => update('daily_times', times)} />
        <div className="notification-tracker-filter"><strong>Trackers <InfoButton title="Daily tracker selection" summary="Control which trackers can produce a daily reminder." description="All eligible trackers are included by default. Choosing trackers and leaving every box unchecked means there will be no daily tracker reminders." /></strong>
          <label><input type="radio" name="notification-tracker-scope" checked={preferences.tracker_ids === null} onChange={() => update('tracker_ids', null)} /> All eligible trackers</label>
          <label><input type="radio" name="notification-tracker-scope" checked={preferences.tracker_ids !== null} onChange={() => update('tracker_ids', [])} /> Choose trackers</label>
          {preferences.tracker_ids !== null && trackers.map((tracker) => <label key={tracker.id}><input type="checkbox" checked={preferences.tracker_ids?.includes(tracker.id) ?? false} onChange={(event) => update('tracker_ids', event.target.checked ? [...(preferences.tracker_ids ?? []), tracker.id] : (preferences.tracker_ids ?? []).filter((id) => id !== tracker.id))} /> {tracker.name}</label>)}
        </div>
      </NotificationAccordion>
      <NotificationAccordion id="incomplete" title="Missed and incomplete activity" summary={incompleteSummary} expanded={expandedGroup === 'incomplete'} onToggle={() => setExpandedGroup((current) => current === 'incomplete' ? null : 'incomplete')}>
        <label><input type="checkbox" checked={preferences.remind_partial} onChange={(event) => update('remind_partial', event.target.checked)} /> Also remind about partially completed targets</label>
        <p className="notification-group-note">Unresolved check-ins from yesterday. <InfoButton title="Previous-day overdue reminders" summary="These reminders cover unresolved check-ins from yesterday." description="They are separate from today’s daily reminders and use the overdue times below. Quiet hours apply unless you enable the overdue exception." /></p>
        <label><input type="checkbox" checked={preferences.overdue_enabled} onChange={(event) => update('overdue_enabled', event.target.checked)} /> Remind me about unresolved check-ins from yesterday</label>
        <TimeSlots kind="Yesterday overdue reminder" values={preferences.overdue_times} onChange={(times) => update('overdue_times', times)} />
      </NotificationAccordion>
      <NotificationAccordion id="motivation" title="Motivation" summary={motivationSummary} expanded={expandedGroup === 'motivation'} onToggle={() => setExpandedGroup((current) => current === 'motivation' ? null : 'motivation')}>
        <p className="notification-group-note">Choose the message source and schedule. <InfoButton title="Motivational messages" summary="Choose whether scheduled messages use general messages, your own messages, or both." description="Messages use the selected times and weekdays and are subject to the daily motivation limit. Custom Only will not fall back to general messages when none of your messages are enabled." /></p>
        <label className="form-field"><span>Message type</span><select className="auth-input" value={preferences.motivation_mode} onChange={(event) => update('motivation_mode', event.target.value as NotificationPreferences['motivation_mode'])}><option value="off">Off</option><option value="general">General messages</option><option value="custom">My messages only</option><option value="both">Both</option></select></label>
        <TimeSlots kind="Motivational message" values={preferences.motivation_times} onChange={(times) => update('motivation_times', times)} />
        <fieldset className="notification-weekday-fieldset"><legend>Send on these days</legend><div className="notification-weekdays" aria-label="Motivation weekdays">{([['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6],['Sun',0]] as const).map(([label, day]) => <label key={label}><input type="checkbox" checked={preferences.motivation_weekdays.includes(day)} onChange={(event) => update('motivation_weekdays', event.target.checked ? [...preferences.motivation_weekdays, day].sort() : preferences.motivation_weekdays.filter((value) => value !== day))} />{label}</label>)}</div></fieldset>
        <div className="custom-motivation-editor"><label className="form-field"><span>My messages</span><textarea className="auth-input" rows={2} maxLength={240} placeholder="Write a kind reminder to yourself" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} /></label><button className="button button-secondary button-small" disabled={!messageDraft.trim() || messageDraft.trim().length > 240} onClick={() => void addMessage()}>Add message</button>{preferences.motivation_mode === 'custom' && messages.every((item) => !item.enabled) && <p role="status">Add and enable a message to use Custom Only. General messages will not be substituted.</p>}{messages.map((item) => <div className="custom-message-row" key={item.id}>{editingMessageId === item.id ? <input aria-label="Edit motivation message" className="auth-input" maxLength={240} value={editingMessage} onChange={(event) => setEditingMessage(event.target.value)} /> : <span>{item.message}</span>}<label><input aria-label={`Enable message: ${item.message}`} type="checkbox" checked={item.enabled} onChange={() => void toggleMessage(item)} /> Enabled</label>{editingMessageId === item.id ? <button className="button button-secondary button-small" onClick={() => void saveMessageEdit(item.id)}>Save</button> : <button className="button button-secondary button-small" aria-label={`Edit message: ${item.message}`} onClick={() => { setEditingMessageId(item.id); setEditingMessage(item.message) }}>Edit</button>}<button className="button button-destructive button-small" aria-label={`Remove custom message: ${item.message}`} title="Remove this custom motivational message" onClick={() => void deleteMessage(item.id)}>Remove</button></div>)}</div>
      </NotificationAccordion>
      <NotificationAccordion id="quiet-hours" title="Quiet hours and limits" summary={quietHoursSummary} expanded={expandedGroup === 'quiet-hours'} onToggle={() => setExpandedGroup((current) => current === 'quiet-hours' ? null : 'quiet-hours')}>
        <p className="notification-group-note">Quiet hours and daily caps. <InfoButton title="Quiet hours and notification limits" summary="These controls limit when and how many reminders can be generated." description="Times and daily limits use the workspace timezone. Overdue reminders pause during quiet hours unless you enable the overdue exception." /></p>
        <label className="form-field"><span>Quiet hours start</span><input className="auth-input" type="time" value={preferences.quiet_start ?? ''} onChange={(event) => update('quiet_start', event.target.value || null)} /></label>
        <label className="form-field"><span>Quiet hours end</span><input className="auth-input" type="time" value={preferences.quiet_end ?? ''} onChange={(event) => update('quiet_end', event.target.value || null)} /></label>
        <label className="form-field"><span>Maximum notifications per day <InfoButton title="Daily notification limit" summary="Limit how many notifications can be generated in one day." description="This limit applies in the workspace timezone. It does not turn on closed-app delivery." /></span><input className="auth-input" type="number" min={1} max={20} value={preferences.daily_limit} onChange={(event) => update('daily_limit', Math.max(1, Math.min(20, Number(event.target.value))))} /></label>
        <label className="form-field"><span>Maximum motivation messages per day <InfoButton title="Motivation message limit" summary="Set a separate daily cap for motivational messages." description="Set this to zero to stop motivational messages without disabling other reminder types." /></span><input className="auth-input" type="number" min={0} max={5} value={preferences.motivation_daily_limit} onChange={(event) => update('motivation_daily_limit', Math.max(0, Math.min(5, Number(event.target.value))))} /></label>
        <label><input type="checkbox" checked={preferences.allow_overdue_during_quiet} onChange={(event) => update('allow_overdue_during_quiet', event.target.checked)} /> Allow overdue reminders during quiet hours</label>
        <p className="notification-timezone-note">Recurring times use {timeZone}. Times are local wall-clock times and schedule foreground checks only. <InfoButton title="Timezone and reminder timing" summary={`Reminder times use ${timeZone} as local wall-clock times.`} description="They are evaluated while the app is open. Changing your workspace timezone changes when the saved reminder times occur." /></p>
      </NotificationAccordion>
    </fieldset>
    <div className="notification-device-accordion">
      <NotificationAccordion id="device" title="Device and push notifications" summary={deviceSummary} expanded={expandedGroup === 'device'} onToggle={() => setExpandedGroup((current) => current === 'device' ? null : 'device')}>
        <p><strong>Device notifications:</strong> {capabilities.permission === 'granted' ? 'Enabled' : capabilities.permission === 'denied' ? 'Blocked in device settings' : 'Not enabled'}</p>
        {pushError && <p role="status">{pushError}</p>}
        {pushOwnershipStatus !== 'ready' && <p role="status">{pushOwnershipMessage} {pushOwnershipStatus === 'cleanup-required' && 'Device registration remains paused until cleanup succeeds.'}</p>}
        <p><strong>In-app reminders:</strong> {preferences.enabled ? 'Enabled while the app is open' : 'Off'}</p>
        <p><strong>Background reminders:</strong> Setup required. Device registration does not mean closed-app reminders are operational.</p>
        {capabilities.standalone && <small>Installed app display detected.</small>}
        {(pushState !== 'unsupported' && pushState !== 'permission-denied' || (capabilities.notificationApi && capabilities.permission === 'default') || capabilities.permission === 'granted') && <div className="notification-actions">{pushState !== 'unsupported' && pushState !== 'permission-denied' && <button className="button button-secondary button-small" disabled={pushBusy} onClick={() => void registerDevice(true)}>{pushBusy ? 'Registering…' : pushState === 'failed' ? 'Retry registration' : capabilities.permission === 'granted' ? 'Register this device' : 'Enable device registration'}</button>}{pushState === 'unsupported' && capabilities.notificationApi && capabilities.permission === 'default' && <button className="button button-secondary button-small" onClick={() => void requestDevicePermission()}>Enable on this device</button>}{pushState === 'registered' && <button className="button button-secondary button-small" disabled={pushBusy} onClick={() => void disableDevice()}>Remove device registration</button>}{capabilities.permission === 'granted' && capabilities.notificationApi && <button className="button button-secondary button-small" onClick={() => void sendTest()}>Send test notification</button>}</div>}
      </NotificationAccordion>
    </div>
  </section>
}

function NotificationAccordion({ id, title, summary, expanded, onToggle, children }: { id: NotificationGroup; title: string; summary: string; expanded: boolean; onToggle: () => void; children: ReactNode }) {
  const headingId = `notification-group-${id}-heading`
  const panelId = `notification-group-${id}-panel`
  return <section className="notification-accordion" aria-labelledby={headingId}>
    <h3 className="notification-accordion-heading"><button id={headingId} type="button" className="notification-accordion-trigger" aria-label={`${title} ${summary}`} aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}>
      <span className="notification-accordion-copy"><strong>{title}</strong><small>{summary}</small></span>
      <AppIcon className={`notification-accordion-chevron${expanded ? ' is-expanded' : ''}`} name="chevron-down" />
    </button></h3>
    <div id={panelId} className="notification-accordion-panel" role="region" aria-labelledby={headingId} hidden={!expanded}>{expanded ? children : null}</div>
  </section>
}

function formatReminderTime(value: string): string {
  const [hours, minutes] = value.split(':').map(Number)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
    .format(new Date(Date.UTC(2000, 0, 1, hours, minutes)))
}

function TimeSlots({ kind, values, onChange }: { kind: string; values: string[]; onChange: (times: string[]) => void }) {
  const [duplicateMessage, setDuplicateMessage] = useState('')
  const preferredTimes = ['20:00','12:00','08:00','14:00','19:00','21:00']
  const addTime = () => {
    const value = preferredTimes.find((time) => !values.includes(time))
      ?? Array.from({ length: 1440 }, (_, minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`).find((time) => !values.includes(time))
    if (value && values.length < 6) {
      setDuplicateMessage('')
      onChange([...values, value])
    }
  }
  return <div className="notification-times" role="group" aria-label={`${kind} times`}>
    {values.map((value, index) => {
      const shownTime = formatReminderTime(value)
      return <div className="notification-time-row" key={`${value}-${index}`}>
        <label className="notification-time-field">
          <span className="notification-time-copy"><strong>{shownTime}</strong><small>{kind}</small></span>
          <input type="time" value={value} aria-label={`Edit ${kind.toLocaleLowerCase()} time ${shownTime}`} onChange={(event) => {
            const nextTime = event.target.value
            if (!nextTime) return
            if (values.some((time, i) => i !== index && time === nextTime)) {
              setDuplicateMessage(`A ${kind.toLocaleLowerCase()} is already scheduled for ${formatReminderTime(nextTime)}.`)
              return
            }
            setDuplicateMessage('')
            onChange(values.map((time, i) => i === index ? nextTime : time))
          }} />
        </label>
        <button type="button" className="button button-destructive button-small notification-remove-time" aria-label={`Remove ${shownTime} ${kind.toLocaleLowerCase()}`} title={`Remove ${shownTime} ${kind.toLocaleLowerCase()}`} onClick={() => onChange(values.filter((_, i) => i !== index))}>
          <AppIcon name="bin" /><span>Remove</span>
        </button>
      </div>
    })}
    {duplicateMessage && <p className="notification-inline-status" role="status">{duplicateMessage}</p>}
    {values.length === 0 && <p className="notification-empty-times">No times are set. This reminder type will not run.</p>}
    <button type="button" className="button button-secondary button-small notification-add-time" disabled={values.length >= 6} onClick={addTime}>Add time</button>
  </div>
}
