import type { ReactNode } from 'react'
import { InfoButton } from './InfoButton'

type PageHeaderProps = {
  headingId?: string
  eyebrow?: string
  title: string
  description?: string
  action?: ReactNode
  help?: { title: string; summary: string; description: string }
}

export function PageHeader({ headingId, eyebrow, title, description, action, help }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        {eyebrow && <div className="eyebrow"><span className="eyebrow-line" />{eyebrow}</div>}
        <div className="page-title-row"><h1 id={headingId} className="page-title">{title}<span className="title-period">.</span></h1>{help && <InfoButton {...help} />}</div>
        {description && <p className="page-description">{description}</p>}
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </header>
  )
}
