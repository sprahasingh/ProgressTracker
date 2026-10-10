import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { activateWorkspace, db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import { WorkspaceTimeZoneProvider, useWorkspaceTimeZone } from './WorkspaceTimeZone'
import { DARK_THEME_COLOR, LIGHT_THEME_COLOR } from './appearance'

function AppearanceControls() {
  const { setAppearance } = useWorkspaceTimeZone()
  return <>
    <button onClick={() => void setAppearance('dark')}>Set dark</button>
    <button onClick={() => void setAppearance('light')}>Set light</button>
  </>
}

describe('workspace appearance switching', () => {
  afterEach(async () => {
    cleanup()
    delete document.documentElement.dataset.theme
    document.querySelector('meta[name="theme-color"]')?.remove()
    document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.remove()
    localStorage.clear()
    db.close()
    await db.delete()
  })

  it('updates page and browser chrome immediately when appearance changes', async () => {
    await activateWorkspace(null)
    document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color"><meta name="apple-mobile-web-app-status-bar-style">')
    render(<WorkspaceTimeZoneProvider ownerUserId={null}><AppearanceControls /></WorkspaceTimeZoneProvider>)

    fireEvent.click(await screen.findByRole('button', { name: 'Set dark' }))
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', DARK_THEME_COLOR)
      expect(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Set light' }))
    await waitFor(() => {
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
      expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', LIGHT_THEME_COLOR)
      expect(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'default')
    })
  })

  it('uses the neutral workspace placeholder and offers retry when local settings fail to load', async () => {
    await activateWorkspace(null)
    vi.spyOn(localRepository, 'getAppSettings').mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    render(<WorkspaceTimeZoneProvider ownerUserId={null}><AppearanceControls /></WorkspaceTimeZoneProvider>)

    expect(screen.getByRole('status', { name: 'Preparing your workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Opening your preferences')).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Your local progress is still saved on this device.')
    const retry = screen.getByRole('button', { name: 'Try again' })
    expect(retry).toBeInTheDocument()
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByRole('status', { name: 'Preparing your workspace' })).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
