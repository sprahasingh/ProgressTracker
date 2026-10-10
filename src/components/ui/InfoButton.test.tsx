import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InfoButton } from './InfoButton'

describe('InfoButton', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('opens an explanation with the highlighted summary before the full description', () => {
    render(<InfoButton title="Daily target" summary="A short summary." description="A detailed explanation at the bottom." />)

    fireEvent.click(screen.getByRole('button', { name: 'More about Daily target' }))

    const dialog = screen.getByRole('dialog', { name: 'Daily target' })
    expect(dialog).toHaveTextContent('A short summary.')
    expect(dialog).toHaveTextContent('A detailed explanation at the bottom.')
    expect(dialog.querySelector('.info-dialog-summary')?.textContent).toBe('A short summary.')
    expect(dialog.querySelector('.info-dialog-description')?.textContent).toBe('A detailed explanation at the bottom.')
    expect(dialog).toHaveClass('info-popover')
  })

  it('closes when the user presses Escape or clicks outside', () => {
    render(<InfoButton title="Schedule" summary="A summary." description="More details." />)
    fireEvent.click(screen.getByRole('button', { name: 'More about Schedule' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More about Schedule' }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps only one information popover open at a time', () => {
    render(<><InfoButton title="First" summary="One." description="Details one." /><InfoButton title="Second" summary="Two." description="Details two." /></>)
    fireEvent.click(screen.getByRole('button', { name: 'More about First' }))
    expect(screen.getByRole('dialog', { name: 'First' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More about Second' }))
    expect(screen.queryByRole('dialog', { name: 'First' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument()
  })

  it('keeps its close control outside the scrollable long-form content', () => {
    const trigger = render(<InfoButton title="Schedule" summary="Summary." description={'A long detail. '.repeat(300)} />).getByRole('button', { name: 'More about Schedule' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Schedule' })
    const close = screen.getByRole('button', { name: 'Close explanation' })
    expect(close.parentElement).toHaveClass('info-popover-heading')
    expect(dialog.querySelector('.info-popover-content')).toContainElement(dialog.querySelector('.info-dialog-description'))
    fireEvent.click(close)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('anchors the popover beside its icon and moves it above when there is no room below', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('info-button')) return new DOMRect(380, 750, 20, 20)
      if (this.classList.contains('info-popover')) return new DOMRect(0, 0, 360, 180)
      return new DOMRect(0, 0, 0, 0)
    })
    render(<InfoButton title="Deadline" summary="Summary." description="Details." />)
    fireEvent.click(screen.getByRole('button', { name: 'More about Deadline' }))
    const popover = screen.getByRole('dialog', { name: 'Deadline' })
    expect(popover).toHaveStyle({ top: '562px', left: '210px' })
  })
})
