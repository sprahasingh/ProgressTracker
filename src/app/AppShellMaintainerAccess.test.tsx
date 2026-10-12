import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import appStyles from '../styles.css?raw'
import type { MaintainerAccess } from '../features/ai-knowledge/useMaintainerAccess'
import { AppShell } from './AppShell'

const mocks = vi.hoisted(() => ({
  auth: { value: { status: 'loading', user: null as { id: string; email: string } | null, workspaceStatus: 'loading', workspaceUserId: null as string | null, sessionTransitionPending: false } },
  checkAccess: vi.fn<() => Promise<boolean>>(),
}))

vi.mock('../features/auth/AuthProvider', () => ({
  useAuth: () => ({
    ...mocks.auth.value,
    passwordRecovery: false,
    guestSummary: null,
    workspaceError: null,
    chooseGuestData: vi.fn(),
    retryWorkspace: vi.fn(),
    syncStatus: 'idle',
    isOnline: true,
  }),
}))
vi.mock('../services/supabase/client', () => ({ getSupabaseClient: () => undefined }))
vi.mock('../features/ai-knowledge/aiKnowledgeApi', () => ({
  checkMaintainerAccess: mocks.checkAccess,
  ReviewApiError: class ReviewApiError extends Error { status = 403 },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

function RefreshPermissionButton() {
  const access = useOutletContext<MaintainerAccess>()
  return <button onClick={access.refresh}>Recheck permission</button>
}

function renderShell() {
  return render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}>
    <Route index element={<RefreshPermissionButton />} />
  </Route></Routes></MemoryRouter>)
}

let stylesheet: HTMLStyleElement | null = null
function injectStyles() {
  stylesheet = document.createElement('style')
  stylesheet.textContent = appStyles
  document.head.append(stylesheet)
}

afterEach(() => { cleanup(); stylesheet?.remove() })

describe('AppShell maintainer navigation across initial session restoration', () => {
  beforeEach(() => {
    mocks.auth.value = { status: 'loading', user: null, workspaceStatus: 'loading', workspaceUserId: null, sessionTransitionPending: false }
    mocks.checkAccess.mockReset()
  })

  it('keeps the same disabled AI Knowledge row through session restore and authorization', async () => {
    injectStyles()
    const initialCheck = deferred<boolean>()
    mocks.checkAccess.mockReturnValueOnce(initialCheck.promise)
    const view = renderShell()
    const desktopNav = screen.getByRole('navigation', { name: 'More destinations' })
    const mobileNav = document.querySelector('nav.mobile-nav') as HTMLElement

    const initialDesktopRow = within(desktopNav).getByRole('status', { name: 'Checking AI Knowledge access' })
    expect(initialDesktopRow).toHaveTextContent('AI Knowledge')
    expect(initialDesktopRow).toHaveAttribute('aria-disabled', 'true')
    const initialDesktopHeight = getComputedStyle(initialDesktopRow).minHeight
    fireEvent.click(within(mobileNav).getByRole('button', { name: 'More destinations', hidden: true }))
    const initialMobileRow = within(mobileNav).getByRole('menuitem', { name: 'Checking AI Knowledge access', hidden: true })
    const initialMobileHeight = getComputedStyle(initialMobileRow).minHeight
    expect(initialMobileRow).toHaveTextContent('AI Knowledge')
    expect(initialMobileRow).toHaveAttribute('aria-disabled', 'true')
    expect(within(desktopNav).queryByRole('link', { name: 'AI Knowledge' })).not.toBeInTheDocument()

    mocks.auth.value = { status: 'signed-in', user: { id: 'maintainer-a', email: 'maintainer@example.com' }, workspaceStatus: 'ready', workspaceUserId: 'maintainer-a', sessionTransitionPending: false }
    view.rerender(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<AppShell />}><Route index element={<RefreshPermissionButton />} /></Route></Routes></MemoryRouter>)
    expect(within(desktopNav).getByRole('status', { name: 'Checking AI Knowledge access' })).toBeInTheDocument()
    expect(within(mobileNav).getByRole('menuitem', { name: 'Checking AI Knowledge access', hidden: true })).toBeInTheDocument()
    await waitFor(() => expect(mocks.checkAccess).toHaveBeenCalledTimes(1))

    await act(async () => { initialCheck.resolve(true) })
    const authorizedDesktopLink = await within(desktopNav).findByRole('link', { name: 'AI Knowledge' })
    expect(getComputedStyle(authorizedDesktopLink).minHeight).toBe(initialDesktopHeight)
    const authorizedMobileLink = await within(mobileNav).findByRole('menuitem', { name: 'AI Knowledge', hidden: true })
    expect(getComputedStyle(authorizedMobileLink).minHeight).toBe(initialMobileHeight)
    expect(authorizedDesktopLink.querySelector('svg')).toHaveAttribute('data-icon', 'spark')
    expect(authorizedMobileLink.querySelector('svg')).toHaveAttribute('data-icon', 'spark')

    expect(within(desktopNav).getByRole('link', { name: 'AI Knowledge' })).toBeInTheDocument()
  })
})
