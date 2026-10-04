import type { ReactNode } from 'react'
import { Tooltip } from './primitives.jsx'

/**
 * A button with only an icon, no text.
 *
 * Leaving out text means there has to be a way to ask what the button is for. The browser's
 * native title takes 1-2 seconds to appear and its look does not match the app, and for something
 * like an icon button — normally taking up no space, but expected to answer immediately when
 * asked — that delay is effectively no information at all. So this uses our own tooltip (it
 * appears on focus as well as on hover — someone navigating by keyboard alone needs the same
 * information).
 *
 * Why icon buttons are gathered into one component: building them one at a time leaves some with
 * a tooltip and some without. That actually happened.
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
  className = '',
}: {
  /** Both the tooltip text and the name a screen reader announces — kept as one */
  label: string
  onClick?: () => void
  children: ReactNode
  testId?: string
  disabled?: boolean
  type?: 'button' | 'submit'
  placement?: 'bottom' | 'top'
  align?: 'left' | 'right'
  /**
   * On — the icon stands in white (gray otherwise).
   *
   * Why this is taken as a prop instead of overriding the color through className: in Tailwind,
   * when `text-ink-faint` and `text-ink` are both attached, which one wins is decided by the order
   * of the generated CSS, not the order of the class attribute — a visible state cannot be pinned
   * to something that can shift between builds. Here, only one of the two is ever attached.
   */
  lit?: boolean
  className?: string
}) {
  return (
    <Tooltip content={label} placement={placement} align={align}>
      <button
        type={type}
        className={`flex items-center justify-center rounded-md p-1 transition-colors hover:bg-surface-hover/60 hover:text-ink disabled:opacity-40 ${
          lit ? 'text-ink' : 'text-ink-faint'
        } ${className}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
      >
        {children}
      </button>
    </Tooltip>
  )
}
