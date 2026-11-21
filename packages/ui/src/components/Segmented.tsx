import { useRef, type KeyboardEvent, type ReactNode } from 'react'

/**
 * Pick one of several, shown at once (docs/design-system.md §11): a `radiogroup` named by `label`, with a radio
 * group's keyboard (WAI-ARIA): Tab enters on the picked option and leaves, the arrows move and pick, Home and End go to
 * the ends, a disabled option is skipped. `dim` can still be picked; the screen says below why it will not work yet
 * (a tool that needs a login). `layout="column"` is for options with a second line. `optionClassName` is an option's
 * inside layout, never its colours.
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

/** Where an arrow key lands from `from`: the next enabled option, wrapping; null when nothing moves */
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
  label: string
  value: T | null | undefined
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  layout?: 'row' | 'column'
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
