import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, useToast } from './ToastProvider'
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
  it('uses mobile safe-area placement and semantic toast colors', () => {
    expect(toastStyles).toMatch(/\.app-toast-success\s*\{\s*--toast-tone:\s*var\(--positive\)/)
    expect(toastStyles).toMatch(/\.app-toast-error\s*\{\s*--toast-tone:\s*var\(--danger\)/)
    expect(toastStyles).toMatch(/\.app-toast-warning\s*\{\s*--toast-tone:\s*var\(--warning\)/)
    expect(toastStyles).toMatch(/\.app-toast-info\s*\{\s*--toast-tone:\s*var\(--info\)/)
    expect(toastStyles).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.toast-stack\s*\{[^}]*env\(safe-area-inset-top/)
    expect(toastStyles).toMatch(/prefers-reduced-motion:\s*reduce/)
  })
})
