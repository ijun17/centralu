import type { HTMLAttributes, MouseEventHandler, ReactNode } from 'react'

/**
 * The capsule (docs/design-system.md §11): a `<button>` with `onClick`, else a `<span>`. `line` is the one size whose
 * words wrap: a sentence in a pane that may be narrow would otherwise push the conversation wide.
 *
 * Edges by urgency (§1): `quiet` a hairline, nothing to do (Updating…); `live` pressable, nothing urgent (Update);
 * `solid` the signal ink, waiting on the person; `dashed` the signal ink, failed and waiting (Update failed). An edge
 * that waits is the signal at full strength, the brightest line on screen exactly then. `tone` overrides each edge's
 * ink when the content should speak louder (`signal` keeps a waiting count's glow, `bright` is the same white without).
 */
export type PillEdge = 'quiet' | 'live' | 'solid' | 'dashed'
export type PillTone = 'signal' | 'bright' | 'ink' | 'muted' | 'faint'
export type PillSize = 'bar' | 'label' | 'line'

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
  line: 'gap-1.5 px-2.5 py-0.5 text-2xs',
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
    // A capsule never breaks its words: the text beside it wraps instead. A line is the text, so it wraps
    'items-center rounded-full border transition-colors',
    size === 'line' ? 'inline-flex min-w-0 break-words' : 'flex shrink-0 whitespace-nowrap',
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
