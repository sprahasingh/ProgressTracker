import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { AccountHoliday, CalendarDate, HolidayReason } from '../../db/models'
import { expandHolidayRange } from '../../domain/holidays'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { calendarDateLabel, localCalendarDate } from '../shared/localDates'

const reasonLabel: Record<HolidayReason, string> = { travel: 'Travel', exam: 'Exam', personal: 'Personal', other: 'Other' }

export function HolidaysPage() {
  const [search] = useSearchParams()
  const { timeZone } = useWorkspaceTimeZone()
  const today = localCalendarDate(new Date(), timeZone)
  const suggested = search.get('date') ?? today
  const [startDate, setStartDate] = useState(suggested)
  const [endDate, setEndDate] = useState(suggested)
  const [reason, setReason] = useState<HolidayReason | ''>('')
  const [rows, setRows] = useState<AccountHoliday[]>([])
  const [allRows, setAllRows] = useState<AccountHoliday[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [live, all] = await Promise.all([localRepository.listAccountHolidays(), localRepository.listAccountHolidays(undefined, undefined, true)])
      setRows(live)
      setAllRows(all)
      setError('')
    } catch { setError('Holidays could not be loaded from this workspace.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  async function addRange(event: React.FormEvent) {
    event.preventDefault(); setError(''); setMessage('')
    try {
      const dates = expandHolidayRange(startDate, endDate)
      await localRepository.saveAccountHolidays(dates, reason || null)
      await refresh()
      setMessage(`${dates.length} ${dates.length === 1 ? 'day' : 'days'} marked as a holiday. Existing check-ins are unchanged.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Holiday dates could not be saved.') }
  }
  async function remove(date: CalendarDate) {
    try { await localRepository.removeAccountHoliday(date); await refresh(); setMessage(`${calendarDateLabel(date)} removed from holidays. Activity history was preserved.`) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Holiday could not be removed.') }
  }
  async function restore(date: CalendarDate) {
    try { await localRepository.restoreAccountHoliday(date); await refresh(); setMessage(`${calendarDateLabel(date)} restored as a holiday.`) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Holiday could not be restored.') }
  }

  return <section className="tracker-page holidays-page" aria-labelledby="holidays-title">
    <PageHeader headingId="holidays-title" eyebrow="REST WITHOUT LOSING YOUR RHYTHM" title="Holidays & Breaks" description="Mark account-wide days off. Every tracker and goal honors the same dates." help={{ title: 'Holidays & Breaks', summary: 'A holiday pauses scheduled expectations for every tracker in this account.', description: 'Holidays are saved as calendar dates in this workspace, work offline, and sync with your signed-in account. They do not delete or change recorded check-ins. Holidays do not add to a streak or count as a missed opportunity; streaks resume at the next scheduled non-holiday date.' }} />
    <Surface className="holiday-form-surface"><form onSubmit={(event) => void addRange(event)} className="holiday-form">
      <div><h2>Plan a break</h2><p>Choose one date or a range. Dates follow your workspace time zone: {timeZone}.</p></div>
      <label className="form-field"><span>From</span><input className="auth-input" type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); if (endDate < event.target.value) setEndDate(event.target.value) }} required /></label>
      <label className="form-field"><span>Through</span><input className="auth-input" type="date" min={startDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label>
      <label className="form-field"><span>Reason <em>· optional</em></span><select className="auth-input" value={reason} onChange={(event) => setReason(event.target.value as HolidayReason | '')}><option value="">No reason</option>{Object.entries(reasonLabel).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <button className="button button-primary button-medium" type="submit">Mark holiday</button>
    </form></Surface>
    <div className="holiday-status-legend" aria-label="Activity status legend"><span><i className="status-mark completed" aria-hidden="true">✓</i> Green · Completed</span><span><i className="status-mark partial" aria-hidden="true">◐</i> Orange · Partial</span><span><i className="status-mark missed" aria-hidden="true">!</i> Red · Missed</span><span><i className="status-mark holiday" aria-hidden="true">☀</i> Blue · Holiday</span></div>
    {error && <p role="alert" className="form-alert">{error}</p>}{message && <p role="status" className="auth-success">{message}</p>}
    <section aria-labelledby="holiday-list-title"><div className="holiday-list-heading"><h2 id="holiday-list-title">Your holidays</h2><Link to="/calendar">View calendar</Link></div>
      {loading ? <p role="status" className="tracker-loading">Loading holidays…</p> : rows.length === 0 ? <Surface><p>No holidays added yet. Your tracker schedules continue as usual.</p></Surface> : <div className="holiday-list">{rows.map((row) => <HolidayRow key={row.id} row={row} onRemove={() => void remove(row.date)} onSave={async (next) => { try { await localRepository.saveAccountHolidays([row.date], next); await refresh(); setMessage('Holiday reason updated.') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Holiday could not be updated.') } }} />)}</div>}
    </section>
    {allRows.some((row) => row.deletedAt !== null) && <details className="holiday-removed"><summary>Recently removed dates</summary><div className="holiday-list">{allRows.filter((row) => row.deletedAt !== null).map((row) => <Surface className="holiday-row" key={row.id}><span>{calendarDateLabel(row.date)} · Removed</span><button className="button button-secondary button-small" onClick={() => void restore(row.date)}>Restore holiday</button></Surface>)}</div></details>}
    <p className="holiday-sync-note"><span className="sync-dot" /> Saved on this device first. Account holidays sync when signed in and online; guest holidays stay in the guest workspace.</p>
  </section>
}

function HolidayRow({ row, onRemove, onSave }: { row: AccountHoliday; onRemove: () => void; onSave: (reason: HolidayReason | null) => Promise<void> }) {
  const [reason, setReason] = useState<HolidayReason | ''>(row.reason ?? '')
  return <Surface className="holiday-row"><div><strong><span className="status-mark holiday" aria-label="Holiday">☀</span> {calendarDateLabel(row.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong><small>Applies to all trackers and goals</small></div><label className="sr-only" htmlFor={`holiday-reason-${row.id}`}>Reason for {row.date}</label><select id={`holiday-reason-${row.id}`} className="auth-input" value={reason} onChange={(event) => setReason(event.target.value as HolidayReason | '')}><option value="">No reason</option>{Object.entries(reasonLabel).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select><button className="button button-secondary button-small" onClick={() => void onSave(reason || null)}>Save</button><button className="button button-quiet button-small" onClick={onRemove}>Remove</button></Surface>
}
