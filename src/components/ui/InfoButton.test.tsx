import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InfoButton } from './InfoButton'

describe('InfoButton', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens an explanation with the highlighted summary before the full description', () => {
    render(<InfoButton title="Daily target" summary="A short summary." description="A detailed explanation at the bottom." />)

    fireEvent.click(screen.getByRole('button', { name: 'More about Daily target' }))

    const dialog = screen.getByRole('dialog', { name: 'Daily target information' })
    expect(dialog).toHaveTextContent('A short summary.')
    expect(dialog).toHaveTextContent('A detailed explanation at the bottom.')
    expect(dialog.querySelector('.info-dialog-summary')?.textContent).toBe('A short summary.')
    expect(dialog.querySelector('.info-dialog-description')?.textContent).toBe('A detailed explanation at the bottom.')
  })
})
