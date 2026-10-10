import type { ReactNode } from 'react'

type EmptyStateProps = {
  icon?: ReactNode
  title: string
  description: string
  note?: ReactNode
  secondary?: ReactNode
  action?: ReactNode
}

export function EmptyState({ icon = '✳', title, description, note, secondary, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">{icon}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {note && <p className="empty-state-note">{note}</p>}
      {action && <div className="empty-state-action">{action}</div>}
      {secondary && <div className="empty-state-secondary">{secondary}</div>}
    </div>
  )
}
