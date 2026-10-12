import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../components/ui/ToastProvider'
import { HolidaysPage } from './HolidaysPage'

const mocks = vi.hoisted(() => ({ listAccountHolidays: vi.fn() }))
vi.mock('../../db/localRepository', () => ({ localRepository: mocks }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'local-only', user: null, workspaceStatus: 'ready', workspaceUserId: null, sessionTransitionPending: false }) }))
vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'UTC' }) }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Manage Holidays', () => {
  it('explains Standard and Strict Mode without repeating the activity status legend', async () => {
    mocks.listAccountHolidays.mockResolvedValue([])
    const { container } = render(<MemoryRouter><ToastProvider><HolidaysPage /></ToastProvider></MemoryRouter>)

    expect(await screen.findByRole('heading', { name: 'About holidays' })).toBeInTheDocument()
    expect(screen.getByText('Holidays apply to all trackers. Standard Mode pauses scheduled check-ins; Strict Mode still expects activity. Existing check-ins are preserved. Goal plans follow their own schedule rules.')).toBeInTheDocument()
    expect(container.querySelector('.calendar-legend')).not.toBeInTheDocument()
    expect(screen.queryByText(/Blue · Holiday/)).not.toBeInTheDocument()
  })
})
