import type { HTMLAttributes, MouseEventHandler, ReactNode } from 'react'

/**
 * The capsule: a short status in a rounded-full frame. It is a `<button>` when it does something (`onClick`), a
 * `<span>` when it only reports. Two sizes, both from the screens of #1160 (owner, 2026-10-18):
 *
 * - `bar`: 28px tall on a translucent hover fill, the top bar's shape (the update line beside the inbox count).
 * - `label`: a card's kind written in a capsule at its top left ("Awaiting approval", "Agent is asking"), no fill.
 *
 * The border is what it says, in the order of the brightness hierarchy (docs/design-system.md §1):
 *
 * - `quiet`: a hairline. Something to know, nothing to do (Updating…).
 * - `live`: a stronger line. It can be pressed and nothing is urgent (Update).
 * - `solid`: the signal ink. Something only the person can settle is waiting (an approval, a question).
 * - `dashed`: the signal ink, dashed. Something failed and waits on the person (Update failed).
 *
 * An edge that waits on the person is the signal ink at full strength (owner, 2026-10-18): not a fraction of it, and
 * not the plain ink, so it is the brightest line on screen exactly when something is waiting.
 *
 * `tone` sets the ink when the content's own state should speak louder than the edge (`signal` keeps the glow of a
 * waiting count, `bright` is the same white without it); otherwise each edge brings its own.
 */
export type PillEdge = 'quiet' | 'live' | 'solid' | 'dashed'
export type PillTone = 'signal' | 'bright' | 'ink' | 'muted' | 'faint'
export type PillSize = 'bar' | 'label'

const EDGE: Record<PillEdge, string> = {
  quiet: 'border-solid border-line',
  live: 'border-solid border-line-strong',
  solid: 'border-solid border-ink-signal',
  dashed: 'border-dashed border-ink-signal',
}

/** Each edge's own ink. A failure is written in the brightest ink, without the glow of something waiting */
const EDGE_TONE: Record<PillEdge, PillTone> = { quiet: 'muted', live: 'ink', solid: 'ink', dashed: 'bright' }

/** `signal` is the class the brightest ink wears with its glow (styles/index.css), which a waiting count keeps */
const TONE: Record<PillTone, string> = {
  signal: 'signal',
  bright: 'text-ink-signal [text-shadow:none]',
  ink: 'text-ink [text-shadow:none]',
  muted: 'text-ink-muted [text-shadow:none]',
  faint: 'text-ink-faint [text-shadow:none]',
}

const SIZE: Record<PillSize, string> = {
  bar: 'h-7 gap-1.5 px-2.5 text-xs leading-none',
  label: 'px-2 py-px text-2xs font-medium',
}

export function pillClass({
  edge = 'quiet',
  size = 'bar',
  tone,
  pressable = false,
}: { edge?: PillEdge; size?: PillSize; tone?: PillTone; pressable?: boolean } = {}): string {
  // The bar's translucent fill, except on a failure, which stands on the bar's own ground (the update line's)
  const fill = size === 'bar' && edge !== 'dashed' ? 'bg-surface-hover/30' : ''
  return [
    // A capsule never breaks its words: in a narrow card the text beside it wraps instead (owner, 2026-10-19)
    'flex shrink-0 items-center whitespace-nowrap rounded-full border transition-colors',
    SIZE[size],
    EDGE[edge],
    fill,
    TONE[tone ?? EDGE_TONE[edge]],
    pressable ? 'hover:bg-surface-hover/60' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

type Common = {
  edge?: PillEdge
  size?: PillSize
  tone?: PillTone
  children: ReactNode
  /** Placement only, as with Button */
  className?: string
}

export function Pill({
  edge = 'quiet',
  size = 'bar',
  tone,
  onClick,
  className = '',
  children,
  ...rest
}: Common & { onClick?: MouseEventHandler<HTMLButtonElement> } & Omit<HTMLAttributes<HTMLElement>, 'onClick' | 'className' | 'children'>) {
  const cls = `${pillClass({ edge, size, tone, pressable: !!onClick })} ${className}`.trim()
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} {...rest}>
        {children}
      </button>
    )
  }
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  )
}
