import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/ui/PageHeader'
import { SectionHeader } from '../../components/ui/SectionHeader'
import { ActivityStatusIcon } from '../../components/ui/ActivityStatusIcon'
import { Surface } from '../../components/ui/Surface'
import { useToast } from '../../components/ui/ToastProvider'
import { localRepository } from '../../db/localRepository'
import { useWorkspaceDataChanges } from '../../db/useWorkspaceDataChanges'
import { useAuth } from '../auth/AuthProvider'
import type { AccountHoliday, CalendarDate, HolidayReason } from '../../db/models'
import { expandHolidayRange } from '../../domain/holidays'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { calendarDateLabel, localCalendarDate } from '../shared/localDates'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { isHolidayPermanentDeletionEnabled } from '../../domain/trackers/schemaVersionGate'
import { holidayDeletionNotificationKey, publishHolidayDeletionNotification } from '../../services/holidayDeletionNotifications'

const reasonLabel: Record<HolidayReason, string> = { travel: 'Travel', exam: 'Exam', personal: 'Personal', other: 'Other' }

export function HolidaysPage() {
  const { notify } = useToast()
  const { status, user, workspaceStatus, workspaceUserId, sessionTransitionPending, syncNow, isOnline } = useAuth()
  const owner = status === 'signed-in' ? user?.id ?? null : null
  const workspaceReady = !sessionTransitionPending && status !== 'loading' && workspaceStatus === 'ready' && workspaceUserId === owner
  const workspaceKey = workspaceReady ? owner ?? 'guest' : null
  const [search] = useSearchParams()
  const { timeZone } = useWorkspaceTimeZone()
  const today = localCalendarDate(new Date(), timeZone)
  const suggested = search.get('date') ?? today
  const [startDate, setStartDate] = useState(suggested)
  const [endDate, setEndDate] = useState(suggested)
  const [reason, setReason] = useState<HolidayReason | ''>('')
  const [rows, setRows] = useState<AccountHoliday[]>([])
  const [allRows, setAllRows] = useState<AccountHoliday[]>([])
  const [deletionRequests, setDeletionRequests] = useState<Awaited<ReturnType<typeof localRepository.listPermanentHolidayDeletionRequests>>>([])
  const [confirmDeletion, setConfirmDeletion] = useState<AccountHoliday | null>(null)
  const [busyHolidayId, setBusyHolidayId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const requestGeneration = useRef(0)
  const workspaceRef = useRef({ key: workspaceKey, ready: workspaceReady })
  workspaceRef.current = { key: workspaceKey, ready: workspaceReady }

  const refresh = useCallback(async () => {
    const context = workspaceRef.current
    if (!context.ready || !context.key) return
    const generation = ++requestGeneration.current
    setLoading(true)
    try {
      const [live, all, requests] = await Promise.all([
        localRepository.listAccountHolidays(), localRepository.listAccountHolidays(undefined, undefined, true),
        context.key === 'guest' ? Promise.resolve([]) : localRepository.listPermanentHolidayDeletionRequests(context.key),
      ])
      if (requestGeneration.current !== generation || !workspaceRef.current.ready || workspaceRef.current.key !== context.key) return
      setRows(live)
      setAllRows(all)
      setDeletionRequests(requests)
      setError('')
    } catch { if (requestGeneration.current === generation && workspaceRef.current.key === context.key) setError('Holidays could not be loaded from this workspace.') }
    finally { if (requestGeneration.current === generation && workspaceRef.current.key === context.key) setLoading(false) }
  }, [])
  useEffect(() => { if (workspaceReady) void refresh() }, [refresh, workspaceReady, workspaceKey])
  useWorkspaceDataChanges(owner, workspaceReady, refresh)

  async function addRange(event: React.FormEvent) {
    event.preventDefault(); setError('')
    try {
      const dates = expandHolidayRange(startDate, endDate)
      await localRepository.saveAccountHolidays(dates, reason || null)
      await refresh()
      notify({ kind: 'success', title: dates.length === 1 ? 'Holiday added' : 'Holidays added', description: `${dates.length} ${dates.length === 1 ? 'date was' : 'dates were'} saved. Existing check-ins are unchanged.`, dedupeKey: 'holidays' })
    } catch { notify({ kind: 'error', title: 'Couldn’t save holiday dates', description: 'Your changes were not saved. Please try again.', duration: 0, dedupeKey: 'holidays' }) }
  }
  async function remove(date: CalendarDate) {
    try { await localRepository.removeAccountHoliday(date); await refresh(); notify({ kind: 'success', title: 'Holiday removed', description: `${calendarDateLabel(date)} was removed. Activity history was preserved.`, dedupeKey: `holiday:${date}` }) }
    catch { notify({ kind: 'error', title: 'Couldn’t remove holiday', description: 'The holiday is unchanged. Please try again.', duration: 0, dedupeKey: `holiday:${date}` }) }
  }
  async function restore(date: CalendarDate) {
    try { await localRepository.restoreAccountHoliday(date); await refresh(); notify({ kind: 'success', title: 'Holiday restored', description: `${calendarDateLabel(date)} is a holiday again.`, dedupeKey: `holiday:${date}` }) }
    catch { notify({ kind: 'error', title: 'Couldn’t restore holiday', description: 'The holiday is unchanged. Please try again.', duration: 0, dedupeKey: `holiday:${date}` }) }
  }

  async function permanentlyDeleteHoliday(holiday: AccountHoliday) {
    const key = holidayDeletionNotificationKey(owner ?? 'guest', holiday.id)
    setBusyHolidayId(holiday.id)
    try {
      const result = await localRepository.requestPermanentHolidayDeletion(holiday.date)
      if (result === 'deleted') {
        await refresh()
        notify({ kind: 'success', title: 'Holiday permanently deleted.', duration: 4000, dedupeKey: key })
      } else {
        publishHolidayDeletionNotification({ status: 'queued', ownerUserId: owner!, holidayId: holiday.id, holidayDate: holiday.date })
        await refresh()
        if (isOnline) void syncNow().catch((cause: unknown) => publishHolidayDeletionNotification({
          status: 'failed', ownerUserId: owner!, holidayId: holiday.id, holidayDate: holiday.date,
          message: cause instanceof Error ? cause.message : 'Sync could not confirm the request.',
        }))
      }
    } catch (cause) {
      notify({ kind: 'error', title: 'Couldn’t request permanent deletion', description: cause instanceof Error ? cause.message : 'The holiday is unchanged. Check your connection and try again.', duration: 0, dedupeKey: key })
    } finally { setBusyHolidayId(null) }
  }

  return <section className="tracker-page holidays-page" aria-labelledby="holidays-title">
    <PageHeader headingId="holidays-title" eyebrow="REST WITHOUT LOSING YOUR RHYTHM" title="Holidays & Breaks" description="Mark account-wide days off for your trackers and goal plans." help={{ title: 'Holidays & Breaks', summary: 'A holiday pauses Standard Mode scheduled expectations for each tracker.', description: 'Holidays are saved as calendar dates in this workspace, work offline, and sync with your signed-in account. They do not delete or change recorded check-ins. Standard Mode streaks pause across holidays; Strict Mode still requires qualifying activity. Goal plans apply their own schedule and holiday rules.' }} />
    <Surface className="holiday-form-surface"><form onSubmit={(event) => void addRange(event)} className="holiday-form">
      <div><h2>Plan a break</h2><p>Choose one date or a range. Dates follow your workspace time zone: {timeZone}.</p></div>
      <label className="form-field"><span>From</span><input className="auth-input" type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); if (endDate < event.target.value) setEndDate(event.target.value) }} required /></label>
      <label className="form-field"><span>Through</span><input className="auth-input" type="date" min={startDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label>
      <label className="form-field"><span>Reason <em>· optional</em></span><select className="auth-input" value={reason} onChange={(event) => setReason(event.target.value as HolidayReason | '')}><option value="">No reason</option>{Object.entries(reasonLabel).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <button className="button button-primary button-medium" type="submit">Mark holiday</button>
    </form></Surface>
    <Surface className="holiday-about"><h2>About holidays</h2><p>Holidays apply to all trackers. Standard Mode pauses scheduled check-ins; Strict Mode still expects activity. Existing check-ins are preserved. Goal plans follow their own schedule rules.</p></Surface>
    {error && <p role="alert" className="form-alert">{error}</p>}
    <section aria-labelledby="holiday-list-title"><SectionHeader className="holiday-list-heading" title="Your holidays" headingId="holiday-list-title" action={<Link to="/calendar">View calendar</Link>} />
      {loading ? <p role="status" className="tracker-loading">Loading holidays…</p> : rows.length === 0 ? <Surface><p>No holidays added yet. Your tracker schedules continue as usual.</p></Surface> : <div className="holiday-list">{rows.map((row) => <HolidayRow key={row.id} row={row} onRemove={() => void remove(row.date)} onSave={async (next) => { try { await localRepository.saveAccountHolidays([row.date], next); await refresh(); notify({ kind: 'success', title: 'Holiday updated', description: 'Your holiday details were saved on this device.', dedupeKey: `holiday:${row.date}` }) } catch { notify({ kind: 'error', title: 'Couldn’t update holiday', description: 'Your changes were not saved. Please try again.', duration: 0, dedupeKey: `holiday:${row.date}` }) } }} />)}</div>}
    </section>
    {allRows.some((row) => row.deletedAt !== null) && <details className="holiday-removed"><summary>Recently deleted holidays</summary><p>Deleted dates can be restored or permanently deleted. Account holidays remain recoverable for 30 days.</p><div className="holiday-list">{allRows.filter((row) => row.deletedAt !== null).map((row) => {
      const request = deletionRequests.find((item) => item.holidayId === row.id)
      const pending = request?.status === 'pending'
      const permanentEnabled = isHolidayPermanentDeletionEnabled()
      return <Surface className="holiday-row holiday-removed-row" key={row.id}>
        <div><strong>{calendarDateLabel(row.date)}</strong><small>{pending ? 'Permanent deletion pending server confirmation.' : request?.status === 'conflict' ? request.lastError ?? 'Resolve the sync conflict before retrying.' : request?.lastError ? `Deletion not confirmed. Sync again to retry. ${request.lastError}` : 'Removed holiday'}</small></div>
        <HolidayActionsMenu date={row.date} restoreDisabled={Boolean(busyHolidayId) || pending} deleteDisabled={!permanentEnabled || Boolean(busyHolidayId) || pending} onRestore={() => void restore(row.date)} onDelete={() => setConfirmDeletion(row)} />
      </Surface>
    })}</div>{owner && !isOnline && <p role="status">You’re offline. Confirmed deletion requests stay pending until the server is reachable.</p>}{!isHolidayPermanentDeletionEnabled() && <p role="status">Permanent deletion is unavailable until this app version is configured for the holiday deletion service.</p>}</details>}
    {confirmDeletion && <ConfirmActionDialog title={`Delete ${calendarDateLabel(confirmDeletion.date)} permanently?`} description={owner ? 'This permanently removes the holiday from this account and cannot be undone. The app will keep the request pending until the server confirms deletion. Other devices will remove it after they sync.' : 'This permanently removes the holiday from this guest workspace on this device and cannot be undone.'} actionLabel={busyHolidayId === confirmDeletion.id ? 'Deleting…' : 'Delete permanently'} destructive actionDisabled={busyHolidayId === confirmDeletion.id} onCancel={() => setConfirmDeletion(null)} onConfirm={() => { const holiday = confirmDeletion; setConfirmDeletion(null); void permanentlyDeleteHoliday(holiday) }} />}
    <p className="holiday-sync-note"><span className="sync-dot" /> Saved on this device first. Account holidays sync when signed in and online; guest holidays stay in the guest workspace.</p>
  </section>
}

function HolidayActionsMenu({ date, restoreDisabled, deleteDisabled, onRestore, onDelete }: {
  date: CalendarDate
  restoreDisabled: boolean
  deleteDisabled: boolean
  onRestore: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const dismissOutside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        if (!items?.length) return
        event.preventDefault()
        const current = [...items].indexOf(document.activeElement as HTMLButtonElement)
        items[event.key === 'ArrowDown' ? (current + 1) % items.length : (current <= 0 ? items.length - 1 : current - 1)]?.focus()
      }
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', handleKey)
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => { document.removeEventListener('pointerdown', dismissOutside); document.removeEventListener('keydown', handleKey) }
  }, [open])
  function run(action: () => void) { setOpen(false); action() }
  return <div className="tracker-actions-menu holiday-actions-menu" ref={rootRef}>
    <button ref={triggerRef} type="button" className="button button-secondary button-small tracker-actions-trigger" aria-label={`More actions for ${date}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>⋯</button>
    {open && <div className="tracker-actions-popover" role="menu" aria-label={`${date} holiday actions`} ref={menuRef}>
      <button type="button" role="menuitem" disabled={restoreDisabled} onClick={() => run(onRestore)}>Restore</button>
      <button type="button" role="menuitem" className="destructive" disabled={deleteDisabled} onClick={() => run(onDelete)}>Delete permanently</button>
    </div>}
  </div>
}

function HolidayRow({ row, onRemove, onSave }: { row: AccountHoliday; onRemove: () => void; onSave: (reason: HolidayReason | null) => Promise<void> }) {
  const [reason, setReason] = useState<HolidayReason | ''>(row.reason ?? '')
  return <Surface className="holiday-row"><div><strong><span className="status-mark holiday"><ActivityStatusIcon status="holiday" /></span> {calendarDateLabel(row.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong><small>Applies to all trackers and goals</small></div><label className="sr-only" htmlFor={`holiday-reason-${row.id}`}>Reason for {row.date}</label><select id={`holiday-reason-${row.id}`} className="auth-input" value={reason} onChange={(event) => setReason(event.target.value as HolidayReason | '')}><option value="">No reason</option>{Object.entries(reasonLabel).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select><button className="button button-secondary button-small" onClick={() => void onSave(reason || null)}>Save</button><button className="button button-quiet button-small" onClick={onRemove}>Remove</button></Surface>
}
