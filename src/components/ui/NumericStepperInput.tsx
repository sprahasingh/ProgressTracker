import { useEffect, useRef, useState } from 'react'

type Props = {
  id: string
  label: string
  value: number | undefined
  step: number
  min?: number
  placeholder?: string
  onChange: (value: number | undefined) => void
  onValidityChange?: (valid: boolean) => void
}

function expandExponent(value: string): string {
  const match = value.match(/^(-?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/)
  if (!match) return value
  const [, sign, whole, fraction = '', exponentText] = match
  const digits = `${whole}${fraction}`
  const decimalAt = (whole ?? '').length + Number(exponentText)
  if (decimalAt <= 0) return `${sign}0.${'0'.repeat(-decimalAt)}${digits}`
  if (decimalAt >= digits.length) return `${sign}${digits}${'0'.repeat(decimalAt - digits.length)}`
  return `${sign}${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`
}

function decimalDigits(value: string): number {
  return expandExponent(value).split('.')[1]?.length ?? 0
}

function scaledInteger(value: string, digits: number): bigint | undefined {
  const normalized = expandExponent(value).replace(',', '.')
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d*))?$/)
  if (!match) return undefined
  const [, sign, whole, fraction = ''] = match
  const kept = fraction.slice(0, digits).padEnd(digits, '0')
  const integer = BigInt(`${whole}${kept}`)
  return sign === '-' ? -integer : integer
}

function formatScaled(value: bigint, digits: number): string {
  const negative = value < 0n
  const absolute = negative ? -value : value
  if (digits === 0) return `${negative ? '-' : ''}${absolute}`
  const raw = absolute.toString().padStart(digits + 1, '0')
  const whole = raw.slice(0, -digits)
  const fraction = raw.slice(-digits).replace(/0+$/, '')
  const formatted = fraction ? `${whole}.${fraction}` : whole
  return `${negative ? '-' : ''}${formatted}`
}

function parsedDraft(value: string, allowNegative = false): number | undefined {
  if (!(allowNegative ? /^-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?$/ : /^\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?$/).test(value)) return undefined
  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) && (allowNegative || parsed >= 0) ? parsed : undefined
}

export function NumericStepperInput({ id, label, value, step, min = 0, placeholder, onChange, onValidityChange }: Props) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const [focused, setFocused] = useState(false)
  const validity = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const callbackRef = useRef(onValidityChange)
  callbackRef.current = onValidityChange

  useEffect(() => {
    if (!focused && validity.current) setDraft(value === undefined ? '' : String(value))
  }, [value, focused])

  useEffect(() => () => {
    if (!validity.current) callbackRef.current?.(true)
  }, [])

  function markValid(next: boolean) {
    if (validity.current !== next) {
      validity.current = next
      callbackRef.current?.(next)
    }
  }

  function updateDraft(next: string) {
    setDraft(next)
    if (next === '') {
      onChange(undefined)
      markValid(true)
      return
    }
    const parsed = parsedDraft(next, min < 0)
    if (parsed !== undefined) {
      onChange(parsed)
      markValid(true)
    } else {
      markValid(false)
    }
  }

  function finishEditing() {
    setFocused(false)
    const parsed = parsedDraft(draft, min < 0)
    if (parsed !== undefined) {
      const normalized = String(parsed)
      setDraft(normalized)
      onChange(parsed)
      markValid(true)
      return
    }
    if (/^-?\d+[.,]$/.test(draft)) {
      const whole = Number(draft.slice(0, -1))
      setDraft(String(whole))
      onChange(whole)
      markValid(true)
      return
    }
    markValid(false)
  }

  function adjust(direction: 1 | -1) {
    if (draft !== '' && parsedDraft(draft, min < 0) === undefined) return
    const current = parsedDraft(draft, min < 0) ?? value ?? 0
    const digits = Math.max(decimalDigits(String(step)), decimalDigits(String(current)))
    const currentScaled = scaledInteger(String(current), digits)
    const stepScaled = scaledInteger(String(step), digits)
    if (currentScaled === undefined || stepScaled === undefined) return
    const nextScaled = currentScaled + BigInt(direction) * stepScaled
    const minimumScaled = scaledInteger(String(min), digits)
    if (minimumScaled === undefined || nextScaled < minimumScaled) return
    const nextText = formatScaled(nextScaled, digits)
    const next = Number(nextText)
    if (!Number.isFinite(next) || next === current) return
    setDraft(nextText)
    onChange(next)
    markValid(true)
  }

  const parsed = parsedDraft(draft, min < 0)
  const canAdjust = parsed !== undefined || draft === ''
  return <div className="numeric-stepper" role="group" aria-label={`${label} value`}>
    <button type="button" className="numeric-stepper-button" aria-label={`Decrease ${label}`} disabled={!canAdjust || (parsed ?? 0) <= min} onMouseDown={(event) => event.preventDefault()} onClick={() => adjust(-1)}>−</button>
    <input
      ref={inputRef}
      id={id}
      className="auth-input numeric-stepper-value"
      type="text"
      role="spinbutton"
      inputMode="decimal"
      autoComplete="off"
      aria-valuemin={min}
      aria-valuenow={parsed}
      aria-valuetext={parsed === undefined ? draft : String(parsed)}
      aria-label={label}
      aria-invalid={!validity.current}
      aria-describedby={!validity.current ? `${id}-input-error` : undefined}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={finishEditing}
      onChange={(event) => updateDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); adjust(1) }
        if (event.key === 'ArrowDown') { event.preventDefault(); adjust(-1) }
      }}
    />
    <button type="button" className="numeric-stepper-button" aria-label={`Increase ${label}`} disabled={!canAdjust} onMouseDown={(event) => event.preventDefault()} onClick={() => adjust(1)}>+</button>
      {!validity.current && <small className="numeric-stepper-error" id={`${id}-input-error`}>{min < 0 ? 'Finish entering a valid number.' : 'Finish entering a nonnegative number.'}</small>}
  </div>
}
