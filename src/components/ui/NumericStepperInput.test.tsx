import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NumericStepperInput } from './NumericStepperInput'
import styles from '../../styles.css?raw'

afterEach(cleanup)

function ControlledStepper({ onChange, onValidityChange }: { onChange: (value: number | undefined) => void; onValidityChange: (valid: boolean) => void }) {
  const [value, setValue] = useState<number | undefined>(2)
  return <NumericStepperInput id="amount" label="Amount" value={value} step={0.01} onChange={(next) => { setValue(next); onChange(next) }} onValidityChange={onValidityChange} />
}

describe('NumericStepperInput', () => {
  it('increments and decrements with an editable value and accessible control names', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumericStepperInput id="pages" label="Pages" value={3} step={1} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Increase Pages' }))
    expect(onChange).toHaveBeenLastCalledWith(4)
    expect(screen.getByRole('spinbutton', { name: 'Pages' })).toHaveValue('4')
    await user.click(screen.getByRole('button', { name: 'Decrease Pages' }))
    expect(onChange).toHaveBeenLastCalledWith(3)
  })

  it('disables decrement at zero and accepts direct editing, replacement, and pasteable decimal text', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumericStepperInput id="hours" label="Hours" value={0} step={0.1} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Decrease Hours' })).toBeDisabled()

    const input = screen.getByRole('spinbutton', { name: 'Hours' })
    await user.clear(input)
    await user.type(input, '1.5')
    expect(onChange).toHaveBeenLastCalledWith(1.5)
    expect(input).toHaveValue('1.5')
  })

  it('keeps temporary empty and unfinished decimal drafts, then normalizes on blur', async () => {
    const onChange = vi.fn()
    const onValidityChange = vi.fn()
    const user = userEvent.setup()
    render(<ControlledStepper onChange={onChange} onValidityChange={onValidityChange} />)
    const input = screen.getByRole('spinbutton', { name: 'Amount' })

    await user.clear(input)
    expect(input).toHaveValue('')
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    await user.type(input, '.')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
    await user.tab()
    expect(input).toHaveValue('.')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    await user.click(input)
    await user.clear(input)
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('aria-invalid', 'false')
  })

  it('uses decimal-safe increments at one and two places without floating-point artifacts', async () => {
    const onePlaceChange = vi.fn()
    const twoPlaceChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<NumericStepperInput id="one" label="Hours" value={1.2} step={0.1} onChange={onePlaceChange} />)
    await user.click(screen.getByRole('button', { name: 'Increase Hours' }))
    expect(onePlaceChange).toHaveBeenLastCalledWith(1.3)
    for (let index = 0; index < 9; index += 1) await user.click(screen.getByRole('button', { name: 'Increase Hours' }))
    expect(onePlaceChange).toHaveBeenLastCalledWith(2.2)
    expect(screen.getByRole('spinbutton', { name: 'Hours' })).toHaveValue('2.2')

    rerender(<NumericStepperInput id="two" label="Distance" value={1.25} step={0.01} onChange={twoPlaceChange} />)
    await user.click(screen.getByRole('button', { name: 'Increase Distance' }))
    expect(twoPlaceChange).toHaveBeenLastCalledWith(1.26)
    for (let index = 0; index < 9; index += 1) await user.click(screen.getByRole('button', { name: 'Increase Distance' }))
    expect(twoPlaceChange).toHaveBeenLastCalledWith(1.35)
    expect(screen.getByRole('spinbutton', { name: 'Distance' })).toHaveValue('1.35')
  })

  it('does not clamp a measurement at the configured target or silently permit invalid drafts to save', async () => {
    const onChange = vi.fn()
    const onValidityChange = vi.fn()
    const user = userEvent.setup()
    render(<NumericStepperInput id="problems" label="Problems" value={5} step={1} onChange={onChange} onValidityChange={onValidityChange} />)
    await user.click(screen.getByRole('button', { name: 'Increase Problems' }))
    expect(onChange).toHaveBeenLastCalledWith(6)

    const input = screen.getByRole('spinbutton', { name: 'Problems' })
    await user.clear(input)
    await user.type(input, '-2')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
  })

  it('respects custom fields that already allow negative numeric values', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumericStepperInput id="temperature" label="Temperature" value={-1} step={1} min={-Number.MAX_VALUE} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Decrease Temperature' }))
    expect(onChange).toHaveBeenLastCalledWith(-2)
  })

  it('keeps touch controls compact, full-width, and large enough for mobile use', () => {
    expect(styles).toMatch(/\.numeric-stepper\s*\{[^}]*grid-template-columns:\s*48px minmax\(0, 1fr\) 48px/s)
    expect(styles).toMatch(/\.numeric-stepper-button\s*\{[^}]*min-height:\s*48px/s)
    expect(styles).toMatch(/@media\s*\(max-width:\s*420px\)/)
  })
})
