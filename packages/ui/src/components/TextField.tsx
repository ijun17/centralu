import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'

/**
 * A framed text input, one frame for every screen. `size`: `md` a dialog's, `sm` in a settings card or beside a button,
 * `xs` in a line of text. `text="sm"` for the name or command a dialog is for. `font`: `mono` for paths and ids,
 * `readout` among figures. `surface`: the floor, a step below its dialog; `raised` on a panel that is the floor already
 * (a run's log); `side` for the sidebar's ground. `className` is placement only, as with Button.
 */
export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  size?: 'xs' | 'sm' | 'md'
  text?: 'xs' | 'sm'
  font?: 'body' | 'mono' | 'readout'
  surface?: 'floor' | 'raised' | 'side'
  invalid?: boolean
}

const PAD = { xs: 'px-1.5 py-0.5', sm: 'px-2 py-1', md: 'px-2 py-1.5' } as const
const FONT = { body: '', mono: 'font-mono', readout: 'readout' } as const

export function textInputClass({
  size = 'md',
  text = 'xs',
  font = 'body',
  surface = 'floor',
  invalid = false,
}: Pick<TextInputProps, 'size' | 'text' | 'font' | 'surface' | 'invalid'> = {}): string {
  return [
    'rounded-md border text-ink placeholder:text-ink-faint focus:outline-none',
    invalid ? 'border-danger' : 'border-line focus:border-line-strong',
    surface === 'raised' ? 'bg-surface-raised' : surface === 'side' ? 'bg-surface-side' : 'bg-surface-floor',
    PAD[size],
    text === 'sm' ? 'text-sm' : 'text-xs',
    FONT[font],
  ]
    .filter(Boolean)
    .join(' ')
}

/** The framed input alone, for a field whose label is laid out by its screen */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { size, text, font, surface, invalid = false, className = '', type = 'text', 'aria-invalid': ariaInvalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={`${textInputClass({ size, text, font, surface, invalid })} ${className}`.trim()}
      {...rest}
      aria-invalid={invalid || ariaInvalid || undefined}
    />
  )
})

/** The input under its label, an optional hint after a dot, and the problem below, tied by `aria-describedby` */
export const TextField = forwardRef<
  HTMLInputElement,
  TextInputProps & {
    label: ReactNode
    hint?: ReactNode
    /** Sets `aria-invalid`; the frame turns red only with `invalid`: a problem while typing is a hint, not an alarm */
    error?: ReactNode
    errorTestId?: string
    fieldClassName?: string
  }
>(function TextField({ label, hint, error, errorTestId, fieldClassName = '', className = '', ...input }, ref) {
  const errorId = useId()
  const hasError = error !== undefined && error !== null && error !== false
  return (
    <label className={`block ${fieldClassName}`.trim()}>
      <span className="mb-1 block text-2xs text-ink-muted">
        {label}
        {hint && <span className="text-ink-faint"> · {hint}</span>}
      </span>
      <TextInput
        ref={ref}
        className={`w-full ${className}`.trim()}
        aria-describedby={hasError ? errorId : undefined}
        aria-invalid={hasError || undefined}
        {...input}
      />
      {hasError && (
        <span id={errorId} className="mt-1 block text-xs leading-body text-ink-muted" data-testid={errorTestId}>
          {error}
        </span>
      )}
    </label>
  )
})
