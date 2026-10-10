import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { localRepository } from '../db/localRepository'
import type { AppNotification } from '../db/models'
import { getSupabaseClient } from '../services/supabase/client'

const color: Record<AppNotification['kind'], string> = { pending: '#EAB308', overdue: '#EF4444', motivation: '#F97316', achievement: '#22C55E', holiday: '#8B5CF6', info: 'var(--ink-muted)' }
type CenterItem = AppNotification & { remote?: boolean }

export function NotificationCenter({ ownerUserId, ready }: { ownerUserId: string | null; ready: boolean }) {
  const [items, setItems] = useState<CenterItem[]>([])
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  useEffect(() => {
    let current = true
    setItems([])
    const refresh = () => {
      if (ready && typeof localRepository.listAppNotifications === 'function') void Promise.all([
        localRepository.listAppNotifications(),
        ownerUserId && typeof getSupabaseClient()?.from === 'function' ? getSupabaseClient()!.from('app_notifications').select('id,dedupe_key,category,title,body,href,created_at,read_at').eq('user_id', ownerUserId).order('created_at', { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
      ]).then(([localRows, cloudResult]) => {
        if (!current) return
        const cloudRows = cloudResult.data ?? []
        const identities = new Set(cloudRows.map((row: { dedupe_key: string }) => row.dedupe_key))
        const merged: CenterItem[] = [...cloudRows.map((row: { id: string; dedupe_key: string; category: AppNotification['kind']; title: string; body: string; href: string; created_at: string; read_at: string | null }) => ({ id: row.id, identity: row.dedupe_key, kind: row.category, title: row.title, body: row.body, href: row.href, createdAt: row.created_at, readAt: row.read_at, remote: true })), ...localRows.filter((row) => !identities.has(row.identity))]
        setItems(merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
      }).catch(() => { if (current) setItems([]) })
    }
    refresh()
    window.addEventListener('app-notifications-changed', refresh)
    return () => { current = false; window.removeEventListener('app-notifications-changed', refresh) }
  }, [ownerUserId, ready])
  const unread = items.filter((item) => !item.readAt).length
  async function markAll() {
    await localRepository.markAllAppNotificationsRead()
    const now = new Date().toISOString()
    const remoteIds = items.filter((item) => item.remote && !item.readAt).map((item) => item.id)
    if (ownerUserId && remoteIds.length) await getSupabaseClient()?.from('app_notifications').update({ read_at: now }).in('id', remoteIds).eq('user_id', ownerUserId)
    setItems((rows) => rows.map((row) => ({ ...row, readAt: row.readAt ?? now })))
  }
  async function openNotification(item: AppNotification) {
    const centerItem = item as CenterItem
    if (centerItem.remote && ownerUserId) await getSupabaseClient()?.from('app_notifications').update({ read_at: new Date().toISOString() }).eq('id', item.id).eq('user_id', ownerUserId)
    else await localRepository.markAppNotificationRead(item.id)
    setItems((rows) => rows.map((row) => row.id === item.id ? { ...row, readAt: row.readAt ?? new Date().toISOString() } : row))
    setOpen(false)
    if (item.href.startsWith('/') && !item.href.startsWith('//') && !item.href.includes('://')) navigate(item.href)
  }
  return <div className="notification-center">
    <button className="notification-center-trigger" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{unread > 0 && <span>{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <section className="notification-center-panel" aria-label="Notification center"><header><strong>Notifications</strong>{unread > 0 && <button className="button button-secondary button-small" onClick={() => void markAll()}>Mark all read</button>}<button className="notification-center-close" aria-label="Close notifications" onClick={() => setOpen(false)}>×</button></header>
      {items.length === 0 ? <p className="notification-center-empty">You're all caught up. New reminders and updates will appear here.</p> : <ul>{items.map((item) => <li key={item.id} className={item.readAt ? 'is-read' : 'is-unread'}><button onClick={() => void openNotification(item)}><i style={{ backgroundColor: color[item.kind] }} /><span><strong>{item.title}</strong><small>{item.body}</small><time dateTime={item.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}</time></span></button></li>)}</ul>}
    </section>}
  </div>
}
