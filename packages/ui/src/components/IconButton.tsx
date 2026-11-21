import type { ReactNode, Ref } from 'react'
import { Tooltip } from './primitives.jsx'

/**
 * A button with only an icon (docs/design-system.md §5): its label is our own tooltip, shown on hover and on focus,
 * since the native title takes 1-2 seconds and does not match the app.
 */
export function IconButton({
  label,
  onClick,
  children,
  testId,
  disabled,
  type = 'button',
  placement = 'bottom',
  align = 'left',
  lit = false,
  haspopup,
  expanded,
  ref,
  className = '',
}: {
  /** The tooltip and the accessible name, one string */
  label: string
  onClick?: () => void
  children: ReactNode
  testId?: string
  disabled?: boolean
  type?: 'button' | 'submit'
  placement?: 'bottom' | 'top'
  align?: 'left' | 'right'
  /**
   * The icon in `ink` rather than `ink-faint`. A prop, not a className: with both classes Tailwind picks by the order
   * of the generated CSS, which can shift between builds; here only one is ever attached.
   */
  lit?: boolean
  haspopup?: 'menu' | 'dialog'
  expanded?: boolean
  /** For a list anchored under the button */
  ref?: Ref<HTMLButtonElement>
  className?: string
}) {
  return (
    <Tooltip content={label} placement={placement} align={align}>
      <button
        ref={ref}
        type={type}
        className={`flex items-center justify-center rounded-md p-1 transition-colors hover:bg-surface-hover/60 hover:text-ink disabled:opacity-50 ${
          lit ? 'text-ink' : 'text-ink-faint'
        } ${className}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-haspopup={haspopup}
        aria-expanded={expanded}
        data-testid={testId}
      >
        {children}
      </button>
    </Tooltip>
  )
}
