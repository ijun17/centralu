import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

/**
 * A framed text button; the variants and sizes are in docs/design-system.md §11. `subtle` sits in a line of reading
 * (a conversation row's Stop) as dim as the text around it; `danger` is the only chromatic button.
 *
 * `className` is for placement only: a colour or size there competes with the variant's, and Tailwind picks by the
 * order of the generated CSS, not of the attribute, so add a variant here instead. Hover reacts only while enabled
 * (a disabled button that brightens looks pressable); disabled is the 50% fade (§10).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'subtle' | 'danger' | 'ghost' | 'choice'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'border border-line text-ink enabled:hover:border-line-strong',
  secondary: 'border border-line text-ink enabled:hover:border-line-strong',
  quiet: 'border border-line text-ink-muted enabled:hover:border-line-strong enabled:hover:text-ink',
  subtle: 'border border-line text-ink-faint enabled:hover:border-line-strong enabled:hover:text-ink',
  danger: 'border border-line-strong bg-danger-bg text-danger enabled:hover:border-danger',
  ghost: 'text-ink-faint enabled:hover:text-ink',
  choice: 'border border-line-strong text-ink enabled:hover:bg-surface-selected aria-pressed:bg-surface-selected aria-pressed:disabled:opacity-100',
}

const SIZE: Record<ButtonSize, string> = {
  xs: 'px-1.5 text-2xs',
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1 text-sm',
  lg: 'px-3 py-1.5 text-sm',
}

/** The classes of a button's look, for the rare element that must look like one without being a `<button>` */
export function buttonClass({
  variant = 'secondary',
  size = 'md',
  onRaised = false,
}: { variant?: ButtonVariant; size?: ButtonSize; onRaised?: boolean } = {}): string {
  const fill = variant === 'primary' ? (onRaised ? 'bg-surface-floor' : 'bg-surface-raised') : ''
  return `rounded-md transition disabled:opacity-50 ${VARIANT[variant]} ${fill} ${SIZE[size]}`.replace(/\s+/g, ' ').trim()
}

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Sits on a raised card: `primary` fills with the floor so it still reads as a button */
  onRaised?: boolean
  /** The action is running: disabled (a second press would start it twice), `busyText` in place of the label */
  busy?: boolean
  busyText?: ReactNode
  type?: 'button' | 'submit'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', onRaised = false, busy = false, busyText, type = 'button', disabled, className = '', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${buttonClass({ variant, size, onRaised })} ${className}`.trim()}
      {...rest}
    >
      {busy && busyText !== undefined ? busyText : children}
    </button>
  )
})
