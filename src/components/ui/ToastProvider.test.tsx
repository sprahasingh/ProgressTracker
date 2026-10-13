import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, useToast } from './ToastProvider'
import { publishPermanentDeletionNotification } from '../../services/permanentDeletionNotifications'
import { publishHolidayDeletionNotification } from '../../services/holidayDeletionNotifications'
import toastStyles from '../../styles.css?raw'

function Controls() {
  const { notify } = useToast()
  return <><button onClick={() => notify({ kind: 'success', title: 'Check-in updated', description: 'Saved on this device.' })}>Show success</button><button onClick={() => notify({ kind: 'error', title: 'Could not save', duration: 0, dedupeKey: 'save' })}>Show error</button><button onClick={() => notify({ kind: 'warning', title: 'Offline', dedupeKey: 'offline' })}>Show warning</button></>
}

describe('global toast feedback', () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })
  it('announces routine results and can be dismissed by keyboard-accessible control', async () => {
    render(<ToastProvider><Controls /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Show success' }))
    const toast = screen.getByRole('status', { name: /Check-in updated/ })
    expect(toast).toHaveTextContent('Saved on this device.')
    expect(toast).toHaveAttribute('aria-live', 'polite')
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Dismiss notification: Check-in updated' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('status', { name: /Check-in updated/ })).not.toBeInTheDocument()
  })
  it('keeps critical errors until dismissed and replaces duplicate warnings', () => {
    vi.useFakeTimers()
    render(<ToastProvider><Controls /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Show error' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show warning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show warning' }))
    expect(screen.getAllByRole('alert', { name: 'Could not save' })).toHaveLength(1)
    expect(screen.getAllByRole('status', { name: 'Offline' })).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByRole('alert', { name: 'Could not save' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification: Could not save' }))
    expect(screen.queryByRole('alert', { name: 'Could not save' })).not.toBeInTheDocument()
  })
  it('automatically dismisses routine confirmations', () => {
    vi.useFakeTimers()
    render(<ToastProvider><Controls /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Show success' }))
    expect(screen.getByRole('status', { name: /Check-in updated/ })).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.queryByRole('status', { name: /Check-in updated/ })).not.toBeInTheDocument()
  })
  it('keeps a queued deletion visible until server confirmation, then shows one four-second success', () => {
    vi.useFakeTimers()
    render(<ToastProvider><Controls /></ToastProvider>)
    const event = { status: 'queued' as const, ownerUserId: 'owner', trackerId: 'tracker', trackerName: 'Read more' }
    act(() => { publishPermanentDeletionNotification(event); publishPermanentDeletionNotification(event) })
    expect(screen.getAllByRole('status', { name: 'Deletion request queued.' })).toHaveLength(1)
    expect(screen.getByRole('status', { name: 'Deletion request queued.' })).toHaveTextContent('Read more')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByRole('status', { name: 'Deletion request queued.' })).toBeInTheDocument()

    act(() => { publishPermanentDeletionNotification({ ...event, status: 'confirmed' }) })
    expect(screen.queryByRole('status', { name: 'Deletion request queued.' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('status', { name: 'Tracker permanently deleted.' })).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(3999) })
    expect(screen.getByRole('status', { name: 'Tracker permanently deleted.' })).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByRole('status', { name: 'Tracker permanently deleted.' })).not.toBeInTheDocument()
  })
  it('shows retry guidance for failure, preserves conflicts, and ignores stale confirmations after dismissal or navigation', () => {
    vi.useFakeTimers()
    function NavigationHarness() {
      const [page, setPage] = useState('Bin')
      return <><button onClick={() => setPage('Today')}>Navigate</button><span>{page}</span></>
    }
    render(<ToastProvider><NavigationHarness /></ToastProvider>)
    const event = { status: 'queued' as const, ownerUserId: 'owner', trackerId: 'tracker', trackerName: 'Read more' }
    act(() => { publishPermanentDeletionNotification(event) })
    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }))
    expect(screen.getByText('Today')).toBeInTheDocument()
    act(() => { publishPermanentDeletionNotification({ ...event, status: 'failed', message: 'Network unavailable.' }) })
    expect(screen.getByRole('alert', { name: 'Couldn’t confirm tracker deletion' })).toHaveTextContent('sync again to retry')
    expect(screen.queryByRole('status', { name: 'Tracker permanently deleted.' })).not.toBeInTheDocument()
    act(() => { publishPermanentDeletionNotification(event) })
    act(() => { publishPermanentDeletionNotification({ ...event, status: 'conflict', message: 'Resolve the sync conflict.' }) })
    expect(screen.getByRole('alert', { name: 'Deletion needs attention' })).toHaveTextContent('Resolve the sync conflict.')
    act(() => { publishPermanentDeletionNotification(event) })
    act(() => { publishPermanentDeletionNotification({ ...event, status: 'confirmed' }) })
    expect(screen.getByRole('status', { name: 'Tracker permanently deleted.' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification: Tracker permanently deleted.' }))
    act(() => { publishPermanentDeletionNotification({ ...event, status: 'confirmed' }) })
    expect(screen.queryByRole('status', { name: 'Tracker permanently deleted.' })).not.toBeInTheDocument()
  })
  it('still reports completion if the user dismissed the pending toast, while suppressing duplicate confirmations', () => {
    render(<ToastProvider><Controls /></ToastProvider>)
    const event = { status: 'queued' as const, ownerUserId: 'owner-dismissed', trackerId: 'tracker', trackerName: 'Read more' }
    act(() => { publishPermanentDeletionNotification(event) })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification: Deletion request queued.' }))
    act(() => { publishPermanentDeletionNotification({ ...event, status: 'confirmed' }) })
    expect(screen.getByRole('status', { name: 'Tracker permanently deleted.' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification: Tracker permanently deleted.' }))
    act(() => { publishPermanentDeletionNotification({ ...event, status: 'confirmed' }) })
    expect(screen.queryByRole('status', { name: 'Tracker permanently deleted.' })).not.toBeInTheDocument()
  })
  it('keeps holiday deletion pending until confirmation and replaces it with a four-second success', () => {
    vi.useFakeTimers()
    render(<ToastProvider><Controls /></ToastProvider>)
    const event = { status: 'queued' as const, ownerUserId: 'holiday-owner', holidayId: 'holiday', holidayDate: '2026-10-10' }
    act(() => { publishHolidayDeletionNotification(event); publishHolidayDeletionNotification(event) })
    expect(screen.getAllByRole('status', { name: 'Holiday deletion pending.' })).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByRole('status', { name: 'Holiday deletion pending.' })).toBeInTheDocument()
    act(() => { publishHolidayDeletionNotification({ ...event, status: 'confirmed' }) })
    expect(screen.queryByRole('status', { name: 'Holiday deletion pending.' })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Holiday permanently deleted.' })).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByRole('status', { name: 'Holiday permanently deleted.' })).not.toBeInTheDocument()
  })
  it('reports holiday deletion failures with retry guidance and ignores stale confirmations', () => {
    render(<ToastProvider><Controls /></ToastProvider>)
    const event = { status: 'queued' as const, ownerUserId: 'holiday-owner-failure', holidayId: 'holiday', holidayDate: '2026-10-11' }
    act(() => { publishHolidayDeletionNotification(event) })
    act(() => { publishHolidayDeletionNotification({ ...event, status: 'failed', message: 'Network unavailable.' }) })
    expect(screen.getByRole('alert', { name: 'Couldn’t confirm holiday deletion' })).toHaveTextContent('Sync again or resolve its conflict, then retry.')
    act(() => { publishHolidayDeletionNotification({ ...event, status: 'confirmed' }) })
    expect(screen.queryByRole('status', { name: 'Holiday permanently deleted.' })).not.toBeInTheDocument()
  })
  it('dismisses a deletion warning when the user resolves the conflict by keeping the cloud holiday', () => {
    render(<ToastProvider><Controls /></ToastProvider>)
    const event = { status: 'queued' as const, ownerUserId: 'holiday-owner-cancel', holidayId: 'holiday', holidayDate: '2026-10-12' }
    act(() => { publishHolidayDeletionNotification(event); publishHolidayDeletionNotification({ ...event, status: 'conflict' }) })
    expect(screen.getByRole('alert', { name: 'Holiday deletion needs attention' })).toBeInTheDocument()
    act(() => { publishHolidayDeletionNotification({ ...event, status: 'cancelled' }) })
    expect(screen.queryByRole('alert', { name: 'Holiday deletion needs attention' })).not.toBeInTheDocument()
  })
  it('uses mobile safe-area placement and semantic toast colors', () => {
    expect(toastStyles).toMatch(/\.app-toast-success\s*\{\s*--toast-tone:\s*var\(--positive\)/)
    expect(toastStyles).toMatch(/\.app-toast-error\s*\{\s*--toast-tone:\s*var\(--danger\)/)
    expect(toastStyles).toMatch(/\.app-toast-warning\s*\{\s*--toast-tone:\s*var\(--warning\)/)
    expect(toastStyles).toMatch(/\.app-toast-info\s*\{\s*--toast-tone:\s*var\(--info\)/)
    expect(toastStyles).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.toast-stack\s*\{[^}]*env\(safe-area-inset-top/)
    expect(toastStyles).toMatch(/prefers-reduced-motion:\s*reduce/)
  })
})
