import type { ReactNode } from 'react'

type PageHeaderProps = {
  headingId?: string
  eyebrow?: string
  title: string
  description?: string
  action?: ReactNode
}

export function PageHeader({ headingId, eyebrow, title, description, action }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        {eyebrow && <div className="eyebrow"><span className="eyebrow-line" />{eyebrow}</div>}
        <h1 id={headingId} className="page-title">{title}<span className="title-period">.</span></h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </header>
  )
}
