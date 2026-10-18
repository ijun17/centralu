import { useRef, type KeyboardEvent, type ReactNode } from 'react'

/**
 * Pick one of several, shown all at once: the tool a session starts with, the theme mode, the line height.
 *
 * Six screens had copied the same toggle (a row of framed buttons, the picked one lifted with `border-ink-muted
 * bg-surface-hover/40`), and they no longer agreed: some were a radio group to a screen reader, one said
 * `aria-pressed`, one said nothing; their hover brightened the border on one screen and the fill on another. One
 * component, one behaviour:
 *
 * - a `radiogroup` of `radio`s, named by `label`;
 * - the keyboard of a radio group (WAI-ARIA): Tab enters on the picked option and leaves the group, the arrows move
 *   to the next or previous option and pick it, Home and End to the first and last. A disabled option is skipped.
 *
 * An option can be `disabled` (it cannot be picked: the tool is busy switching) or `dim` (it can be picked, and the
 * screen explains below why it will not work yet: a tool that needs a login). `title` is the option's tooltip.
 *
 * `size="md"` is a dialog's (the size of its buttons), `sm` a form's inside a settings card.
 * `layout="column"` stacks the options at full width, for options that carry a second line (a machine's choices).
 * `optionClassName` is for an option's inside layout (a row of label and detail, `leading-none`), never its colours.
 */
export type SegmentedOption<T extends string> = {
  value: T
  label: ReactNode
  testId?: string
  title?: string
  disabled?: boolean
  dim?: boolean
}

const SIZE = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-sm' } as const

/**
 * Where an arrow key lands, from `from`: the next option that is not disabled in that direction, wrapping around
 * the ends as a radio group does. `null` for a key that does not move, or when nothing else can be picked.
 */
export function segmentedTarget(disabled: readonly boolean[], from: number, key: string): number | null {
  const n = disabled.length
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0
  if (key === 'Home' || key === 'End') {
    const order = [...Array(n).keys()]
    if (key === 'End') order.reverse()
    const hit = order.find((i) => !disabled[i])
    return hit === undefined || hit === from ? null : hit
  }
  if (step === 0) return null
  for (let k = 1; k < n; k++) {
    const i = (((from + step * k) % n) + n) % n
    if (!disabled[i]) return i
  }
  return null
}

/** Which option takes Tab: the picked one, or the first that can be picked when none is */
export function segmentedTabStop(values: readonly string[], disabled: readonly boolean[], value: string | null | undefined): number {
  const picked = values.indexOf(value ?? '')
  if (picked >= 0) return picked
  return Math.max(0, disabled.findIndex((d) => !d))
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  layout = 'row',
  className = '',
  optionClassName = '',
  testId,
}: {
  /** The group's name, as a screen reader announces it */
  label: string
  value: T | null | undefined
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  layout?: 'row' | 'column'
  /** The group's placement and gap */
  className?: string
  optionClassName?: string
  testId?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const disabled = options.map((o) => !!o.disabled)
  const tabStop = segmentedTabStop(
    options.map((o) => o.value),
    disabled,
    value,
  )
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const to = segmentedTarget(disabled, from, e.key)
    if (to === null) return
    // The page would scroll on an arrow, and a dialog's own arrow keys would move behind it
    e.preventDefault()
    e.stopPropagation()
    refs.current[to]?.focus()
    onChange(options[to]!.value)
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex ${layout === 'column' ? 'flex-col gap-1' : 'gap-1.5'} ${className}`}
      data-testid={testId}
    >
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            data-testid={o.testId}
            onClick={() => {
              if (!on) onChange(o.value)
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`rounded-md border transition-colors disabled:cursor-default ${SIZE[size]} ${
              layout === 'column' ? 'text-left' : ''
            } ${
              on
                ? 'border-ink-muted bg-surface-hover/40 text-ink'
                : 'border-line text-ink-muted enabled:hover:border-line-strong enabled:hover:text-ink disabled:opacity-50'
            } ${o.dim ? 'opacity-50' : ''} ${optionClassName}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
