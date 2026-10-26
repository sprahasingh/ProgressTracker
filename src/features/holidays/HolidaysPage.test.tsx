import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../components/ui/ToastProvider'
import { HolidaysPage } from './HolidaysPage'

const mocks = vi.hoisted(() => ({ listAccountHolidays: vi.fn(), listTrackerHolidays: vi.fn().mockResolvedValue([]), listTrackers: vi.fn().mockResolvedValue([]), saveTrackerHoliday: vi.fn(), setTrackerHolidaySelections: vi.fn().mockResolvedValue(undefined), convertHolidayScope: vi.fn().mockResolvedValue(undefined), removeTrackerHoliday: vi.fn(), listPermanentHolidayDeletionRequests: vi.fn(), restoreAccountHoliday: vi.fn(), updateAccountHoliday: vi.fn(), requestPermanentHolidayDeletion: vi.fn(), removeAccountHoliday: vi.fn(), syncNow: vi.fn(), auth: { status: 'local-only', user: null as { id: string } | null, workspaceStatus: 'ready', workspaceUserId: null as string | null, sessionTransitionPending: false, isOnline: true } }))
vi.mock('../../db/localRepository', () => ({ localRepository: mocks }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ ...mocks.auth, syncNow: mocks.syncNow }) }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))

const removedHoliday = { id: 'removed-holiday', date: '2026-10-10' as const, reason: 'travel' as const, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', deletedAt: '2026-10-02T00:00:00.000Z' }

beforeEach(() => {
  mocks.auth = { status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false, isOnline: true }
  mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [] : []))
  mocks.listTrackerHolidays.mockResolvedValue([])
  mocks.listTrackers.mockResolvedValue([])
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
    expect(screen.getByRole('dialog', { name: 'Holidays & Breaks' })).toHaveTextContent('Global holidays apply across your workspace')
    expect(screen.getByRole('dialog', { name: 'Holidays & Breaks' })).toHaveTextContent('Strict Mode trackers cannot be selected')
    expect(screen.getByRole('dialog', { name: 'Holidays & Breaks' })).toHaveTextContent('clearing the check-in restores its holiday status')
    expect(screen.getByRole('dialog', { name: 'Holidays & Breaks' })).toHaveTextContent('Goal plans keep their existing holiday rules')
    expect(container.querySelector('.calendar-legend')).not.toBeInTheDocument()
    expect(screen.queryByText(/Blue · Holiday/)).not.toBeInTheDocument()
  })

  it('offers multi-select only for Standard Mode trackers and saves their IDs offline-first', async () => {
    const standard = { id: 'standard-tracker', name: 'Reading', status: 'active', deletedAt: null, strictMode: false }
    const second = { id: 'second-standard-tracker', name: 'Writing', status: 'active', deletedAt: null, strictMode: false }
    const strict = { id: 'strict-tracker', name: 'Daily coding', status: 'active', deletedAt: null, strictMode: true }
    mocks.auth = { status: 'signed-in', user: { id: 'holiday-owner' }, workspaceStatus: 'ready', workspaceUserId: 'holiday-owner', sessionTransitionPending: false, isOnline: true }
    mocks.listAccountHolidays.mockResolvedValue([])
    mocks.listTrackers.mockResolvedValue([standard, second, strict])
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)

    await screen.findByRole('radio', { name: 'Selected trackers' })
    await user.click(screen.getByRole('radio', { name: 'Selected trackers' }))
    const picker = screen.getByRole('group', { name: 'Choose Standard Mode trackers' })
    expect(within(picker).getByLabelText('Reading')).toBeInTheDocument()
    expect(within(picker).getByLabelText('Writing')).toBeInTheDocument()
    expect(within(picker).queryByLabelText('Daily coding')).not.toBeInTheDocument()
    await user.click(within(picker).getByLabelText('Reading'))
    await user.click(within(picker).getByLabelText('Writing'))
    await user.click(screen.getByRole('button', { name: 'Mark holiday' }))
    await waitFor(() => expect(mocks.setTrackerHolidaySelections).toHaveBeenCalledWith([{ date: expect.any(String), trackerIds: [standard.id, second.id] }]))
    expect(mocks.syncNow).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'More about Holidays & Breaks' })).toBeInTheDocument()
  })

  it('explains holiday scope and effective work rules in the accessible info popover', async () => {
    mocks.listAccountHolidays.mockResolvedValue([])
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Explain holiday scope' }))
    const dialog = screen.getByRole('dialog', { name: 'Apply holiday to' })
    expect(dialog).toHaveTextContent('All trackers creates a global holiday, but only Standard Mode requirements are excused.')
    expect(dialog).toHaveTextContent('Selected trackers applies only to chosen Standard Mode trackers.')
    expect(dialog).toHaveTextContent('Strict Mode trackers cannot receive holiday exemptions and continue following their normal requirements.')
    expect(dialog).toHaveTextContent('Positive recorded progress overrides the holiday for that tracker and date.')
    expect(dialog).toHaveTextContent('Clearing that check-in restores the holiday.')
    await user.click(within(dialog).getByRole('button', { name: 'Close explanation' }))
    expect(screen.queryByRole('dialog', { name: 'Apply holiday to' })).not.toBeInTheDocument()
  })

  it('preserves selected tracker IDs when editing and allows adding another tracker', async () => {
    const first = { id: 'selected-first', name: 'Reading', status: 'active', deletedAt: null, strictMode: false }
    const second = { id: 'selected-second', name: 'Writing', status: 'active', deletedAt: null, strictMode: false }
    const strict = { id: 'selected-strict', name: 'Daily coding', status: 'active', deletedAt: null, strictMode: true }
    const selected = { id: 'selected-holiday', trackerId: first.id, date: '2026-10-10', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null }
    mocks.listTrackers.mockResolvedValue([first, second, strict])
    mocks.listTrackerHolidays.mockResolvedValue([selected])
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'More actions for selected holiday 2026-10-10' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit holiday' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit holiday' })
    const picker = within(dialog).getByRole('group', { name: 'Choose Standard Mode trackers' })
    expect(within(dialog).getByRole('radio', { name: 'Selected trackers' })).toBeChecked()
    expect(within(picker).getByLabelText('Reading')).toBeChecked()
    expect(within(picker).queryByLabelText('Daily coding')).not.toBeInTheDocument()
    await user.click(within(picker).getByLabelText('Writing'))
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mocks.setTrackerHolidaySelections).toHaveBeenCalledWith([{ date: selected.date, trackerIds: [first.id, second.id] }]))
  })

  it('requires an explicit scope change when converting a global holiday to selected trackers', async () => {
    const active = { ...removedHoliday, deletedAt: null }
    const standard = { id: 'convert-standard', name: 'Reading', status: 'active', deletedAt: null, strictMode: false }
    mocks.listAccountHolidays.mockImplementation((_start, _end, includeDeleted) => Promise.resolve(includeDeleted ? [active] : [active]))
    mocks.listTrackers.mockResolvedValue([standard])
    const user = userEvent.setup()
    render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'More actions for 2026-10-10' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit holiday' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit holiday' })
    await user.click(within(dialog).getByRole('radio', { name: 'Selected trackers' }))
    const picker = within(dialog).getByRole('group', { name: 'Choose Standard Mode trackers' })
    await user.click(within(picker).getByLabelText('Reading'))
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mocks.convertHolidayScope).toHaveBeenCalledWith({
      source: { scope: 'global', id: active.id }, date: active.date, scope: 'selected', reason: null, trackerIds: [standard.id],
    }))
    expect(mocks.setTrackerHolidaySelections).not.toHaveBeenCalled()
    expect(mocks.removeAccountHoliday).not.toHaveBeenCalled()
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
