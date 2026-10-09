import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  title: string
  summary: string
  description: string
  label?: string
}

export function InfoButton({ title, summary, description, label = `More about ${title}` }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [buttonContainer, setButtonContainer] = useState<HTMLElement | null>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const button = buttonRef.current
    if (!button) return
    const containingLabel = button.closest('label')
    if (!containingLabel?.parentElement) return
    setButtonContainer(containingLabel.parentElement)
    const updatePosition = () => {
      const rect = button.getBoundingClientRect()
      // jsdom has no layout engine and reports every element at 0,0. Keep its
      // portaled controls out of simulated pointer targets; browsers use the
      // measured position normally.
      setPosition(rect.width === 0 && rect.height === 0
        ? { top: -1000, left: -1000 }
        : { top: rect.top, left: rect.left })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [])

  useEffect(() => {
    if (!open || !dialogRef.current) return
    if (dialogRef.current.showModal) dialogRef.current.showModal()
    else dialogRef.current.setAttribute('open', '')
  }, [open])

  const trigger = <button
    ref={buttonRef}
    type="button"
    className="info-button"
    aria-label={label}
      title={label}
    style={buttonContainer ? { position: 'fixed', top: position.top, left: position.left } : undefined}
    onClick={(event) => {
      event.preventDefault()
      event.stopPropagation()
      setOpen(true)
    }}
  />

  return <>
    {buttonContainer ? createPortal(trigger, buttonContainer) : trigger}
    {open && createPortal(<dialog ref={dialogRef} className="info-dialog" aria-label={`${title} information`} onClose={() => setOpen(false)}>
      <article className="info-dialog-card">
        <button className="info-dialog-close" type="button" onClick={() => {
          if (dialogRef.current?.close) dialogRef.current.close()
          else setOpen(false)
        }} aria-label="Close explanation">×</button>
        <p className="info-dialog-summary">{summary}</p>
        <h2>{title}</h2>
        <p className="info-dialog-description">{description}</p>
      </article>
    </dialog>, document.body)}
  </>
}
