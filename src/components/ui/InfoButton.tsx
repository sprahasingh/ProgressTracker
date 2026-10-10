import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './IconButton'
import { useModalLayer } from './useModalLayer'

type Props = {
  title: string
  summary: string
  description: string
  label?: string
}

const OPEN_INFO_EVENT = 'progress-tracker:open-info'

/** One accessible, viewport-aware popover shared by every information control. */
export function InfoButton({ title, summary, description, label = `More about ${title}` }: Props) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreTriggerFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: -1000, left: -1000 })

  useModalLayer(open, popoverRef, () => {
    restoreTriggerFocus.current = true
    setOpen(false)
  })

  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false)
    }
    document.addEventListener(OPEN_INFO_EVENT, onOpen)
    return () => document.removeEventListener(OPEN_INFO_EVENT, onOpen)
  }, [id])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const trigger = buttonRef.current
      const popover = popoverRef.current
      if (!trigger || !popover) return
      const anchor = trigger.getBoundingClientRect()
      const viewport = window.visualViewport
      const viewTop = viewport?.offsetTop ?? 0
      const viewLeft = viewport?.offsetLeft ?? 0
      const viewHeight = viewport?.height ?? window.innerHeight
      const viewWidth = viewport?.width ?? window.innerWidth
      popover.style.maxHeight = `${Math.max(120, Math.min(520, viewHeight - 24))}px`
      popover.style.maxWidth = `${Math.max(180, viewWidth - 24)}px`
      const panel = popover.getBoundingClientRect()
      if (anchor.width === 0 && anchor.height === 0) {
        setPosition({ top: -1000, left: -1000 })
        return
      }
      const gap = 8
      const margin = 12
      const below = anchor.bottom + gap + panel.height <= viewTop + viewHeight - margin
      const top = below ? anchor.bottom + gap : Math.max(viewTop + margin, anchor.top - panel.height - gap)
      const centeredLeft = anchor.left + anchor.width / 2 - panel.width / 2
      const left = Math.min(Math.max(viewLeft + margin, centeredLeft), Math.max(viewLeft + margin, viewLeft + viewWidth - panel.width - margin))
      setPosition({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (buttonRef.current) observer?.observe(buttonRef.current)
    if (popoverRef.current) observer?.observe(popoverRef.current)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
      observer?.disconnect()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !buttonRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  useEffect(() => {
    if (open) closeRef.current?.focus()
    else if (restoreTriggerFocus.current) {
      restoreTriggerFocus.current = false
      buttonRef.current?.focus()
    }
  }, [open])

  function toggle() {
    if (!open) document.dispatchEvent(new CustomEvent(OPEN_INFO_EVENT, { detail: id }))
    setOpen((current) => !current)
  }

  return <>
    <button
      ref={buttonRef}
      type="button"
      className="info-button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? `info-popover-${id}` : undefined}
      title={label}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggle() }}
    />
    {open && createPortal(<div
      ref={popoverRef}
      id={`info-popover-${id}`}
      className="info-popover"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`info-title-${id}`}
      style={{ position: 'fixed', top: position.top, left: position.left }}
    >
      <div className="info-popover-heading"><IconButton ref={closeRef} className="info-dialog-close" label="Close explanation" onClick={() => { restoreTriggerFocus.current = true; setOpen(false) }}>×</IconButton></div>
      <div className="info-popover-content">
        <p className="info-dialog-summary">{summary}</p>
        <h2 id={`info-title-${id}`}>{title}</h2>
        <p className="info-dialog-description">{description}</p>
      </div>
    </div>, document.body)}
  </>
}
