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
import type { AccountHoliday, CalendarDate, HolidayReason, StoredTrackerDefinition, TrackerHoliday } from '../../db/models'
import { expandHolidayRange } from '../../domain/holidays'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { calendarDateLabel, localCalendarDate } from '../shared/localDates'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { InfoButton } from '../../components/ui/InfoButton'
import { isHolidayPermanentDeletionEnabled } from '../../domain/trackers/schemaVersionGate'
import { holidayDeletionNotificationKey, publishHolidayDeletionNotification } from '../../services/holidayDeletionNotifications'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { assertHolidayDate, isHolidayReason } from '../../domain/holidays'
import { createPortal } from 'react-dom'
import { trackerStrictModeForDate } from '../../domain/trackers/ruleVersions'

const reasonLabel: Record<HolidayReason, string> = { travel: 'Travel', exam: 'Exam', personal: 'Personal', other: 'Other' }
const holidayScopeHelp = {
  title: 'Apply holiday to',
  label: 'Explain holiday scope',
  compact: true,
  summary: 'All trackers creates a global holiday, but only Standard Mode requirements are excused.',
  description: 'Selected trackers applies only to chosen Standard Mode trackers. Strict Mode trackers cannot receive holiday exemptions and continue following their normal requirements. Positive recorded progress overrides the holiday for that tracker and date. Clearing that check-in restores the holiday.',
} as const
type HolidayScope = 'global' | 'selected'
type HolidayDesignation = { scope: 'global'; holiday: AccountHoliday } | { scope: 'selected'; date: CalendarDate; trackerIds: string[] }
type HolidayEditValue = { date: CalendarDate; scope: HolidayScope; trackerIds: string[]; reason: HolidayReason | null }
type TrackerHolidayGroup = { date: CalendarDate; rows: TrackerHoliday[]; trackerIds: string[] }

function groupTrackerHolidays(rows: TrackerHoliday[]): TrackerHolidayGroup[] {
  const groups = new Map<CalendarDate, TrackerHoliday[]>()
  for (const row of rows) groups.set(row.date, [...(groups.get(row.date) ?? []), row])
  return [...groups.entries()].map(([date, groupRows]) => ({ date, rows: groupRows, trackerIds: groupRows.map((row) => row.trackerId).sort() })).sort((a, b) => a.date.localeCompare(b.date))
}

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
  const [scope, setScope] = useState<HolidayScope>('global')
  const [selectedTrackerIds, setSelectedTrackerIds] = useState<string[]>([])
  const [rows, setRows] = useState<AccountHoliday[]>([])
  const [trackers, setTrackers] = useState<StoredTrackerDefinition[]>([])
  const [trackerHolidays, setTrackerHolidays] = useState<TrackerHoliday[]>([])
  const [allRows, setAllRows] = useState<AccountHoliday[]>([])
  const [deletionRequests, setDeletionRequests] = useState<Awaited<ReturnType<typeof localRepository.listPermanentHolidayDeletionRequests>>>([])
  const [confirmDeletion, setConfirmDeletion] = useState<AccountHoliday | null>(null)
  const [editingHoliday, setEditingHoliday] = useState<HolidayDesignation | null>(null)
  const editTriggerRef = useRef<HTMLButtonElement | null>(null)
  const wasEditing = useRef(false)
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
      const [live, all, requests, trackerList, trackerHolidayList] = await Promise.all([
        localRepository.listAccountHolidays(), localRepository.listAccountHolidays(undefined, undefined, true),
        context.key === 'guest' ? Promise.resolve([]) : localRepository.listPermanentHolidayDeletionRequests(context.key),
        localRepository.listTrackers(true), localRepository.listTrackerHolidays(),
      ])
      if (requestGeneration.current !== generation || !workspaceRef.current.ready || workspaceRef.current.key !== context.key) return
      setRows(live)
      setTrackers(trackerList)
      setTrackerHolidays(trackerHolidayList)
      setAllRows(all)
      setDeletionRequests(requests)
      setError('')
    } catch { if (requestGeneration.current === generation && workspaceRef.current.key === context.key) setError('Holidays could not be loaded from this workspace.') }
    finally { if (requestGeneration.current === generation && workspaceRef.current.key === context.key) setLoading(false) }
  }, [])
  useEffect(() => { if (workspaceReady) void refresh() }, [refresh, workspaceReady, workspaceKey])
  useWorkspaceDataChanges(owner, workspaceReady, refresh)
  useEffect(() => {
    if (editingHoliday) wasEditing.current = true
    else if (wasEditing.current) { wasEditing.current = false; editTriggerRef.current?.focus() }
  }, [editingHoliday])

  const datesInForm = (() => { try { return expandHolidayRange(startDate, endDate) } catch { return [] } })()
  const eligibleTrackers = trackers.filter((tracker) => tracker.deletedAt === null && tracker.status === 'active'
    && datesInForm.length > 0 && datesInForm.every((date) => !trackerStrictModeForDate(tracker, date)))

  async function syncHolidayChanges(key: string, description: string) {
    if (owner && isOnline) void syncNow().catch(() => notify({ kind: 'warning', title: 'Holiday saved, sync pending', description, duration: 0, dedupeKey: key }))
  }

  async function addRange(event: React.FormEvent) {
    event.preventDefault(); setError('')
    try {
      const dates = expandHolidayRange(startDate, endDate)
      if (scope === 'global') await localRepository.saveAccountHolidays(dates, reason || null)
      else {
        if (selectedTrackerIds.length === 0) throw new Error('Select at least one Standard Mode tracker.')
        await localRepository.setTrackerHolidaySelections(dates.map((date) => ({ date, trackerIds: selectedTrackerIds })))
      }
      await refresh()
      const key = `holidays:${scope}:${startDate}:${endDate}`
      notify({ kind: 'success', title: dates.length === 1 ? 'Holiday added' : 'Holidays added', description: `${dates.length} ${dates.length === 1 ? 'date was' : 'dates were'} saved.`, dedupeKey: key })
      await syncHolidayChanges(key, 'Your holiday is saved on this device. Sync again when your connection is available.')
    } catch (cause) { notify({ kind: 'error', title: 'Couldn’t save holiday dates', description: cause instanceof Error ? cause.message : 'Your changes were not saved. Please try again.', duration: 0, dedupeKey: 'holidays' }) }
  }
  async function remove(date: CalendarDate) {
    try { await localRepository.removeAccountHoliday(date); await refresh(); notify({ kind: 'success', title: 'Holiday removed', description: `${calendarDateLabel(date)} was removed. Activity history was preserved.`, dedupeKey: `holiday:${date}` }) }
    catch { notify({ kind: 'error', title: 'Couldn’t remove holiday', description: 'The holiday is unchanged. Please try again.', duration: 0, dedupeKey: `holiday:${date}` }) }
  }
  async function restore(date: CalendarDate) {
    try { await localRepository.restoreAccountHoliday(date); await refresh(); notify({ kind: 'success', title: 'Holiday restored', description: `${calendarDateLabel(date)} is a holiday again.`, dedupeKey: `holiday:${date}` }) }
    catch { notify({ kind: 'error', title: 'Couldn’t restore holiday', description: 'The holiday is unchanged. Please try again.', duration: 0, dedupeKey: `holiday:${date}` }) }
  }

  const trackerHolidayGroups = groupTrackerHolidays(trackerHolidays)
  async function removeTrackerHolidayGroup(group: TrackerHolidayGroup) {
    const key = `holiday:selected:${group.date}`
    try { await localRepository.setTrackerHolidaySelections([{ date: group.date, trackerIds: [] }]); await refresh(); notify({ kind: 'success', title: 'Selected holiday removed', description: `${calendarDateLabel(group.date)} was removed from the selected trackers.`, dedupeKey: key }); await syncHolidayChanges(key, 'Your change is saved on this device. Sync again when your connection is available.') }
    catch { notify({ kind: 'error', title: 'Couldn’t remove selected holiday', description: 'The holiday was not changed.', duration: 0, dedupeKey: key }) }
  }

  async function saveEditedHoliday(value: HolidayEditValue) {
    if (!editingHoliday) return
    const sourceScope = editingHoliday.scope
    const sourceDate = editingHoliday.scope === 'global' ? editingHoliday.holiday.date : editingHoliday.date
    if (value.scope === 'selected' && value.trackerIds.length === 0) throw new Error('Select at least one Standard Mode tracker.')
    if (value.scope === 'global') {
      const duplicate = rows.find((row) => row.date === value.date && !(editingHoliday.scope === 'global' && row.id === editingHoliday.holiday.id))
      if (duplicate) throw new Error(editingHoliday.scope === 'global' ? 'A holiday record already exists on that date.' : 'A global holiday already exists on that date. Remove it before changing this holiday to Global.')
      if (sourceScope === 'global') await localRepository.updateAccountHoliday(editingHoliday.holiday.id, value.date, value.reason)
      else {
        await localRepository.convertHolidayScope({ source: { scope: 'selected', date: sourceDate }, date: value.date, scope: 'global', reason: value.reason, trackerIds: [] })
      }
    } else {
      if ((value.date !== sourceDate || sourceScope === 'global') && trackerHolidayGroups.some((group) => group.date === value.date)) throw new Error('Selected holidays already exist on that date. Edit that selection first to avoid merging scopes.')
      const updates: Array<{ date: CalendarDate; trackerIds: string[] }> = []
      if (sourceScope === 'selected' && sourceDate !== value.date) updates.push({ date: sourceDate, trackerIds: [] })
      if (sourceScope === 'global') {
        await localRepository.convertHolidayScope({ source: { scope: 'global', id: editingHoliday.holiday.id }, date: value.date, scope: 'selected', reason: value.reason, trackerIds: value.trackerIds })
      } else {
        updates.push({ date: value.date, trackerIds: value.trackerIds })
        await localRepository.setTrackerHolidaySelections(updates)
      }
    }
    await refresh()
    setEditingHoliday(null)
    const key = `holiday:${value.scope}:${value.date}`
    notify({ kind: 'success', title: 'Holiday updated', description: owner ? (isOnline ? 'Changes are saved on this device and syncing with your account.' : 'Changes are saved on this device. Sync will resume when you are online.') : 'Your holiday changes were saved on this device.', dedupeKey: key })
    await syncHolidayChanges(key, 'Your change is safe on this device. Check your connection and sync again.')
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
    <PageHeader headingId="holidays-title" eyebrow="REST WITHOUT LOSING YOUR RHYTHM" title="Holidays & Breaks" description="Set a day off for all trackers or choose specific trackers." help={{ title: 'Holidays & Breaks', summary: 'Global holidays apply across your workspace; selected holidays apply only to chosen trackers.', description: 'Strict Mode trackers cannot be selected because their required check-ins still apply. Positive work on a holiday counts normally for that tracker; clearing the check-in restores its holiday status. Zero and Skip keep the holiday effective. The Calendar shows Holiday only when applicable trackers are all on holiday; otherwise it shows the meaningful progress or missed status. Goal plans keep their existing holiday rules. Holidays save on this device first and sync when available.' }} />
    <Surface className="holiday-form-surface"><form onSubmit={(event) => void addRange(event)} className="holiday-form">
      <div><h2>Plan a break</h2><p>Choose one date or a range. Dates follow your workspace time zone: {timeZone}.</p></div>
      <label className="form-field"><span>From</span><input className="auth-input" type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); if (endDate < event.target.value) setEndDate(event.target.value) }} required /></label>
      <label className="form-field"><span>Through</span><input className="auth-input" type="date" min={startDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label>
      <fieldset className="holiday-scope-picker"><legend>Apply holiday to <InfoButton {...holidayScopeHelp} /></legend>
        <label><input type="radio" name="holiday-scope" value="global" checked={scope === 'global'} onChange={() => setScope('global')} /> All trackers</label>
        <label><input type="radio" name="holiday-scope" value="selected" checked={scope === 'selected'} onChange={() => setScope('selected')} /> Selected trackers</label>
      </fieldset>
      {scope === 'global' ? <label className="form-field"><span>Reason <em>· optional</em></span><select className="auth-input" value={reason} onChange={(event) => setReason(event.target.value as HolidayReason | '')}><option value="">No reason</option>{Object.entries(reasonLabel).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label> : <fieldset className="holiday-tracker-picker"><legend>Choose Standard Mode trackers</legend>
        {eligibleTrackers.length === 0 ? <p>No active Standard Mode trackers are eligible for every date in this range.</p> : <div className="holiday-tracker-options">{eligibleTrackers.map((tracker) => <label key={tracker.id}><input type="checkbox" checked={selectedTrackerIds.includes(tracker.id)} onChange={(event) => setSelectedTrackerIds((current) => event.target.checked ? [...new Set([...current, tracker.id])] : current.filter((id) => id !== tracker.id))} /><span>{tracker.name}</span></label>)}</div>}
        <small>Strict Mode trackers are excluded because their required check-ins still apply.</small>
        {selectedTrackerIds.length === 0 && <p className="holiday-selection-hint">Select one or more trackers.</p>}
        {selectedTrackerIds.some((id) => !eligibleTrackers.some((tracker) => tracker.id === id)) && <p role="status">Some earlier selections are no longer eligible for this range. <button type="button" className="holiday-remove-unavailable" onClick={() => setSelectedTrackerIds((current) => current.filter((id) => eligibleTrackers.some((tracker) => tracker.id === id)))}>Remove unavailable selections</button></p>}
      </fieldset>}
      <button className="button button-primary button-medium" type="submit" disabled={scope === 'selected' && (selectedTrackerIds.length === 0 || selectedTrackerIds.some((id) => !eligibleTrackers.some((tracker) => tracker.id === id)))}>Mark holiday</button>
    </form></Surface>
    {error && <p role="alert" className="form-alert">{error}</p>}
    <section aria-labelledby="holiday-list-title"><SectionHeader className="holiday-list-heading" title="Your holidays" headingId="holiday-list-title" action={<Link to="/calendar">View calendar</Link>} />
      {loading ? <p role="status" className="tracker-loading">Loading holidays…</p> : rows.length === 0 && trackerHolidayGroups.length === 0 ? <Surface><p>No holidays added yet. Your tracker schedules continue as usual.</p></Surface> : <div className="holiday-list">{rows.map((row) => <HolidayRow key={`global:${row.id}`} row={row} onEdit={(trigger) => { editTriggerRef.current = trigger; setEditingHoliday({ scope: 'global', holiday: row }) }} onRemove={() => void remove(row.date)} />)}{trackerHolidayGroups.map((group) => <SelectedHolidayRow key={`selected:${group.date}`} group={group} trackers={trackers} onEdit={(trigger) => { editTriggerRef.current = trigger; setEditingHoliday({ scope: 'selected', date: group.date, trackerIds: group.trackerIds }) }} onRemove={() => void removeTrackerHolidayGroup(group)} />)}</div>}
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
    {editingHoliday && <HolidayEditorDialog designation={editingHoliday} trackers={trackers} onCancel={() => setEditingHoliday(null)} onSave={saveEditedHoliday} />}
    <p className="holiday-sync-note"><span className="sync-dot" /> Saved on this device first. Account holidays sync when signed in and online; guest holidays stay in the guest workspace.</p>
  </section>
}

function HolidayActionsMenu({ date, actionLabel = `More actions for ${date}`, restoreDisabled, deleteDisabled, onRestore, onDelete, onEdit }: {
  date: CalendarDate
  actionLabel?: string
  restoreDisabled?: boolean
  deleteDisabled: boolean
  onRestore?: () => void
  onDelete: () => void
  onEdit?: (trigger: HTMLButtonElement) => void
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
  function run(action: () => void) { setOpen(false); if (onEdit) triggerRef.current?.focus(); action() }
  return <div className="tracker-actions-menu holiday-actions-menu" ref={rootRef}>
    <button ref={triggerRef} type="button" className="button button-secondary button-small tracker-actions-trigger" aria-label={actionLabel} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>⋯</button>
    {open && <div className="tracker-actions-popover" role="menu" aria-label={`${date} holiday actions`} ref={menuRef}>
      {onEdit && <button type="button" role="menuitem" onClick={() => { const trigger = triggerRef.current; if (trigger) { trigger.focus(); run(() => onEdit(trigger)) } }}>Edit holiday</button>}
      {onRestore && <button type="button" role="menuitem" disabled={restoreDisabled} onClick={() => run(onRestore)}>Restore</button>}
      <button type="button" role="menuitem" className="destructive" disabled={deleteDisabled} onClick={() => run(onDelete)}>{onEdit ? 'Remove holiday' : 'Delete permanently'}</button>
    </div>}
  </div>
}

function HolidayRow({ row, onRemove, onEdit }: { row: AccountHoliday; onRemove: () => void; onEdit: (trigger: HTMLButtonElement) => void }) {
  return <Surface className="holiday-row"><div className="holiday-row-details"><strong><span className="status-mark holiday"><ActivityStatusIcon status="holiday" /></span> {calendarDateLabel(row.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong><small><span className="holiday-scope-badge">Global · All trackers</span>{row.reason ? ` · ${reasonLabel[row.reason]}` : ''}</small></div><HolidayActionsMenu date={row.date} deleteDisabled={false} onEdit={onEdit} onDelete={onRemove} /></Surface>
}

function SelectedHolidayRow({ group, trackers, onRemove, onEdit }: { group: TrackerHolidayGroup; trackers: StoredTrackerDefinition[]; onRemove: () => void; onEdit: (trigger: HTMLButtonElement) => void }) {
  const names = group.trackerIds.map((id) => trackers.find((tracker) => tracker.id === id)?.name ?? 'Unavailable tracker')
  return <Surface className="holiday-row"><div className="holiday-row-details"><strong><span className="status-mark holiday"><ActivityStatusIcon status="holiday" /></span> {calendarDateLabel(group.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong><small><span className="holiday-scope-badge">Selected trackers · {group.trackerIds.length}</span> · {names.join(', ')}</small></div><HolidayActionsMenu date={group.date} actionLabel={`More actions for selected holiday ${group.date}`} deleteDisabled={false} onEdit={onEdit} onDelete={onRemove} /></Surface>
}

function HolidayEditorDialog({ designation, trackers, onCancel, onSave }: {
  designation: HolidayDesignation
  trackers: StoredTrackerDefinition[]
  onCancel: () => void
  onSave: (value: HolidayEditValue) => Promise<void>
}) {
  const initialDate = designation.scope === 'global' ? designation.holiday.date : designation.date
  const [date, setDate] = useState<string>(initialDate)
  const [scope, setScope] = useState<HolidayScope>(designation.scope)
  const [trackerIds, setTrackerIds] = useState<string[]>(designation.scope === 'selected' ? designation.trackerIds : [])
  const [reason, setReason] = useState<HolidayReason | ''>(designation.scope === 'global' ? designation.holiday.reason ?? '' : '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  useModalLayer(true, dialogRef, onCancel, { manageHistoryEntry: false })
  useVisualViewportBounds(true, backdropRef)
  const dateValue = date as CalendarDate
  const eligible = trackers.filter((tracker) => tracker.deletedAt === null && tracker.status === 'active' && !trackerStrictModeForDate(tracker, dateValue))
  const eligibleIds = new Set(eligible.map((tracker) => tracker.id))
  const staleSelectedIds = designation.scope === 'selected' ? trackerIds.filter((id) => !eligibleIds.has(id)) : []
  const eligibleSelectedIds = trackerIds.filter((id) => eligibleIds.has(id))
  const sourceDate = designation.scope === 'global' ? designation.holiday.date : designation.date
  const initialReason = designation.scope === 'global' ? designation.holiday.reason : null
  const changed = date !== sourceDate || scope !== designation.scope || (reason || null) !== initialReason
    || (scope === 'selected' && (eligibleSelectedIds.length !== (designation.scope === 'selected' ? designation.trackerIds.length : 0)
      || eligibleSelectedIds.some((id) => designation.scope !== 'selected' || !designation.trackerIds.includes(id))))
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    try {
      assertHolidayDate(date)
      if (reason && !isHolidayReason(reason)) throw new Error('Choose a supported holiday reason.')
      if (scope === 'selected' && eligibleSelectedIds.length === 0) throw new Error('Select at least one Standard Mode tracker.')
      setSaving(true)
      await onSave({ date: dateValue, scope, trackerIds: eligibleSelectedIds, reason: scope === 'global' ? reason || null : null })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your changes were not saved. Please try again.') }
    finally { setSaving(false) }
  }
  return createPortal(<div ref={backdropRef} className="modal-backdrop holiday-edit-backdrop" role="presentation"><section ref={dialogRef} className="holiday-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="holiday-edit-title" tabIndex={-1}>
    <h2 id="holiday-edit-title">Edit holiday</h2>
    <form onSubmit={(event) => void submit(event)}>
      <div className="holiday-edit-content">
        <label className="form-field"><span>Date</span><input autoFocus type="date" className="auth-input" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
        <fieldset className="holiday-scope-picker holiday-edit-scope"><legend>Apply holiday to <InfoButton {...holidayScopeHelp} /></legend>
          <label><input type="radio" name="edit-holiday-scope" value="global" checked={scope === 'global'} onChange={() => setScope('global')} /> All trackers</label>
          <label><input type="radio" name="edit-holiday-scope" value="selected" checked={scope === 'selected'} onChange={() => setScope('selected')} /> Selected trackers</label>
        </fieldset>
        {scope === 'global' ? <label className="form-field"><span>Reason <em>· optional</em></span><select aria-label="Reason" className="auth-input" value={reason} onChange={(event) => setReason(event.target.value as HolidayReason | '')}><option value="">No reason</option>{Object.entries(reasonLabel).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label> : <fieldset className="holiday-tracker-picker holiday-edit-trackers"><legend>Choose Standard Mode trackers</legend>
          {eligible.length === 0 ? <p>No active Standard Mode trackers are eligible for this date.</p> : <div className="holiday-tracker-options">{eligible.map((tracker) => <label key={tracker.id}><input type="checkbox" checked={trackerIds.includes(tracker.id)} onChange={(event) => setTrackerIds((current) => event.target.checked ? [...new Set([...current, tracker.id])] : current.filter((id) => id !== tracker.id))} /><span>{tracker.name}</span></label>)}</div>}
          {staleSelectedIds.length > 0 && <p role="status">{staleSelectedIds.length} previous selection{staleSelectedIds.length === 1 ? ' is' : 's are'} no longer eligible and will be removed when you save.</p>}
          <small>Strict Mode trackers keep their required check-ins and cannot be added.</small>
        </fieldset>}
        {error && <p role="alert" className="form-alert">{error}</p>}
      </div>
      <footer className="holiday-edit-actions"><button type="button" className="button button-quiet" disabled={saving} onClick={onCancel}>Cancel</button><button type="submit" className="button button-primary" disabled={!changed || saving}>{saving ? 'Saving…' : 'Save changes'}</button></footer>
    </form>
  </section></div>, document.body)
}
