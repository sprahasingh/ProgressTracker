import type { ButtonHTMLAttributes, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'destructive'
type ButtonSize = 'small' | 'medium' | 'large'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  leadingIcon?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'medium',
  leadingIcon,
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button className={`button button-${variant} button-${size}${className ? ` ${className}` : ''}`} {...props}>
      {leadingIcon && <span className="button-icon" aria-hidden="true">{leadingIcon}</span>}
      {children}
    </button>
  )
}
