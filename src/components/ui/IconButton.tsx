import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  label: string
  children: ReactNode
  iconSize?: 'small' | 'medium'
  shape?: 'circle' | 'rounded'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label,
  children,
  iconSize = 'medium',
  shape = 'circle',
  className = '',
  type = 'button',
  ...props
}, ref) {
  return <button
    {...props}
    ref={ref}
    type={type}
    className={`icon-button icon-button-${iconSize} icon-button-${shape}${className ? ` ${className}` : ''}`}
    aria-label={label}
  >{children}</button>
})
