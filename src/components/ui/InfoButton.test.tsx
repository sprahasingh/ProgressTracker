import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InfoButton } from './InfoButton'
import styles from '../../styles.css?raw'

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

  it('uses a content-sized mobile sheet only when the anchored explanation cannot fit', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('info-button')) return new DOMRect(180, 380, 44, 44)
      if (this.classList.contains('info-popover')) return new DOMRect(0, 0, 300, 220)
      if (this.classList.contains('mobile-nav')) return new DOMRect(0, 760, 390, 84)
      return new DOMRect(0, 0, 0, 0)
    })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('info-popover') ? 620 : 0
    })
    const nav = document.createElement('div')
    nav.className = 'mobile-nav'
    document.body.append(nav)
    render(<InfoButton title="Heatmap" summary="A summary." description={'More detail. '.repeat(80)} />)
    fireEvent.click(screen.getByRole('button', { name: 'More about Heatmap' }))
    const popover = screen.getByRole('dialog', { name: 'Heatmap' })
    expect(popover).toHaveAttribute('data-presentation', 'sheet')
    expect(popover).toHaveAttribute('aria-modal', 'true')
    expect(popover).toHaveStyle({ left: '12px' })
    expect(Number.parseFloat(popover.style.top)).toBeGreaterThanOrEqual(12)
    expect(Number.parseFloat(popover.style.top)).toBeLessThan(760)
    nav.remove()
  })

  it.each([320, 360, 390, 430, 768, 1024, 1440])('clamps the popup inside a %ipx viewport near the right edge', (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('info-button')) return new DOMRect(width - 44, 100, 44, 44)
      if (this.classList.contains('info-popover')) return new DOMRect(0, 0, Math.min(320, width - 24), 180)
      return new DOMRect(0, 0, 0, 0)
    })
    render(<InfoButton title="Responsive" summary="Summary." description="Details." />)
    fireEvent.click(screen.getByRole('button', { name: 'More about Responsive' }))
    const popover = screen.getByRole('dialog', { name: 'Responsive' })
    const left = Number.parseFloat(popover.style.left)
    const panelWidth = Math.min(320, width - 24)
    expect(left).toBeGreaterThanOrEqual(12)
    expect(left + panelWidth).toBeLessThanOrEqual(width - 12)
  })

  it('keeps information icons visually compact while retaining a 44px touch target', () => {
    render(<InfoButton title="Schedule" summary="Summary." description="Details." />)
    expect(screen.getByRole('button', { name: 'More about Schedule' })).toHaveClass('info-button')
    expect(styles).toMatch(/\.info-button\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s)
    expect(styles).toMatch(/\.info-button::before\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/s)
    expect(styles).toMatch(/\.info-button\s*\{[^}]*font:\s*700 16px\/1/s)
  })

  it('stops an information click from activating a containing card', () => {
    const activateCard = vi.fn()
    render(<div onClick={activateCard}><InfoButton title="Daily target" summary="Summary." description="Details." /></div>)
    fireEvent.click(screen.getByRole('button', { name: 'More about Daily target' }))
    expect(activateCard).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Daily target' })).toBeInTheDocument()
  })
})
