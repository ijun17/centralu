import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'

/**
 * A framed text input, and the label, hint and problem the forms put around it.
 *
 * 29 inputs wrote their frame by hand (`w-full rounded-md border border-line bg-surface-floor px-2 py-1.5 text-xs
 * text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none`, and four files kept a private copy
 * of it as `inputClass`, `field` or `fieldClass`). They differed only where the screen needed it, and those are the
 * props:
 *
 * - `size`: `md` for a dialog's fields, `sm` for a field inside a settings card or a row beside a button, `xs` for a
 *   field inside a line of text (the code viewer's find, a hex value).
 * - `text`: `xs` normally, `sm` for a name or a command that is the point of the dialog.
 * - `font`: `mono` for paths, branches and ids; `readout` for a command or a value among figures.
 * - `surface`: the fill is the floor, a step below the dialog it sits in; on a panel that is the floor already
 *   (the evidence panel, a run's log) it takes the raised surface so it still reads as a field, and `side` is the
 *   sidebar's ground, which an app's secret field keeps.
 * - `invalid`: the frame wears the danger colour and the input says `aria-invalid`.
 *
 * `className` is placement only (margin, width, flex), as with Button.
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

/**
 * The input under its label, as the dialogs lay a field out: the name in small muted ink with an optional hint after
 * a dot ("Branch · blank = centralu/<session id>"), and below the input the problem with what was typed, if any. The
 * problem is tied to the input (`aria-describedby`) so a screen reader reads it with the field.
 */
export const TextField = forwardRef<
  HTMLInputElement,
  TextInputProps & {
    label: ReactNode
    hint?: ReactNode
    /**
     * What is wrong with the value, said under the field. The input says `aria-invalid` while it is there; its frame
     * turns the danger colour only with `invalid`, since a problem shown while the person is still typing is a
     * hint, not an alarm.
     */
    error?: ReactNode
    errorTestId?: string
    /** The block's placement */
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
