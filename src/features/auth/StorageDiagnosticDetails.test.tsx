import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageDiagnosticDetails } from './StorageDiagnosticDetails'

describe('StorageDiagnosticDetails', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('shows safe diagnostic fields and offers copy without exposing raw exception text', async () => {
    const diagnostic = {
      operation: 'ProgressTrackerDatabase.transaction:trackers', stage: 'transaction' as const,
      category: 'transaction' as const, browser: 'safari', occurredAt: '2026-11-06T00:00:00.000Z',
      errorName: 'AbortError', errorCode: 20,
    }
    render(<StorageDiagnosticDetails diagnostic={diagnostic} />)
    fireEvent.click(screen.getByText('Technical diagnostic'))
    expect(screen.getByText(diagnostic.operation)).toBeInTheDocument()
    expect(screen.getByText('AbortError')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy safe diagnostic' }))
    expect(await screen.findByRole('status')).toHaveTextContent('operation metadata only')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify(diagnostic, null, 2))
    expect(document.body.textContent).not.toContain('tracker contents')
  })

  it('renders nothing when there is no failure diagnostic', () => {
    const { container } = render(<StorageDiagnosticDetails diagnostic={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
