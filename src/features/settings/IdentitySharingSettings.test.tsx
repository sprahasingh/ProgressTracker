import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IdentitySharingSettings } from './IdentitySharingSettings'
import { getIdentitySharingPreference, setIdentitySharingPreference } from './identitySharing'

vi.mock('./identitySharing', () => ({ getIdentitySharingPreference: vi.fn(), setIdentitySharingPreference: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('IdentitySharingSettings', () => {
  it('defaults to anonymous when the cloud setting is missing and persists opt in and opt out', async () => {
    vi.mocked(getIdentitySharingPreference).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    vi.mocked(setIdentitySharingPreference).mockImplementation(async (value) => value)
    const user = userEvent.setup()
    const { unmount } = render(<IdentitySharingSettings />)
    const checkbox = await screen.findByRole('checkbox', { name: 'Share my identity with maintainers' })
    expect(checkbox).not.toBeChecked()
    expect(screen.getByText(/Allow maintainers to see your name and email/)).toBeInTheDocument()
    const infoButton = screen.getByRole('button', { name: 'How identity sharing works' })
    expect(infoButton.parentElement).toBe(screen.getByRole('checkbox').parentElement?.parentElement)
    await user.click(infoButton)
    const dialog = screen.getByRole('dialog', { name: 'How identity sharing works' })
    expect(dialog.querySelectorAll('li')).toHaveLength(6)
    expect(dialog).toHaveTextContent('When disabled, your identity is hidden from maintainers in feedback and support views.')
    expect(dialog).toHaveTextContent('This setting controls maintainer-facing feedback and support views, not privileged infrastructure administration.')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(infoButton).toHaveFocus()
    await user.keyboard('{Tab}')
    checkbox.focus()
    await user.keyboard(' ')
    expect(setIdentitySharingPreference).toHaveBeenCalledWith(true)
    expect(await screen.findByRole('status')).toHaveTextContent('Privacy setting saved.')
    expect(checkbox).toBeChecked()
    unmount()
    render(<IdentitySharingSettings />)
    expect(await screen.findByRole('checkbox', { name: 'Share my identity with maintainers' })).toBeChecked()
    const enabledCheckbox = screen.getByRole('checkbox', { name: 'Share my identity with maintainers' })
    await user.click(enabledCheckbox)
    expect(setIdentitySharingPreference).toHaveBeenLastCalledWith(false)
  })

  it('opens the compact privacy explanation with keyboard activation and dismisses outside', async () => {
    vi.mocked(getIdentitySharingPreference).mockResolvedValue(false)
    const user = userEvent.setup()
    render(<IdentitySharingSettings />)
    const infoButton = await screen.findByRole('button', { name: 'How identity sharing works' })
    infoButton.focus()
    await user.keyboard('{Enter}')
    const dialog = screen.getByRole('dialog', { name: 'How identity sharing works' })
    expect(dialog).toHaveClass('is-compact')
    expect(dialog).not.toHaveAttribute('aria-modal', 'true')
    await user.click(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a load error, keeps sharing disabled, and retries the cloud read', async () => {
    vi.mocked(getIdentitySharingPreference).mockRejectedValueOnce(new Error('Your privacy setting could not be loaded. Try again.')).mockResolvedValueOnce(true)
    const user = userEvent.setup()
    render(<IdentitySharingSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    expect(screen.getByRole('checkbox', { name: 'Share my identity with maintainers' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('checkbox', { name: 'Share my identity with maintainers' })).toBeChecked()
  })

  it('preserves the last saved value and explains a save failure', async () => {
    vi.mocked(getIdentitySharingPreference).mockResolvedValue(true)
    vi.mocked(setIdentitySharingPreference).mockRejectedValue(new Error('Your privacy setting could not be saved. Try again.'))
    const user = userEvent.setup()
    render(<IdentitySharingSettings />)
    const checkbox = await screen.findByRole('checkbox', { name: 'Share my identity with maintainers' })
    expect(checkbox).toBeChecked()
    await user.click(checkbox)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    expect(checkbox).toBeChecked()
  })
})
