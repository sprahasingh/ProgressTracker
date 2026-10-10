import { useCallback, useEffect } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { getSupabaseClient } from '../../services/supabase/client'
import { localRepository } from '../../db/localRepository'
import { localCalendarDate } from '../shared/localDates'
import { buildReminderCandidate, dueLocalSlot, isWithinQuietHours, previousLocalDate, type ReminderCandidate } from './reminderRules'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { subscribeToWorkspaceMutations } from '../../db/workspaceMutationEvents'
import { chooseMotivation } from './motivation'

/** Evaluates due items when the authenticated app is active; it is not a background scheduler. */
export function ForegroundReminderMonitor({ enabled }: { enabled: boolean }) {
  const { status, user } = useAuth()
  const { timeZone } = useWorkspaceTimeZone()
  const reconcile = useCallback(async () => {
    if (!enabled || status !== 'signed-in' || !user) return
    const client = getSupabaseClient()
    if (!client || typeof client.from !== 'function') return
    const { data: prefs, error } = await client.from('notification_preferences').select('*').eq('user_id', user.id).maybeSingle()
    if (error || !prefs?.enabled) return
    const now = new Date()
    const today = localCalendarDate(now, timeZone)
    const yesterday = previousLocalDate(today)
    const [trackers, entries, holidays] = await Promise.all([
      localRepository.listTrackers(), localRepository.listTrackerEntriesBetween(yesterday, today), localRepository.listAccountHolidays(yesterday, today),
    ])
    const holidaySet = new Set(holidays.map((holiday) => holiday.date))
    const candidates: ReminderCandidate[] = []
    const eligibleTrackers = prefs.tracker_ids ? trackers.filter((tracker) => prefs.tracker_ids.includes(tracker.id)) : trackers
    const quiet = isWithinQuietHours(now, timeZone, prefs.quiet_start?.slice(0, 5), prefs.quiet_end?.slice(0, 5))
    const dueDaily = prefs.daily_enabled && !quiet ? dueLocalSlot(now, timeZone, (prefs.daily_times ?? []).map((time: string) => time.slice(0, 5))) : null
    if (dueDaily) {
      const candidate = buildReminderCandidate({ trackers: eligibleTrackers, entries, holidays: holidaySet, date: today, kind: 'pending', includePartial: prefs.remind_partial, slot: dueDaily })
      if (candidate) candidates.push(candidate)
    }
    const dueOverdue = prefs.overdue_enabled && (!quiet || prefs.allow_overdue_during_quiet) ? dueLocalSlot(now, timeZone, (prefs.overdue_times ?? []).map((time: string) => time.slice(0, 5))) : null
    if (dueOverdue) {
      const candidate = buildReminderCandidate({ trackers: eligibleTrackers, entries, holidays: holidaySet, date: yesterday, kind: 'overdue', slot: dueOverdue })
      if (candidate) candidates.push(candidate)
    }
    const motivationSlot = prefs.motivation_mode !== 'off' && !quiet ? dueLocalSlot(now, timeZone, (prefs.motivation_times ?? []).map((time: string) => time.slice(0, 5))) : null
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now)
    const weekdayNumber = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
    const dailyRecords = await localRepository.listAppNotifications()
    const notificationsToday = dailyRecords.filter((row) => localCalendarDate(new Date(row.createdAt), timeZone) === today)
    const cap = Math.max(1, Number(prefs.daily_limit) || 4)
    if (motivationSlot && (prefs.motivation_weekdays ?? []).includes(weekdayNumber)
      && notificationsToday.filter((row) => row.kind === 'motivation').length < (Number.isFinite(Number(prefs.motivation_daily_limit)) ? Math.max(0, Number(prefs.motivation_daily_limit)) : 1)) {
      const { data: customRows } = await client.from('custom_motivation_messages').select('message').eq('user_id', user.id).eq('enabled', true)
      const customMessages = (customRows ?? []).map((row: { message: string }) => row.message)
      const recentMotivation = dailyRecords.filter((row) => row.kind === 'motivation').slice(0, 3).map((row) => row.body)
      const lastSource = dailyRecords.find((row) => row.kind === 'motivation')?.body && customMessages.includes(dailyRecords.find((row) => row.kind === 'motivation')!.body) ? 'custom' : 'general'
      const chosen = chooseMotivation({ mode: prefs.motivation_mode, customMessages, recentMessages: recentMotivation, sequence: notificationsToday.filter((row) => row.kind === 'motivation').length, lastSource })
      if (chosen) candidates.push({ identity: `motivation:${today}:${motivationSlot}`, kind: 'motivation', title: 'A small note for today', body: chosen.message, href: '/', date: today, trackerIds: [] })
    }
    const previous = await localRepository.listAppNotifications()
    const stillRelevant = new Set(candidates.map((candidate) => candidate.identity))
    for (const row of previous) {
      const match = /^(pending|overdue)-reminder:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/.exec(row.identity)
      if (!match || (match[2] !== today && match[2] !== yesterday)) continue
      const kind = match[1] as 'pending' | 'overdue'
      const date = match[2] as typeof today
      const candidate = kind === 'pending' && prefs.daily_enabled
        ? buildReminderCandidate({ trackers: eligibleTrackers, entries, holidays: holidaySet, date, kind, includePartial: prefs.remind_partial, slot: match[3]! })
        : kind === 'overdue' && prefs.overdue_enabled
          ? buildReminderCandidate({ trackers: eligibleTrackers, entries, holidays: holidaySet, date, kind, slot: match[3]! }) : null
      if (candidate) stillRelevant.add(row.identity)
    }
    const dates = [today, yesterday]
    const staleIdentities = await localRepository.removeUnreadReminderNotifications(dates, stillRelevant)
    if (staleIdentities.length && 'serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration()
      const staleTags = new Set(staleIdentities.map((identity) => `progress-tracker:${identity}`))
      for (const notification of await registration?.getNotifications() ?? []) if (notification.tag && staleTags.has(notification.tag)) notification.close()
    }
    const priority: Record<ReminderCandidate['kind'], number> = { overdue: 0, pending: 1, motivation: 2 }
    const prioritized = [...candidates].sort((a, b) => priority[a.kind] - priority[b.kind])
    const used = notificationsToday.filter((row) => !candidates.some((candidate) => candidate.identity === row.identity)).length
    const deliverable = prioritized.slice(0, Math.max(0, cap - used))
    const previousIdentities = new Set(previous.map((row) => row.identity))
    for (const candidate of deliverable) {
      const alreadyShown = previousIdentities.has(candidate.identity)
      const row = await localRepository.putAppNotification(candidate)
      if (!alreadyShown && 'Notification' in globalThis && Notification.permission === 'granted') {
        const registration = await navigator.serviceWorker?.getRegistration()
        if (registration?.showNotification) await registration.showNotification(candidate.title, { body: candidate.body, icon: `${import.meta.env.BASE_URL}icons/progress-tracker.svg`, tag: `progress-tracker:${candidate.identity}`, data: { url: `${window.location.origin}${import.meta.env.BASE_URL}#${candidate.href}` } })
        else new Notification(candidate.title, { body: candidate.body, tag: `progress-tracker:${candidate.identity}` })
      }
      void row
    }
  }, [enabled, status, user?.id, timeZone])
  useEffect(() => {
    if (!enabled || status !== 'signed-in') return
    void reconcile().catch(() => undefined)
    const onFocus = () => { void reconcile().catch(() => undefined) }
    const onVisibility = () => { if (document.visibilityState === 'visible') void reconcile().catch(() => undefined) }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribe = subscribeToWorkspaceMutations(() => { void reconcile().catch(() => undefined) })
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility); unsubscribe() }
  }, [enabled, reconcile, status])
  return null
}
