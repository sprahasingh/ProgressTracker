import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AppIcon } from './AppIcon'
import { Button } from './Button'
import { useModalLayer } from './useModalLayer'
import { useVisualViewportBounds } from './useVisualViewportBounds'

export function ConfirmActionDialog({ title, description, actionLabel, onCancel, onConfirm, destructive = false, actionDisabled = false, cancelDisabled = false, details, layer = 'default', actionVariant }: {
  title: string
  description: string
  actionLabel: string
  onCancel: () => void
  onConfirm: () => void
  destructive?: boolean
  actionDisabled?: boolean
  cancelDisabled?: boolean
  details?: string
  layer?: 'default' | 'checkin'
  actionVariant?: 'primary' | 'secondary' | 'destructive'
}) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  useModalLayer(true, dialogRef, onCancel, { manageHistoryEntry: layer === 'checkin' })
  useVisualViewportBounds(layer === 'checkin', backdropRef)
  useEffect(() => { dialogRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus() }, [])
  const variant = actionVariant ?? (destructive ? 'destructive' : 'primary')
  const dialog = <div ref={backdropRef} className={`modal-backdrop tracker-discard-backdrop${layer === 'checkin' ? ' checkin-confirm-backdrop' : ''}`} role="presentation">
    <section ref={dialogRef} className={`tracker-discard-dialog${layer === 'checkin' ? ' checkin-confirm-dialog' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-action-title" aria-describedby="confirm-action-description" tabIndex={-1}>
      <h2 id="confirm-action-title">{title}</h2>
      <p id="confirm-action-description">{description}</p>
      {details && <details className="confirm-action-details"><summary><AppIcon name="info" />More details</summary><p>{details}</p></details>}
      <div className="confirm-action-buttons">
        <Button type="button" variant={layer === 'checkin' ? 'secondary' : 'quiet'} disabled={cancelDisabled} onClick={onCancel}>Cancel</Button>
        <Button type="button" variant={variant} disabled={actionDisabled} onClick={onConfirm}>{actionLabel}</Button>
      </div>
    </section>
  </div>
  return layer === 'checkin' ? createPortal(dialog, document.body) : dialog
}
