import type { HTMLAttributes, ReactNode } from 'react'

type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode
  padded?: boolean
}

export function Surface({ children, padded = true, className = '', ...props }: SurfaceProps) {
  return (
    <div className={`surface${padded ? ' surface-padded' : ''}${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </div>
  )
}
