import type { ReactNode } from 'react'
import { InfoButton } from './InfoButton'

type Props = {
  title?: string
  headingId?: string
  level?: 2 | 3
  eyebrow?: ReactNode
  description?: string
  help?: { title: string; summary: string; description: string }
  action?: ReactNode
  status?: ReactNode
  className?: string
}

/** Responsive heading/action grouping for sections, cards, and disclosure content. */
export function SectionHeader({ title, headingId, level = 2, eyebrow, description, help, action, status, className = '' }: Props) {
  const Heading = level === 3 ? 'h3' : 'h2'
  return <div className={`section-header-container ${className}`.trim()}>
    <header className={`section-header${title ? '' : ' section-header-actions-only'}`}>
      {title && <div className="section-header-title">
        {eyebrow && <span className="section-header-eyebrow">{eyebrow}</span>}
        <div className="section-header-title-row"><Heading id={headingId}>{title}</Heading>{help && <InfoButton {...help} />}</div>
      </div>}
      {status && <div className="section-header-status">{status}</div>}
      {(action || (!title && help)) && <div className="section-header-actions">{!title && help && <InfoButton {...help} />}{action}</div>}
      {description && <p className="section-header-description">{description}</p>}
    </header>
  </div>
}
