import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../components/ui/ToastProvider'
import { HolidaysPage } from './HolidaysPage'

const mocks = vi.hoisted(() => ({ listAccountHolidays: vi.fn(), listPermanentHolidayDeletionRequests: vi.fn(), restoreAccountHoliday: vi.fn(), updateAccountHoliday: vi.fn(), requestPermanentHolidayDeletion: vi.fn(), removeAccountHoliday: vi.fn(), syncNow: vi.fn(), auth: { status: 'local-only', user: null as { id: string } | null, workspaceStatus: 'ready', workspaceUserId: null as string | null, sessionTransitionPending: false, isOnline: true } }))
vi.mock('../../db/localRepository', () => ({ localRepository: mocks }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ ...mocks.auth, syncNow: mocks.syncNow }) }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))

const removedHoliday = { id: 'removed-holiday', date: '2026-10-10' as const, reason: 'travel' as const, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', deletedAt: '2026-10-02T00:00:00.000Z' }

beforeEach(() => {
  mocks.auth = { status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false, isOnline: true }
  mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [] : []))
  mocks.listPermanentHolidayDeletionRequests.mockResolvedValue([])
  mocks.restoreAccountHoliday.mockResolvedValue(undefined)
  mocks.updateAccountHoliday.mockResolvedValue(undefined)
  mocks.removeAccountHoliday.mockResolvedValue(undefined)
  mocks.requestPermanentHolidayDeletion.mockResolvedValue('deleted')
  mocks.syncNow.mockResolvedValue(undefined)
})

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllEnvs() })

describe('Manage Holidays', () => {
  it('puts holiday guidance in the help popup and removes the redundant About card', async () => {
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)

    expect(await screen.findByRole('heading', { level: 1, name: /Holidays & Breaks/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'About holidays' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'More about Holidays & Breaks' }))
    expect(screen.getByRole('dialog', { name: 'Holidays & Breaks' })).toHaveTextContent('Standard Mode pauses scheduled tracker check-ins')
    expect(screen.getByRole('dialog', { name: 'Holidays & Breaks' })).toHaveTextContent('Strict Mode still expects activity')
    expect(screen.getByRole('dialog', { name: 'Holidays & Breaks' })).toHaveTextContent('Saved check-ins are preserved')
    expect(screen.getByRole('dialog', { name: 'Holidays & Breaks' })).toHaveTextContent('Goal plans follow their own schedule')
    expect(container.querySelector('.calendar-legend')).not.toBeInTheDocument()
    expect(screen.queryByText(/Blue · Holiday/)).not.toBeInTheDocument()
  })

  it('shows a read-only active holiday card and exposes Edit and Remove in its menu', async () => {
    const active = { ...removedHoliday, deletedAt: null }
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [active] : [active]))
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)
    await screen.findByText('Travel')
    expect(document.querySelector('.holiday-row select')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions for 2026-10-10' }))
    expect(screen.getByRole('menuitem', { name: 'Edit holiday' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Remove holiday' })).toBeInTheDocument()
  })

  it('opens and cancels editing without saving', async () => {
    const active = { ...removedHoliday, deletedAt: null }
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [active] : [active]))
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'More actions for 2026-10-10' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit holiday' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit holiday' })
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-10-10')
    expect(within(dialog).getByLabelText('Reason')).toHaveValue('travel')
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDisabled()
    const backdrop = dialog.closest('.holiday-edit-backdrop') as HTMLElement
    expect(backdrop.parentElement).toBe(document.body)
    expect(backdrop).toHaveClass('modal-backdrop')
    expect(backdrop.style.height).toBe(`${window.innerHeight}px`)
    expect(document.body.style.overflow).toBe('hidden')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.body.style.overflow).toBe(''))
    expect(mocks.updateAccountHoliday).not.toHaveBeenCalled()
  })

  it.each([
    ['date only', '2026-10-11', 'travel'],
    ['reason only', '2026-10-10', 'exam'],
    ['both date and reason', '2026-10-11', 'exam'],
  ])('saves %s changes while preserving the holiday identity', async (_label, date, reason) => {
    const active = { ...removedHoliday, deletedAt: null }
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [active] : [active]))
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'More actions for 2026-10-10' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit holiday' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit holiday' })
    await user.clear(within(dialog).getByLabelText('Date'))
    await user.type(within(dialog).getByLabelText('Date'), date)
    await user.selectOptions(within(dialog).getByLabelText('Reason'), reason)
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.updateAccountHoliday).toHaveBeenCalledWith(active.id, date, reason))
    expect(await screen.findByRole('status', { name: 'Holiday updated' })).toBeInTheDocument()
  })

  it('rejects duplicate dates without saving and supports Escape with focus restoration', async () => {
    const active = { ...removedHoliday, deletedAt: null }
    const duplicate = { ...active, id: 'other-holiday', date: '2026-10-11' }
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [active, duplicate] : [active, duplicate]))
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)
    const trigger = await screen.findByRole('button', { name: 'More actions for 2026-10-10' })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Edit holiday' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit holiday' })
    await user.clear(within(dialog).getByLabelText('Date'))
    await user.type(within(dialog).getByLabelText('Date'), '2026-10-11')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A holiday record already exists on that date.')
    expect(mocks.updateAccountHoliday).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Edit holiday' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('opens the recently deleted actions menu and restores the selected holiday', async () => {
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [removedHoliday] : []))
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)
    await screen.findByText('Recently deleted holidays')
    await user.click(screen.getByRole('button', { name: 'More actions for 2026-10-10' }))
    expect(screen.getByRole('menuitem', { name: 'Restore' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete permanently' })).toBeDisabled()
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }))
    expect(mocks.restoreAccountHoliday).toHaveBeenCalledWith(removedHoliday.date)
    expect(await screen.findByRole('status', { name: 'Holiday restored' })).toHaveTextContent('is a holiday again')
  })

  it('supports keyboard navigation and Escape in the deleted holiday menu', async () => {
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'true')
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [removedHoliday] : []))
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)
    await screen.findByText('Recently deleted holidays')
    const trigger = screen.getByRole('button', { name: 'More actions for 2026-10-10' })
    await user.click(trigger)
    const restore = screen.getByRole('menuitem', { name: 'Restore' })
    const deletePermanently = screen.getByRole('menuitem', { name: 'Delete permanently' })
    expect(restore).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(deletePermanently).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('requires confirmation and supports canceling a permanent deletion', async () => {
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'true')
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [removedHoliday] : []))
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)
    await screen.findByText('Recently deleted holidays')
    await user.click(screen.getByRole('button', { name: 'More actions for 2026-10-10' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete permanently' }))
    const dialog = await screen.findByRole('alertdialog', { name: /Delete Oct 10, 2026 permanently/i })
    expect(dialog).toHaveTextContent('cannot be undone')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(mocks.requestPermanentHolidayDeletion).not.toHaveBeenCalled()
  })

  it('shows success only after guest deletion completes locally', async () => {
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'true')
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [removedHoliday] : []))
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)
    await screen.findByText('Recently deleted holidays')
    await user.click(screen.getByRole('button', { name: 'More actions for 2026-10-10' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete permanently' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete permanently' }))
    expect(mocks.requestPermanentHolidayDeletion).toHaveBeenCalledWith(removedHoliday.date)
    expect(await screen.findByRole('status', { name: 'Holiday permanently deleted.' })).toBeInTheDocument()
  })

  it('keeps an offline account deletion pending until sync confirms it', async () => {
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'true')
    mocks.auth = { status: 'signed-in', user: { id: 'holiday-owner' }, workspaceStatus: 'ready', workspaceUserId: 'holiday-owner', sessionTransitionPending: false, isOnline: false }
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [removedHoliday] : []))
    mocks.requestPermanentHolidayDeletion.mockResolvedValue('queued')
    mocks.listPermanentHolidayDeletionRequests.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'request-1', ownerUserId: 'holiday-owner', holidayId: removedHoliday.id, holidayDate: removedHoliday.date, requestedAt: '2026-10-12T00:00:00.000Z', status: 'pending', lastError: null }])
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)
    await screen.findByText('Recently deleted holidays')
    await user.click(screen.getByRole('button', { name: 'More actions for 2026-10-10' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete permanently' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete permanently' }))
    expect(await screen.findByRole('status', { name: 'Holiday deletion pending.' })).toBeInTheDocument()
    expect(mocks.syncNow).not.toHaveBeenCalled()
    expect(screen.getByText('Permanent deletion pending server confirmation.')).toBeInTheDocument()
  })
})
