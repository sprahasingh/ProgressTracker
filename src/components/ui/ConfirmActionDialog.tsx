import { Button } from './Button'

export function ConfirmActionDialog({ title, description, actionLabel, onCancel, onConfirm, destructive = false }: {
  title: string
  description: string
  actionLabel: string
  onCancel: () => void
  onConfirm: () => void
  destructive?: boolean
}) {
  return <div className="tracker-discard-backdrop" role="presentation"><section className="tracker-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-action-title" aria-describedby="confirm-action-description">
    <h2 id="confirm-action-title">{title}</h2><p id="confirm-action-description">{description}</p>
    <div><Button type="button" variant="quiet" onClick={onCancel}>Cancel</Button><Button type="button" variant={destructive ? 'destructive' : 'primary'} onClick={onConfirm}>{actionLabel}</Button></div>
  </section></div>
}
