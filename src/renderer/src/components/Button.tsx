import type { ButtonHTMLAttributes, AnchorHTMLAttributes } from 'react'

type Variant = 'primary' | 'danger' | 'ghost' | 'subtle'

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  danger: 'bg-red-600 hover:bg-red-500 text-white',
  ghost: 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800',
  subtle: 'bg-zinc-700 hover:bg-zinc-600 text-zinc-100'
}

const BASE_CLASSES =
  'rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  active?: boolean
}

export function Button({
  variant = 'primary',
  active = false,
  className = '',
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const activeClasses = active ? 'bg-zinc-700 text-zinc-100' : VARIANT_CLASSES[variant]
  return (
    <button className={`${BASE_CLASSES} ${activeClasses} ${className}`} {...rest}>
      {children}
    </button>
  )
}

interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: Variant
}

export function LinkButton({
  variant = 'subtle',
  className = '',
  children,
  ...rest
}: LinkButtonProps): React.JSX.Element {
  return (
    <a
      target="_blank"
      rel="noreferrer"
      className={`${BASE_CLASSES} ${VARIANT_CLASSES[variant]} text-center truncate ${className}`}
      {...rest}
    >
      {children}
    </a>
  )
}
