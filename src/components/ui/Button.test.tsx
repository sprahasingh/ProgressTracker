import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Button } from './Button'
import { IconButton } from './IconButton'
import styles from '../../styles.css?raw'
import tokens from '../../styles/tokens.css?raw'

afterEach(cleanup)

describe('shared button system', () => {
  it('exposes primary, secondary, quiet, and destructive variants at small, medium, and large sizes', () => {
    const { container } = render(<>
      <Button size="small">Edit</Button>
      <Button variant="secondary" size="medium">Cancel</Button>
      <Button variant="quiet" size="large">View details</Button>
      <Button variant="destructive" size="small">Delete</Button>
    </>)
    expect(container.querySelector('.button-primary.button-small')).toHaveTextContent('Edit')
    expect(container.querySelector('.button-secondary.button-medium')).toHaveTextContent('Cancel')
    expect(container.querySelector('.button-quiet.button-large')).toHaveTextContent('View details')
    expect(container.querySelector('.button-destructive.button-small')).toHaveTextContent('Delete')
    expect(tokens).toContain('--button-height-small: 36px')
    expect(tokens).toContain('--button-height-medium: 44px')
    expect(tokens).toContain('--button-height-large: 48px')
    expect(styles).toMatch(/\.button-destructive\s*\{[^}]*var\(--danger-soft\)[^}]*var\(--danger\)/s)
  })

  it('keeps disabled controls disabled and gives icon buttons an accessible name and touch target', () => {
    render(<><Button disabled>Saving…</Button><IconButton label="Close dialog">×</IconButton></>)
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveClass('icon-button')
    expect(styles).toMatch(/\.icon-button\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s)
    expect(styles).toMatch(/\.button:focus-visible\s*\{/)
  })

  it('wraps button labels at spaces while protecting their intrinsic word width', () => {
    render(<Button variant="secondary">Use this device’s version from an unusually narrow screen</Button>)
    expect(screen.getByRole('button')).toHaveClass('button-medium')
    expect(styles).toMatch(/\.button\s*\{[^}]*min-width:\s*min-content[^}]*max-width:\s*100%[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*normal/s)
    expect(styles).toMatch(/\.button\s*\{[^}]*flex-shrink:\s*0/s)
  })
})
