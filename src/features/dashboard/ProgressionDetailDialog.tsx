import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'

export function ProgressionDetailDialog({ title, eyebrow, onClose, children }: {
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
}) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useModalLayer(true, dialogRef, onClose)
  useVisualViewportBounds(true, backdropRef)
  useEffect(() => { closeRef.current?.focus() }, [])

  return createPortal(<div ref={backdropRef} className="modal-backdrop progression-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className="progression-dialog" role="dialog" aria-modal="true" aria-labelledby="progression-dialog-title" tabIndex={-1}>
      <header className="progression-dialog-header">
        <div>{eyebrow && <span className="eyebrow"><span className="eyebrow-line" />{eyebrow}</span>}<h2 id="progression-dialog-title">{title}</h2></div>
        <button ref={closeRef} type="button" className="info-dialog-close" aria-label="Close details" onClick={onClose}><AppIcon name="close" /></button>
      </header>
      <div className="progression-dialog-content">{children}</div>
    </section>
  </div>, document.body)
}
