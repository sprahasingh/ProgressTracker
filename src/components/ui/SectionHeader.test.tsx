import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SectionHeader } from './SectionHeader'
import styles from '../../styles.css?raw'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SectionHeader', () => {
  it('groups the heading, information button, description, and section action', () => {
    render(<SectionHeader title="Measures" headingId="measures-title" description="Choose what to record." help={{ title: 'Measures', summary: 'Short explanation.', description: 'More detail.' }} action={<button type="button">Add measure</button>} />)
    const header = screen.getByRole('heading', { name: 'Measures' }).closest('.section-header')!
    expect(header.querySelector('.section-header-title')).toContainElement(screen.getByRole('button', { name: 'More about Measures' }))
    expect(header.querySelector('.section-header-actions')).toContainElement(screen.getByRole('button', { name: 'Add measure' }))
    expect(header.querySelector('.section-header-description')).toHaveTextContent('Choose what to record.')
  })

  it.each([320, 360, 390, 430, 768, 1280])('keeps the responsive header structure at %ipx', (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    render(<SectionHeader title="Custom fields" description="A long description should occupy the full header width and wrap naturally." action={<button type="button">＋ Add field</button>} />)
    const title = screen.getByRole('heading', { name: 'Custom fields' })
    expect(title.closest('.section-header')).toContainElement(screen.getByRole('button', { name: '＋ Add field' }))
    expect(styles).toMatch(/\.section-header\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) max-content max-content/s)
    expect(styles).toMatch(/@container\s*\(max-width:\s*360px\)[\s\S]*?grid-template-areas:\s*"title status"\s*"actions actions"\s*"description description"/)
    expect(styles).toMatch(/\.section-header-actions \.button\s*\{[^}]*white-space:\s*normal/s)
  })

  it('keeps milestone actions outside the disclosure trigger and avoids a repeated heading', async () => {
    const user = userEvent.setup()
    render(<details><summary>Milestones</summary><section aria-label="Milestones"><SectionHeader description="Break a larger outcome into checkpoints." help={{ title: 'Milestones', summary: 'Short help.', description: 'Milestone details.' }} action={<button type="button">＋ Add milestone</button>} /></section></details>)
    const disclosure = document.querySelector('details')!
    await user.click(screen.getByText('Milestones', { selector: 'summary' }))
    expect(disclosure).toHaveAttribute('open')
    expect(screen.queryByRole('heading', { name: 'Milestones' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '＋ Add milestone' }))
    expect(disclosure).toHaveAttribute('open')
    await user.click(screen.getByRole('button', { name: 'More about Milestones' }))
    expect(screen.getByRole('dialog', { name: 'Milestones' })).toBeInTheDocument()
    await user.click(screen.getByText('Milestones', { selector: 'summary' }))
    expect(disclosure).not.toHaveAttribute('open')
  })
})
