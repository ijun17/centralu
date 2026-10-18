import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

/**
 * A framed text button: the one look every screen used to spell out in place (owner, 2026-10-18).
 *
 * Before this, 97 buttons assembled `rounded-md border border-line px-… py-… text-…` at their call sites, and
 * paddings, sizes, hover colours and the disabled fade drifted between them (`px-2`/`px-2.5`, `py-0.5`/`py-1`,
 * `disabled:opacity-40`/`50`/`60`, a hover that brightened the border here and the fill there). Reading them all, six
 * kinds were in use, and those are the variants:
 *
 * - `primary`: the action a dialog or a card is for (Create, Save, Import). Filled, white ink.
 * - `secondary`: an action that stands beside the main one without being it (Retry, Copy, Edit). Framed, white ink.
 * - `quiet`: a framed action that should not draw the eye (Cancel, Refresh, Remove from a list): grey until hovered.
 * - `subtle`: `quiet` in the faint ink, for a control inside a line of reading (a conversation row's Stop, loading
 *   earlier messages): as dim as the text around it, so it never outshines what the agent wrote.
 * - `danger`: what cannot be taken back (Delete for good). The danger colour, the only chromatic one a button wears.
 * - `ghost`: a word with no frame (Cancel beside a confirmation), grey until hovered.
 *
 * And three sizes, from the screens: `md` for a dialog's actions, `sm` for an action inside a card or a row, `xs` for
 * the small chip in a line of text (a conversation row's "show", a picker's span).
 *
 * `onRaised`: the fill of `primary` is the raised surface, so on a card that is itself raised it would vanish into
 * it; there it takes the floor instead, which is what those cards did by hand.
 *
 * `busy`: the action is running. The button is disabled (a second press would start the same thing twice, see
 * InlineConfirm) and, when `busyText` is given, says so ("Creating…").
 *
 * `className` is for placement only (margin, flex, width, text alignment). A colour, padding or size passed there
 * competes with the variant's own, and which one wins in Tailwind is the order of the generated CSS, not of the
 * attribute (IconButton's `lit` says the same): add a variant here instead.
 *
 * Hover reacts only while enabled: a disabled button that still brightened on hover looked pressable. Disabled fades
 * to 50%, the one fade every shared control uses (owner, 2026-10-18).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'subtle' | 'danger' | 'ghost'
export type ButtonSize = 'xs' | 'sm' | 'md'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'border border-line text-ink enabled:hover:border-line-strong',
  secondary: 'border border-line text-ink enabled:hover:border-line-strong',
  quiet: 'border border-line text-ink-muted enabled:hover:border-line-strong enabled:hover:text-ink',
  subtle: 'border border-line text-ink-faint enabled:hover:border-line-strong enabled:hover:text-ink',
  danger: 'border border-danger/40 bg-danger-bg text-danger enabled:hover:border-danger/70',
  ghost: 'text-ink-faint enabled:hover:text-ink',
}

const SIZE: Record<ButtonSize, string> = {
  xs: 'px-1.5 text-2xs',
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1 text-sm',
}

/** The classes of a button's look, for the rare element that must look like one without being a `<button>` */
export function buttonClass({
  variant = 'secondary',
  size = 'md',
  onRaised = false,
}: { variant?: ButtonVariant; size?: ButtonSize; onRaised?: boolean } = {}): string {
  const fill = variant === 'primary' ? (onRaised ? 'bg-surface-floor' : 'bg-surface-raised') : ''
  return `rounded-md transition-colors disabled:opacity-50 ${VARIANT[variant]} ${fill} ${SIZE[size]}`.replace(/\s+/g, ' ').trim()
}

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Sits on a raised card: `primary` fills with the floor so it still reads as a button */
  onRaised?: boolean
  /** The action is running: disabled, and `busyText` in place of the label when given */
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
